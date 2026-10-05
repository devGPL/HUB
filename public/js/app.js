import { AuthError, collect, whoami } from './github.js';
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

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
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

function checkChips(repo) {
  return state.data.checks
    .map((def) => {
      const ok = repo.checks.find((c) => c.id === def.id).ok;
      const cls = ok ? 'ok' : def.required ? 'bad' : 'off';
      const icon = ok ? icons.check() : def.required ? icons.cross() : icons.dash();
      return `<span class="ck ${cls}" title="${esc(def.description)}">${icon}${esc(def.label)}</span>`;
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

  const head = `<thead><tr><th>Repositório</th><th>Nota</th>${checks
    .map((c) => `<th class="${c.required ? '' : 'opt'}" title="${esc(c.description)}">${esc(c.label)}</th>`)
    .join('')}<th>Branch dev</th></tr></thead>`;

  const body = repos
    .map(
      (r) => `<tr data-repo="${esc(r.name)}">
        <td><span class="repo-cell">${avatar(r, 'sm')}${esc(r.label)}</span></td>
        <td>${grade(r.grade)}</td>
        ${checks.map((c) => `<td title="${esc(r.checks.find((x) => x.id === c.id).files.join(', '))}">${cell(r.checks.find((x) => x.id === c.id).ok, c.required)}</td>`).join('')}
        <td>${r.hasDevBranch ? cell(true) : '<span class="badge warn">Sem dev</span>'}</td>
      </tr>`,
    )
    .join('');

  $('matrix').innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderDrawer() {
  const r = state.openRepo && findRepo(state.openRepo);
  if (!r) return;
  const wf = `${r.url}/tree/${encodeURIComponent(r.defaultBranch ?? 'main')}/.github/workflows`;

  const checks = state.data.checks
    .map((def) => {
      const res = r.checks.find((c) => c.id === def.id);
      const cls = res.ok ? 'ok' : def.required ? 'bad' : 'off';
      const icon = res.ok ? icons.check() : def.required ? icons.cross() : icons.dash();
      const detail = res.ok ? res.files.map((f) => `<code>${esc(f)}</code>`).join(' ') : esc(def.description);
      return `<div class="check-row cut ${def.required ? '' : 'opt'}"><span class="cell ${cls}">${icon}</span><div><b>${esc(def.label)}</b><span>${detail}</span></div></div>`;
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
      <section class="d-section"><h3>Padrões <span class="count">${requiredDefs().length - missingRequired(r).length}/${requiredDefs().length}</span></h3><div class="check-list">${checks}</div></section>
      <section class="d-section"><h3>Pull requests <span class="count">${r.prCount || ''}</span></h3>
        <div class="panel">${r.pullRequests.length ? r.pullRequests.map((p) => prRow(p, false)).join('') : '<div class="empty">Nenhuma PR aberta.</div>'}</div>
      </section>
      <section class="d-section"><h3>Branches de trabalho <span class="count">${work.length || ''}</span></h3>
        <div class="branch-tools">${bchip('all', `Todas ${work.length}`)}${bchip('stale', `Paradas ${r.staleBranchCount}`)}${bchip('pr', 'Com PR')}</div>
        ${branches}
      </section>
    </div>`;
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
  const bf = e.target.closest('[data-bfilter]');
  if (bf) {
    state.branchFilter = bf.dataset.bfilter;
    renderDrawer();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
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
