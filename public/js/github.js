// Coleta de dados direto da API do GitHub. Sem DOM: roda no navegador e no Node (scripts/snapshot.mjs).

const API = 'https://api.github.com';
const PROTECTED = new Set(['main', 'master', 'dev', 'develop']);
const WORKFLOWS = `... on Tree { entries { name object { ... on Blob { text } } } }`;

export class AuthError extends Error {}

async function graphql(token, query) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (res.status === 401) throw new AuthError('Token inválido ou expirado.');
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
  return res.json();
}

export async function whoami(token) {
  const { data, errors } = await graphql(token, '{ viewer { login name avatarUrl } }');
  if (!data?.viewer) throw new AuthError(errors?.[0]?.message ?? 'Não foi possível validar o token.');
  return data.viewer;
}

function repoFragment(repo) {
  const logo = repo.logo?.path ? `logoBlob: object(expression: "HEAD:${repo.logo.path}") { oid }` : '';
  return `
    name url description isArchived pushedAt
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: 100) {
      totalCount
      nodes { name target { ... on Commit { committedDate author { name user { login } } } } }
    }
    pullRequests(states: OPEN, first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes {
        number title url isDraft createdAt updatedAt
        baseRefName headRefName reviewDecision mergeable
        author { login avatarUrl }
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    mainWorkflows: object(expression: "main:.github/workflows") { ${WORKFLOWS} }
    headWorkflows: object(expression: "HEAD:.github/workflows") { ${WORKFLOWS} }
    ${logo}
  `;
}

function mergeWorkflows(raw) {
  // Workflows de release e sync rodam a partir da main, mas a branch padrão pode ser dev ou develop:
  // junta os dois lados, priorizando a main quando o mesmo arquivo existe em ambos.
  const byName = new Map();
  for (const tree of [raw.headWorkflows, raw.mainWorkflows]) {
    for (const e of tree?.entries ?? []) {
      if (/\.ya?ml$/.test(e.name)) byName.set(e.name, e.object?.text ?? '');
    }
  }
  return [...byName].map(([name, text]) => ({ name, text }));
}

function runCheck(check, workflows) {
  const fileRe = check.match.fileName && new RegExp(check.match.fileName, 'i');
  const contentRe = check.match.content && new RegExp(check.match.content, 'i');
  const hits = workflows.filter((w) => (fileRe && fileRe.test(w.name)) || (contentRe && contentRe.test(w.text)));
  return { id: check.id, ok: hits.length > 0, files: hits.map((w) => w.name) };
}

// S: tudo, inclusive opcionais. A: todos os obrigatórios. B, C, D: 1, 2, 3+ obrigatórios faltando.
function grade(checks, defs) {
  const missingReq = defs.filter((d) => d.required && !checks.find((c) => c.id === d.id).ok).length;
  if (missingReq === 0) return checks.every((c) => c.ok) ? 'S' : 'A';
  return ['B', 'C'][missingReq - 1] ?? 'D';
}

const branchUrl = (repoUrl, name) => `${repoUrl}/tree/${name.split('/').map(encodeURIComponent).join('/')}`;

function shapeRepo(raw, entry, config) {
  const now = Date.now();
  const staleMs = config.staleBranchDays * 86_400_000;
  const prHeads = new Set(raw.pullRequests.nodes.map((p) => p.headRefName));

  const branches = raw.refs.nodes
    .map((b) => {
      const lastCommit = b.target?.committedDate ?? null;
      return {
        name: b.name,
        lastCommit,
        author: b.target?.author?.user?.login ?? b.target?.author?.name ?? null,
        protected: PROTECTED.has(b.name),
        stale: lastCommit ? now - Date.parse(lastCommit) > staleMs : false,
        hasOpenPr: prHeads.has(b.name),
        url: branchUrl(raw.url, b.name),
      };
    })
    .sort((a, b) => Date.parse(b.lastCommit ?? 0) - Date.parse(a.lastCommit ?? 0));

  const workflows = mergeWorkflows(raw);
  const checks = config.checks.map((c) => runCheck(c, workflows));
  const names = new Set(branches.map((b) => b.name));
  const work = branches.filter((b) => !b.protected);

  return {
    name: raw.name,
    label: entry.label ?? raw.name,
    url: raw.url,
    description: raw.description,
    pushedAt: raw.pushedAt,
    defaultBranch: raw.defaultBranchRef?.name ?? null,
    hasDevBranch: names.has('dev') || names.has('develop'),
    logo: entry.logo && raw.logoBlob ? { ...entry.logo, oid: raw.logoBlob.oid } : null,
    branchCount: raw.refs.totalCount,
    workBranchCount: work.length,
    staleBranchCount: work.filter((b) => b.stale).length,
    branches,
    prCount: raw.pullRequests.totalCount,
    pullRequests: raw.pullRequests.nodes.map((p) => ({
      repo: raw.name,
      number: p.number,
      title: p.title,
      url: p.url,
      draft: p.isDraft,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      base: p.baseRefName,
      head: p.headRefName,
      author: p.author?.login ?? 'ghost',
      avatar: p.author?.avatarUrl ?? null,
      review: p.reviewDecision,
      mergeable: p.mergeable,
      ci: p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      reviewers: p.reviewRequests.nodes.map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.name).filter(Boolean),
    })),
    workflows: workflows.map((w) => w.name),
    checks,
    grade: grade(checks, config.checks),
  };
}

export async function collect(token, config) {
  const fields = config.repos
    .map((r, i) => `r${i}: repository(owner: "${config.org}", name: "${r.name}") { ${repoFragment(r)} }`)
    .join('\n');
  const { data, errors } = await graphql(token, `{ ${fields} rateLimit { remaining resetAt } }`);

  const repos = [];
  const missing = [];
  config.repos.forEach((entry, i) => {
    const raw = data?.[`r${i}`];
    if (raw) repos.push(shapeRepo(raw, entry, config));
    else missing.push({ name: entry.name, error: errors?.find((e) => e.path?.[0] === `r${i}`)?.message ?? 'Sem acesso ou não encontrado' });
  });

  return {
    generatedAt: new Date().toISOString(),
    org: config.org,
    staleBranchDays: config.staleBranchDays,
    checks: config.checks.map(({ id, label, description, required }) => ({ id, label, description, required })),
    repos,
    missing,
    rateLimit: data?.rateLimit ?? null,
  };
}

export async function fetchRaw(token, org, repo, path) {
  const res = await fetch(`${API}/repos/${org}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `bearer ${token}`, Accept: 'application/vnd.github.raw' },
  });
  if (!res.ok) throw new Error(`Falha ao baixar ${repo}/${path}: ${res.status}`);
  return res.blob();
}
