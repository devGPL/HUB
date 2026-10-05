import { AuthError, collect, findOpenPr, openFixPr, whoami } from './github.js';
import { buildPlan, COMBINED_BRANCH, planBody } from './fixes.js';
import { logoUrl } from './logos.js';
import { icons } from './icons.js';

const AUTO_REFRESH_MS = 5 * 60 * 1000;
const TOKEN_KEY = 'hub.token';
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

const state = {
  token: null,
  user: null,
  config: null,
  data: null,
  view: 'repos',
  filter: 'all',
  search: '',
  logos: new Map(),
  openRepo: null,
  branchFilter: 'all',
  loading: false,
  fix: null,
};

const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ext = (href, label, cls = '') =>
  `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;

function sized(url, s) {
  const u = new URL(url);
  u.searchParams.set('s', s);
  return u.toString();
}

const days = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : 0);

function ago(iso) {
  if (!iso) return 'sem data';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'há 1 dia' : `há ${d} dias`;
}

function storage(action, value) {
  try {
    if (action === 'get') return localStorage.getItem(TOKEN_KEY);
    if (action === 'set') localStorage.setItem(TOKEN_KEY, value);
    if (action === 'del') localStorage.removeItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function toast(msg, kind = 'error') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 6000);
}

/* ---------- Helpers de dados ---------- */

const requiredDefs = () => state.data.checks.filter((c) => c.required);
const missingRequired = (repo) => repo.checks.filter((c) => !c.ok && requiredDefs().some((d) => d.id === c.id));
const allPrs = () =>
  state.data.repos.flatMap((r) => r.pullRequests).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
const findRepo = (name) => state.data.repos.find((r) => r.name === name);

// Matizes fixos para as iniciais: ciano, lima, âmbar, rosa, verde-água, azul.
const HUES = [190, 85, 35, 345, 160, 215];

function hue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

/* ---------- Componentes ---------- */

function avatar(repo, size = '') {
  const url = state.logos.get(repo.name);
  const attrs = `data-avatar="${esc(repo.name)}" data-size="${size}"`;
  if (url) {
    return `<span class="avatar ${size} tile-${repo.logo.tile ?? 'dark'}" ${attrs}><img src="${url}" alt="${esc(repo.label)}" /></span>`;
  }
  return `<span class="avatar ${size} letter" style="--h:${hue(repo.name)}" ${attrs}><span>${esc(repo.label.charAt(0).toUpperCase())}</span></span>`;
}

const grade = (g, size = '') => `<span class="grade ${size}" data-grade="${g}" title="Nota ${g}">${g}</span>`;

function hpBar(repo) {
  const req = requiredDefs();
  const ok = req.filter((d) => repo.checks.find((c) => c.id === d.id).ok).length;
  const segs = req.map((_, i) => `<i class="${i < ok ? 'on' : ''}" style="animation-delay:${i * 60}ms"></i>`).join('');
  return `<div class="hp"><div class="hp-head"><span>Conformidade</span><b>${ok}/${req.length}</b></div><div class="hp-bar">${segs}</div></div>`;
}

// Estado visual de um check: ok, desatualizado, faltando (obrigatório) ou ausente (opcional).
function checkState(def, res) {
  if (res.ok && res.outdated) return { cls: 'warn', icon: icons.alert(), hint: 'Fora do modelo atual do HUB' };
  if (res.ok && res.inTransit) return { cls: 'ok transit', icon: icons.check(), hint: 'Já está na dev; chega na main com a próxima release' };
  if (res.ok) return { cls: 'ok', icon: icons.check(), hint: def.description };
  if (def.required) return { cls: 'bad', icon: icons.cross(), hint: def.description };
  return { cls: 'off', icon: icons.dash(), hint: `${def.description} (opcional)` };
}

// PR de correção já aberta para este check: a específica dele ou a combinada do repo.
const fixPrFor = (repo, def) =>
  def.fix && repo.pullRequests.find((p) => p.head === def.fix.branch || p.head === COMBINED_BRANCH);

// Checks com correção automática que estão faltando ou desatualizados e ainda sem PR aberta.
function pendingFixes(repo) {
  return state.data.checks.filter((def) => {
    const res = repo.checks.find((c) => c.id === def.id);
    return def.fix && !res.keepOwn && (!res.ok || res.outdated) && !fixPrFor(repo, def);
  });
}

function checkChips(repo) {
  return state.data.checks
    .map((def) => {
      const s = checkState(def, repo.checks.find((c) => c.id === def.id));
      return `<span class="ck ${s.cls}" title="${esc(s.hint)}">${s.icon}${esc(def.label)}</span>`;
    })
    .join('');
}

function prBadges(pr) {
  const out = [];
  if (pr.draft) out.push('<span class="badge mute">Draft</span>');
  if (pr.review === 'APPROVED') out.push('<span class="badge ok">Aprovada</span>');
  else if (pr.review === 'CHANGES_REQUESTED') out.push('<span class="badge bad">Ajustes pedidos</span>');
  else if (!pr.draft) out.push('<span class="badge warn">Aguardando review</span>');
  if (pr.ci === 'SUCCESS') out.push('<span class="badge ok">CI ok</span>');
  else if (pr.ci === 'FAILURE' || pr.ci === 'ERROR') out.push('<span class="badge bad">CI falhou</span>');
  else if (pr.ci === 'PENDING' || pr.ci === 'EXPECTED') out.push('<span class="badge info">CI rodando</span>');
  if (pr.mergeable === 'CONFLICTING') out.push('<span class="badge bad">Conflito</span>');
  return out.join('');
}

function prRow(pr, withRepo) {
  const d = days(pr.createdAt);
  const ageCls = d > 14 ? 'ancient' : d > 5 ? 'old' : '';
  const repo = findRepo(pr.repo);
  return `<div class="pr">
    ${withRepo ? avatar(repo, 'sm') : ''}
    <div class="pr-main">
      <div class="pr-title"><span class="num">#${pr.number}</span>${ext(pr.url, esc(pr.title))}</div>
      <div class="pr-meta">
        ${withRepo ? `<b>${esc(repo.label)}</b>` : ''}
        <span>${pr.avatar ? `<img src="${esc(sized(pr.avatar, 32))}" alt="" />` : ''}${esc(pr.author)}</span>
        <span class="flow"><span class="h">${esc(pr.head)}</span>${icons.play()}<span class="b">${esc(pr.base)}</span></span>
        <span class="age ${ageCls}">aberta ${ago(pr.createdAt)}</span>
        ${pr.reviewers.length ? `<span>revisores: ${esc(pr.reviewers.join(', '))}</span>` : ''}
      </div>
    </div>
    <div class="badges">${prBadges(pr)}</div>
  </div>`;
}

/* ---------- Renderização ---------- */

function renderStats() {
  const { repos } = state.data;
  const prs = allPrs();
  const work = repos.reduce((n, r) => n + r.workBranchCount, 0);
  const stale = repos.reduce((n, r) => n + r.staleBranchCount, 0);
  const compliant = repos.filter((r) => missingRequired(r).length === 0).length;
  const oldPrs = prs.filter((p) => days(p.createdAt) > 5).length;

  const stat = (k, icon, v, f, color, meter) => `<div class="stat cut" style="--stat-color:${color}">
      <div class="k">${icon}${k}</div>
      <div class="v">${v}</div>
      <div class="f">${f}</div>
      ${meter != null ? `<div class="meter"><i style="width:${Math.round(meter * 100)}%"></i></div>` : ''}
    </div>`;

  $('stats').innerHTML = [
    stat('Repositórios', icons.repo(), repos.length, `monitorados em ${esc(state.data.org)}`, 'var(--cyan)'),
    stat('PRs abertas', icons.pr(), prs.length, oldPrs ? `${oldPrs} aberta${oldPrs > 1 ? 's' : ''} há mais de 5 dias` : 'nenhuma esquecida', 'var(--acc)'),
    stat('Branches ativas', icons.branch(), work, 'fora de main, dev e develop', 'var(--cyan)'),
    stat('Branches paradas', icons.clock(), stale, `sem commit há mais de ${state.data.staleBranchDays} dias`, 'var(--warn)', work ? stale / work : 0),
    stat('No padrão', icons.shield(), `${compliant}<small>/${repos.length}</small>`, 'todos os checks obrigatórios', 'var(--acc)', repos.length ? compliant / repos.length : 0),
  ].join('');

  $('tab-prs').textContent = prs.length || '';
}

function renderCards() {
  const q = state.search.trim().toLowerCase();
  const order = { D: 0, C: 1, B: 2, A: 3, S: 4 };
  const list = state.data.repos
    .filter((r) => {
      if (q && !`${r.name} ${r.label}`.toLowerCase().includes(q)) return false;
      if (state.filter === 'prs') return r.prCount > 0;
      if (state.filter === 'noncompliant') return missingRequired(r).length > 0;
      if (state.filter === 'stale') return r.staleBranchCount > 0;
      return true;
    })
    .sort((a, b) => b.prCount - a.prCount || order[a.grade] - order[b.grade] || a.label.localeCompare(b.label));

  const cards = list.map(
    (r, i) => `<button class="card cut" type="button" data-repo="${esc(r.name)}" data-grade="${r.grade}" style="--i:${i}">
      <div class="card-top">
        ${avatar(r)}
        <div class="card-title">
          <h3>${esc(r.label)}</h3>
          <p>${esc(r.defaultBranch ?? '')} · push ${ago(r.pushedAt)}</p>
        </div>
        ${grade(r.grade)}
      </div>
      ${hpBar(r)}
      <div class="card-stats">
        <div class="${r.prCount ? 'hot' : ''}"><b>${r.prCount}</b><span>${icons.pr()}PRs</span></div>
        <div><b>${r.workBranchCount}</b><span>${icons.branch()}Branches</span></div>
        <div class="${r.staleBranchCount ? 'warn' : ''}"><b>${r.staleBranchCount}</b><span>${icons.clock()}Paradas</span></div>
      </div>
      <div class="checks">${checkChips(r)}</div>
    </button>`,
  );

  const missing = state.data.missing.map(
    (m) => `<div class="card cut" data-grade="D"><div class="empty"><b>${esc(m.name)}</b>${esc(m.error)}</div></div>`,
  );

  $('cards').innerHTML =
    cards.length || missing.length
      ? cards.join('') + missing.join('')
      : '<div class="empty"><b>Nada por aqui</b>Nenhum repositório neste filtro.</div>';
}

function renderPrs() {
  const prs = allPrs();
  $('prs').innerHTML = `<div class="panel-head"><h2>Fila de pull requests</h2><p class="hint">Mais antigas primeiro. Amarelo: mais de 5 dias. Vermelho: mais de 14.</p></div>${
    prs.length ? prs.map((p) => prRow(p, true)).join('') : '<div class="empty"><b>Fila limpa</b>Nenhuma PR aberta nos repositórios monitorados.</div>'
  }`;
}

function renderMatrix() {
  const { checks, repos } = state.data;
  const cell = (ok, required) =>
    ok
      ? `<span class="cell ok">${icons.check()}</span>`
      : `<span class="cell ${required ? 'bad' : 'off'}">${required ? icons.cross() : icons.dash()}</span>`;
  const checkCell = (def, res) => {
    const s = checkState(def, res);
    return `<span class="cell ${s.cls}" title="${esc(res.files.join(', ') || s.hint)}">${s.icon}</span>`;
  };

  const head = `<thead><tr><th>Repositório</th><th>Nota</th>${checks
    .map((c) => `<th class="${c.required ? '' : 'opt'}" title="${esc(c.description)}">${esc(c.label)}</th>`)
    .join('')}<th>Branch dev</th></tr></thead>`;

  const body = repos
    .map(
      (r) => `<tr data-repo="${esc(r.name)}">
        <td><span class="repo-cell">${avatar(r, 'sm')}${esc(r.label)}</span></td>
        <td>${grade(r.grade)}</td>
        ${checks.map((c) => `<td>${checkCell(c, r.checks.find((x) => x.id === c.id))}</td>`).join('')}
        <td>${r.hasDevBranch ? cell(true) : '<span class="badge warn">Sem dev</span>'}</td>
      </tr>`,
    )
    .join('');

  $('matrix').innerHTML = head + `<tbody>${body}</tbody>`;

  const withPending = repos.filter((r) => pendingFixes(r).length);
  const fixes = withPending.reduce((n, r) => n + pendingFixes(r).length, 0);
  $('fix-bulk').innerHTML = withPending.length
    ? `<button class="btn primary" type="button" data-fix-bulk>${icons.wrench()}Corrigir ${fixes} pendência${fixes > 1 ? 's' : ''} em ${withPending.length} repo${withPending.length > 1 ? 's' : ''}</button>`
    : '<span class="badge ok">Sem pendências com correção automática</span>';
}

function renderDrawer() {
  const r = state.openRepo && findRepo(state.openRepo);
  if (!r) return;
  const wf = `${r.url}/tree/${encodeURIComponent(r.defaultBranch ?? 'main')}/.github/workflows`;
  const pending = pendingFixes(r);

  const checks = state.data.checks
    .map((def) => {
      const res = r.checks.find((c) => c.id === def.id);
      const s = checkState(def, res);
      const files = res.files.map((f) => `<code>${esc(f)}</code>`).join(' ');
      let detail = res.ok ? files : esc(def.description);
      if (res.outdated) detail = `${files}<br>Fora do modelo atual do HUB.`;
      else if (res.inTransit) detail = `${files}<br>Já está na dev. Chega na main com a próxima release.`;

      let action = '';
      const openPr = fixPrFor(r, def);
      if (res.keepOwn) action = `<span class="badge info" title="${esc(r.note ?? '')}">Canal próprio</span>`;
      else if (openPr) action = ext(openPr.url, `PR #${openPr.number}`, 'badge ok');
      else if (def.fix && (!res.ok || res.outdated)) {
        action = `<button class="btn mini" type="button" data-fix="${esc(def.id)}">${icons.wrench()}${res.ok ? 'Atualizar' : 'Corrigir'}</button>`;
      }

      return `<div class="check-row cut ${def.required ? '' : 'opt'}">
        <span class="cell ${s.cls}">${s.icon}</span>
        <div><b>${esc(def.label)}</b><span>${detail}</span></div>
        ${action ? `<div class="check-action">${action}</div>` : ''}
      </div>`;
    })
    .join('');

  const work = r.branches.filter((b) => !b.protected);
  const shown = state.branchFilter === 'stale' ? work.filter((b) => b.stale) : state.branchFilter === 'pr' ? work.filter((b) => b.hasOpenPr) : work;
  const branches = shown.length
    ? `<div class="branch-list">${shown
        .map(
          (b) => `<div class="branch-item">
            ${ext(b.url, esc(b.name))}
            <span class="who">${esc(b.author ?? '')}</span>
            <span class="when">${b.hasOpenPr ? '<span class="badge ok">PR</span>' : ''}${b.stale ? '<span class="badge warn">Parada</span>' : ''}${ago(b.lastCommit)}</span>
          </div>`,
        )
        .join('')}</div>`
    : '<div class="empty">Nenhuma branch neste filtro.</div>';

  const bchip = (id, label) => `<button class="chip ${state.branchFilter === id ? 'active' : ''}" data-bfilter="${id}" type="button">${label}</button>`;

  $('drawer-panel').innerHTML = `
    <div class="d-head" data-grade="${r.grade}">
      ${avatar(r, 'lg')}
      <div><h2>${esc(r.label)}</h2><p>${esc(r.description ?? 'Sem descrição')}</p></div>
      ${grade(r.grade, 'lg')}
      <button class="icon-btn" data-close type="button" aria-label="Fechar">${icons.close()}</button>
    </div>
    <div class="d-links">
      ${ext(r.url, `${icons.repo()}Repositório`, 'btn primary')}
      ${ext(`${r.url}/pulls`, `${icons.pr()}PRs`, 'btn')}
      ${ext(`${r.url}/branches`, `${icons.branch()}Branches`, 'btn')}
      ${ext(`${r.url}/actions`, `${icons.play()}Actions`, 'btn')}
      ${ext(wf, `${icons.sliders()}Workflows`, 'btn')}
    </div>
    <div class="d-body">
      <section class="d-section"><h3>Padrões <span class="count">${requiredDefs().length - missingRequired(r).length}/${requiredDefs().length}</span></h3>
        ${pending.length > 1 ? `<div class="fix-all"><span>${pending.length} pendências com correção automática</span><button class="btn mini primary" type="button" data-fix-repo>${icons.wrench()}Corrigir tudo numa PR</button></div>` : ''}
        <div class="check-list">${checks}</div>
      </section>
      <section class="d-section"><h3>Pull requests <span class="count">${r.prCount || ''}</span></h3>
        <div class="panel">${r.pullRequests.length ? r.pullRequests.map((p) => prRow(p, false)).join('') : '<div class="empty">Nenhuma PR aberta.</div>'}</div>
      </section>
      <section class="d-section"><h3>Branches de trabalho <span class="count">${work.length || ''}</span></h3>
        <div class="branch-tools">${bchip('all', `Todas ${work.length}`)}${bchip('stale', `Paradas ${r.staleBranchCount}`)}${bchip('pr', 'Com PR')}</div>
        ${branches}
      </section>
    </div>`;
}

/* ---------- Correção via PR ---------- */
// Um "job" é um repositório com um ou mais checks a corrigir; cada job vira uma PR.

const JOB_STATUS = {
  planning: 'Montando',
  ready: 'Pronto',
  busy: 'Abrindo PR',
  done: 'PR aberta',
  error: 'Erro',
  blocked: 'Sem permissão',
  empty: 'Nada a fazer',
};

function jobFor(repoName, defIds) {
  return { repo: repoName, defIds, status: 'planning', plan: null, pr: null, error: null };
}

async function planJob(job) {
  const r = findRepo(job.repo);
  const defs = job.defIds.map((id) => state.data.checks.find((c) => c.id === id));
  try {
    job.plan = await buildPlan(state.token, state.data.org, r, defs);
    if (!r.canWrite) job.status = 'blocked';
    else job.status = job.plan.files.length ? 'ready' : 'empty';
  } catch (err) {
    Object.assign(job, { status: 'error', error: esc(err.message) });
  }
}

function openFix(jobs) {
  state.fix = { jobs, running: false };
  $('fix').classList.add('open');
  renderFix();
  Promise.all(jobs.map(planJob)).then(renderFix);
}

function closeFix() {
  if (state.fix?.running) return;
  state.fix = null;
  $('fix').classList.remove('open');
}

function explain(err) {
  if (err.status === 403 || err.status === 404) {
    return 'O GitHub recusou a escrita. O token precisa de permissão de escrita em <code>Contents</code>, <code>Pull requests</code> e <code>Workflows</code> (ou, se for classic, os escopos <code>repo</code> e <code>workflow</code>).';
  }
  if (err.status === 422) return `O GitHub recusou a PR: ${esc(err.message)}. Pode já existir uma PR igual aberta.`;
  return esc(err.message);
}

async function runFix() {
  const fix = state.fix;
  fix.running = true;
  // Uma PR por vez: evita estourar o limite de criação de conteúdo da API.
  for (const job of fix.jobs.filter((j) => j.status === 'ready' || j.status === 'error')) {
    if (!job.plan?.files.length) continue;
    job.status = 'busy';
    renderFix();
    const { plan } = job;
    try {
      job.pr =
        (await findOpenPr(state.token, state.data.org, plan.repo.name, plan.branch)) ??
        (await openFixPr(state.token, {
          org: state.data.org,
          repo: plan.repo.name,
          base: plan.base,
          branch: plan.branch,
          files: plan.files,
          deletePaths: plan.remove,
          title: plan.title,
          body: planBody(plan),
        }));
      job.status = 'done';
    } catch (err) {
      Object.assign(job, { status: 'error', error: explain(err) });
    }
  }
  fix.running = false;
  const done = fix.jobs.filter((j) => j.status === 'done').length;
  if (done) {
    toast(`${done} PR${done > 1 ? 's' : ''} de correção aberta${done > 1 ? 's' : ''}`, 'ok');
    refresh();
  }
  if (state.fix === fix) renderFix();
}

function partDetail(part) {
  if (!part.ok) return `<div class="alert bad">${icons.alert()}<div><b>${esc(part.def.label)}: não dá para gerar</b>${esc(part.error)}</div></div>`;
  const files = part.files
    .map((f) => `<details class="yaml"><summary><span>Adiciona</span><code>${esc(f.path)}</code></summary><pre>${esc(f.content)}</pre></details>`)
    .join('');
  const removes = part.remove.map((p) => `<div class="file-row"><span>Remove</span><code>${esc(p)}</code></div>`).join('');
  const notes = [...part.notes, ...(part.def.fix.setup ? [part.def.fix.setup] : [])]
    .map((n) => `<li>${esc(n).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`)
    .join('');
  return `<section class="part">
    <h4>${esc(part.def.label)}</h4>
    ${files}${removes}
    ${notes ? `<ul class="notes">${notes}</ul>` : ''}
  </section>`;
}

function jobStatus(job) {
  const cls = { done: 'ok', error: 'bad', blocked: 'bad', busy: 'info', planning: 'mute', ready: 'info', empty: 'mute' }[job.status];
  if (job.status === 'done') return ext(job.pr.html_url, `PR #${job.pr.number}`, `badge ${cls}`);
  return `<span class="badge ${cls}">${JOB_STATUS[job.status]}</span>`;
}

function renderFix() {
  const fix = state.fix;
  if (!fix) return;
  const { jobs } = fix;
  const single = jobs.length === 1 ? jobs[0] : null;
  const runnable = jobs.filter((j) => j.status === 'ready' || (j.status === 'error' && j.plan?.files.length)).length;
  const planning = jobs.some((j) => j.status === 'planning');
  const finished = !fix.running && jobs.some((j) => j.status === 'done');

  let head;
  let body;
  if (single) {
    const r = findRepo(single.repo);
    const labels = single.defIds.map((id) => state.data.checks.find((c) => c.id === id).label);
    const update = single.defIds.length === 1 && r.checks.find((c) => c.id === single.defIds[0]).ok;
    head = `${avatar(r, 'sm')}<div><span class="eyebrow">${update ? 'Atualizar padrão' : 'Corrigir padrão'}</span><h2>${esc(labels.join(', '))} em ${esc(r.label)}</h2></div>`;

    const alerts = [];
    if (single.status === 'blocked') {
      alerts.push(`<div class="alert bad">${icons.alert()}<div><b>Sem permissão de escrita</b>Seu acesso neste repositório é <code>${esc(r.permission ?? 'nenhum')}</code>. Peça acesso de escrita ou peça para alguém do projeto abrir a correção pelo HUB.</div></div>`);
    }
    if (single.status === 'error') alerts.push(`<div class="alert bad">${icons.alert()}<div><b>Não deu certo</b>${single.error}</div></div>`);
    if (single.status === 'done') {
      alerts.push(`<div class="alert ok">${icons.check()}<div><b>PR aberta</b>A PR #${single.pr.number} foi criada em <code>${esc(single.plan.base)}</code>. Quando for mergeada, o padrão fica verde aqui.</div></div>`);
    }

    const plan = single.plan;
    body = planning
      ? '<div class="empty"><b>Montando a correção</b>Lendo o repositório para gerar os arquivos.</div>'
      : `<p class="lead">O HUB abre uma pull request com um único commit. Nada vai direto para a branch, o merge continua sendo do time.</p>
        ${plan ? `<dl class="plan">
          <dt>Base</dt><dd><code>${esc(plan.base)}</code></dd>
          <dt>Branch</dt><dd><code>${esc(plan.branch)}</code></dd>
          <dt>Título</dt><dd>${esc(plan.title)}</dd>
        </dl>` : ''}
        ${alerts.join('')}
        ${plan ? plan.parts.map(partDetail).join('') : ''}`;
  } else {
    head = `<span class="avatar sm letter" style="--h:85"><span>${jobs.length}</span></span><div><span class="eyebrow">Corrigir pendências</span><h2>${jobs.length} repositórios</h2></div>`;
    body = `<p class="lead">Uma PR por repositório, com todas as pendências dele num commit só. Repositórios em que você não tem escrita ficam de fora.</p>
      <div class="job-list">${jobs
        .map((job) => {
          const r = findRepo(job.repo);
          const failed = job.plan?.parts.filter((p) => !p.ok) ?? [];
          const labels = job.defIds.map((id) => {
            const def = state.data.checks.find((c) => c.id === id);
            const bad = failed.some((p) => p.def.id === id);
            return `<span class="ck ${bad ? 'bad' : 'off'}" title="${bad ? esc(failed.find((p) => p.def.id === id).error) : ''}">${esc(def.label)}</span>`;
          });
          return `<div class="job">
            ${avatar(r, 'sm')}
            <div class="job-main"><b>${esc(r.label)}</b><div class="checks">${labels.join('')}</div>${job.error ? `<p class="job-error">${job.error}</p>` : ''}</div>
            ${jobStatus(job)}
          </div>`;
        })
        .join('')}</div>`;
  }

  const go = runnable
    ? `<button class="btn primary" type="button" id="fix-go" ${fix.running || planning ? 'disabled' : ''}>${fix.running ? `${icons.refresh()}Abrindo` : `${icons.pr()}${single ? 'Abrir PR' : `Abrir ${runnable} PR${runnable > 1 ? 's' : ''}`}`}</button>`
    : single?.status === 'done'
      ? ext(single.pr.html_url, `${icons.external()}Ver PR #${single.pr.number}`, 'btn primary')
      : '';

  $('fix-panel').innerHTML = `
    <div class="m-head">${head}<button class="icon-btn" type="button" data-fix-close aria-label="Fechar">${icons.close()}</button></div>
    <div class="m-body">${body}</div>
    <div class="m-foot"><button class="btn ghost" type="button" data-fix-close ${fix.running ? 'disabled' : ''}>${finished ? 'Fechar' : 'Cancelar'}</button>${go}</div>`;
}

function render() {
  if (!state.data) return;
  renderStats();
  renderCards();
  renderPrs();
  renderMatrix();
  renderDrawer();
}

function renderMeta() {
  const dot = $('sync-dot');
  dot.className = `dot ${state.loading ? 'busy' : ''}`;
  $('meta').textContent = state.loading
    ? 'Sincronizando'
    : state.data
      ? `Sync ${ago(state.data.generatedAt)} · API ${state.data.rateLimit?.remaining ?? '?'}`
      : 'Sem dados';
  $('scan').classList.toggle('on', state.loading);
  const btn = $('refresh');
  btn.disabled = state.loading;
  btn.classList.toggle('loading', state.loading);
}

/* ---------- Fluxo ---------- */

// Troca só os avatares já renderizados, sem refazer a tela (e sem repetir a animação de entrada).
function swapAvatars(repo) {
  document.querySelectorAll(`[data-avatar="${CSS.escape(repo.name)}"]`).forEach((el) => {
    el.outerHTML = avatar(repo, el.dataset.size);
  });
}

async function loadLogos() {
  const pending = state.data.repos.filter((r) => r.logo && !state.logos.has(r.name));
  await Promise.all(
    pending.map(async (r) => {
      try {
        const url = await logoUrl(state.token, state.data.org, r);
        if (!url) return;
        state.logos.set(r.name, url);
        swapAvatars(r);
      } catch (err) {
        console.warn(`Logo de ${r.name}:`, err.message);
      }
    }),
  );
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  renderMeta();
  try {
    state.data = await collect(state.token, state.config);
    render();
    // A animação de entrada é só para a primeira carga; os refreshes seguintes atualizam em silêncio.
    requestAnimationFrame(() => setTimeout(() => document.body.classList.add('settled'), 900));
    loadLogos();
  } catch (err) {
    if (err instanceof AuthError) return logout(err.message);
    $('sync-dot').className = 'dot error';
    toast(`Falha ao sincronizar: ${err.message}`);
  } finally {
    state.loading = false;
    renderMeta();
  }
}

function showGate(message) {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gate-error').hidden = !message;
  $('gate-error').textContent = message ?? '';
  $('gate-token').focus();
}

async function enter(token) {
  state.user = await whoami(token);
  state.token = token;
  $('gate').hidden = true;
  $('app').hidden = false;
  $('user').innerHTML = `<img src="${esc(sized(state.user.avatarUrl, 64))}" alt="" />
    <div class="who"><b>${esc(state.user.name ?? state.user.login)}</b><span>@${esc(state.user.login)}</span></div>
    <button class="icon-btn" id="logout" type="button" title="Sair e apagar o token deste navegador">${icons.logout()}</button>`;
  $('logout').addEventListener('click', () => logout());
  await refresh();
}

function logout(message) {
  storage('del');
  state.token = null;
  state.data = null;
  closeDrawer();
  showGate(message);
}

function openDrawer(name) {
  state.openRepo = name;
  state.branchFilter = 'all';
  renderDrawer();
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawer-panel').scrollTop = 0;
}

function closeDrawer() {
  state.openRepo = null;
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  for (const v of ['repos', 'prs', 'standards']) $(`view-${v}`).hidden = v !== view;
}

/* ---------- Eventos ---------- */

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('gate-token').value.trim();
  const btn = $('gate-submit');
  btn.disabled = true;
  btn.textContent = 'Validando';
  try {
    await enter(token);
    storage('set', token);
    $('gate-token').value = '';
  } catch (err) {
    showGate(err instanceof AuthError ? 'Token recusado pelo GitHub. Confira se ele não expirou e se tem acesso à devGPL.' : err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Conectar';
  }
});

$('refresh').addEventListener('click', refresh);
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-view]');
  if (tab) setView(tab.dataset.view);
});
$('filters').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  document.querySelectorAll('#filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderCards();
});
$('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderCards();
});
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-repo]');
  if (target && !e.target.closest('a')) openDrawer(target.dataset.repo);
  if (e.target.closest('[data-close]')) closeDrawer();
  const fixBtn = e.target.closest('[data-fix]');
  if (fixBtn) openFix([jobFor(state.openRepo, [fixBtn.dataset.fix])]);
  if (e.target.closest('[data-fix-repo]')) {
    openFix([jobFor(state.openRepo, pendingFixes(findRepo(state.openRepo)).map((d) => d.id))]);
  }
  if (e.target.closest('[data-fix-bulk]')) {
    const jobs = state.data.repos
      .filter((r) => pendingFixes(r).length)
      .map((r) => jobFor(r.name, pendingFixes(r).map((d) => d.id)));
    openFix(jobs);
  }
  if (e.target.closest('[data-fix-close]') || e.target.matches('.fix-backdrop')) closeFix();
  if (e.target.closest('#fix-go')) runFix();
  const bf = e.target.closest('[data-bfilter]');
  if (bf) {
    state.branchFilter = bf.dataset.bfilter;
    renderDrawer();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.fix) closeFix();
  else closeDrawer();
});

/* ---------- Boot ---------- */

async function devToken() {
  // Só no localhost: o servidor de desenvolvimento repassa o token do `gh` para não precisar colar.
  if (!IS_LOCAL) return null;
  try {
    const res = await fetch('dev-token');
    return res.ok ? (await res.text()).trim() || null : null;
  } catch {
    return null;
  }
}

async function boot() {
  $('refresh').innerHTML = `${icons.refresh()}Atualizar`;
  $('search-icon').outerHTML = icons.search();
  state.config = await (await fetch('hub.config.json', { cache: 'no-store' })).json();
  $('org-link').href = `https://github.com/${state.config.org}`;
  $('org-link').innerHTML = `${state.config.org}${icons.external()}`;

  setInterval(() => state.token && refresh(), AUTO_REFRESH_MS);
  setInterval(() => !state.loading && state.data && renderMeta(), 30_000);

  const token = storage('get') || (await devToken());
  if (!token) return showGate();
  try {
    await enter(token);
  } catch (err) {
    logout(err instanceof AuthError ? 'Sessão expirada. Conecte de novo.' : err.message);
  }
}

boot();
