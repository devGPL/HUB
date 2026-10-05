// Monta o resumo diário do HUB no formato de mensagem do Discord (embeds).
// Sem DOM e sem rede: recebe os dados já coletados e devolve o payload do webhook.

const COLORS = {
  header: 0xb6ff3b,
  prs: 0xffb547,
  ci: 0xff4f6d,
  branches: 0x38e1ff,
  standards: 0xffd84a,
};

const DAY = 86_400_000;
const FAILING = new Set(['FAILURE', 'ERROR']);
const EMBED_LIMIT = 3800; // o Discord aceita 4096 na descrição; sobra margem para o "e mais N"

// Escapa o que o Discord interpretaria como markdown dentro de títulos de PR e nomes de branch.
const md = (s) => String(s ?? '').replace(/([\\*_~`|[\]>])/g, '\\$1');
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const age = (iso, now) => Math.floor((now - Date.parse(iso)) / DAY);

function list(lines, max) {
  const out = [];
  let size = 0;
  for (const line of lines.slice(0, max)) {
    if (size + line.length + 1 > EMBED_LIMIT) break;
    out.push(line);
    size += line.length + 1;
  }
  const rest = lines.length - out.length;
  if (rest > 0) out.push(`e mais ${rest}`);
  return out.join('\n');
}

function prStatus(pr) {
  if (pr.mergeable === 'CONFLICTING') return 'conflito';
  if (FAILING.has(pr.ci)) return 'CI falhou';
  if (pr.review === 'CHANGES_REQUESTED') return 'ajustes pedidos';
  if (pr.review === 'APPROVED') return 'aprovada, falta merge';
  return 'aguardando review';
}

/** Junta os números e as listas que o resumo usa. Útil também para testes e para uma prévia no HUB. */
export function digestData(data, now = Date.now()) {
  const cfg = { stalePrDays: 3, maxItems: 12, ...(data.digest ?? {}) };
  const label = new Map(data.repos.map((r) => [r.name, r.label]));
  const required = data.checks.filter((c) => c.required);

  const openPrs = data.repos.flatMap((r) => r.pullRequests).filter((p) => !p.draft);
  const stalePrs = openPrs
    .filter((p) => age(p.createdAt, now) >= cfg.stalePrDays)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const brokenBranches = data.repos.flatMap((r) =>
    r.branchHealth.filter((b) => FAILING.has(b.state)).map((b) => ({ repo: r.name, ...b })),
  );
  const brokenPrs = openPrs.filter((p) => FAILING.has(p.ci));

  const staleBranches = data.repos
    .filter((r) => r.staleBranchCount > 0)
    .map((r) => ({ repo: r.name, count: r.staleBranchCount }))
    .sort((a, b) => b.count - a.count);

  const offStandard = data.repos
    .map((r) => ({
      repo: r.name,
      missing: required.filter((d) => !r.checks.find((c) => c.id === d.id).ok).map((d) => d.label),
      fixPr: r.pullRequests.find((p) => p.head.startsWith('chore/hub-')),
    }))
    .filter((x) => x.missing.length);

  return { cfg, label, openPrs, stalePrs, brokenBranches, brokenPrs, staleBranches, offStandard, repoCount: data.repos.length };
}

/** Payload pronto para o webhook do Discord. */
export function buildDigest(data, now = Date.now()) {
  const d = digestData(data, now);
  const name = (repo) => `**${md(d.label.get(repo) ?? repo)}**`;
  const hub = d.cfg.hubUrl;

  const date = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
  }).format(now);

  const ciCount = d.brokenBranches.length + d.brokenPrs.length;
  const staleTotal = d.staleBranches.reduce((n, b) => n + b.count, 0);
  const allClear = !d.stalePrs.length && !ciCount && !d.offStandard.length;

  const embeds = [
    {
      title: 'Resumo diário do HUB',
      url: hub,
      color: COLORS.header,
      description: allClear
        ? `${date} · ${plural(d.repoCount, 'repositório', 'repositórios')}\nNenhuma PR esperando, nenhuma falha e todos os projetos no padrão.`
        : `${date} · ${plural(d.repoCount, 'repositório', 'repositórios')}`,
      fields: [
        { name: 'PRs abertas', value: String(d.openPrs.length), inline: true },
        { name: `Esperando ${d.cfg.stalePrDays}+ dias`, value: String(d.stalePrs.length), inline: true },
        { name: 'Falhas', value: String(ciCount), inline: true },
        { name: 'Branches paradas', value: String(staleTotal), inline: true },
        { name: 'Fora do padrão', value: String(d.offStandard.length), inline: true },
      ],
    },
  ];

  if (d.stalePrs.length) {
    embeds.push({
      title: `PRs esperando há ${d.cfg.stalePrDays} dias ou mais`,
      color: COLORS.prs,
      description: list(
        d.stalePrs.map(
          (p) => `${name(p.repo)} [#${p.number} ${md(p.title)}](${p.url}) · ${plural(age(p.createdAt, now), 'dia', 'dias')} · ${prStatus(p)}`,
        ),
        d.cfg.maxItems,
      ),
    });
  }

  if (ciCount) {
    embeds.push({
      title: 'Falhas nas branches principais e PRs',
      color: COLORS.ci,
      description: list(
        [
          ...d.brokenBranches.map(
            (b) => `${name(b.repo)} \`${b.branch}\` · ${md(b.failed.join(', ') || 'checks')} falhou · [ver commit](${b.url})`,
          ),
          ...d.brokenPrs.map((p) => `${name(p.repo)} [#${p.number} ${md(p.title)}](${p.url}) · CI falhou`),
        ],
        d.cfg.maxItems,
      ),
    });
  }

  if (d.offStandard.length) {
    embeds.push({
      title: 'Fora do padrão',
      color: COLORS.standards,
      description: list(
        d.offStandard.map(
          (x) => `${name(x.repo)} falta ${x.missing.join(', ')}${x.fixPr ? ` · [correção na PR #${x.fixPr.number}](${x.fixPr.url})` : ''}`,
        ),
        d.cfg.maxItems,
      ),
    });
  }

  if (d.staleBranches.length) {
    embeds.push({
      title: `Branches sem commit há ${data.staleBranchDays}+ dias`,
      url: hub,
      color: COLORS.branches,
      description: `${d.staleBranches.map((b) => `${name(b.repo)} ${b.count}`).join(' · ')}\nDá para revisar e limpar pelo HUB.`,
    });
  }

  return { username: 'GPL HUB', allowed_mentions: { parse: [] }, embeds };
}
