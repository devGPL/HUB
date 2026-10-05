// Coleta de dados direto da API do GitHub. Sem DOM: roda no navegador e no Node (scripts/snapshot.mjs).

const API = 'https://api.github.com';
const PROTECTED = new Set(['main', 'master', 'dev', 'develop']);
const WORKFLOWS = `... on Tree { entries { name object { ... on Blob { text } } } }`;
const BRANCH_STATUS = `name target { ... on Commit { url statusCheckRollup { state contexts(first: 30) { nodes {
  ... on CheckRun { name conclusion checkSuite { workflowRun { workflow { name } } } }
  ... on StatusContext { context state }
} } } } }`;
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE']);

// Nome legível de cada check que falhou: o workflow do Actions ou o contexto de status (ex.: Vercel).
function failedChecks(rollup) {
  const names = (rollup?.contexts.nodes ?? [])
    .filter((c) => FAILED.has(c.conclusion ?? c.state))
    .map((c) => c.checkSuite?.workflowRun?.workflow.name ?? c.name ?? c.context);
  return [...new Set(names)];
}

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const WRITE_ROLES = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

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
    name url description isArchived pushedAt viewerPermission
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
    mainRef: ref(qualifiedName: "refs/heads/main") { ${BRANCH_STATUS} }
    devRef: ref(qualifiedName: "refs/heads/dev") { ${BRANCH_STATUS} }
    developRef: ref(qualifiedName: "refs/heads/develop") { ${BRANCH_STATUS} }
    devWorkflows: object(expression: "dev:.github/workflows") { ${WORKFLOWS} }
    developWorkflows: object(expression: "develop:.github/workflows") { ${WORKFLOWS} }
    ${logo}
  `;
}

function mergeWorkflows(raw) {
  // Junta os workflows da branch de integração (dev/develop), da branch padrão e da main.
  // As correções do HUB entram pela dev, então um workflow pode existir só lá até a próxima release.
  // Quando o mesmo arquivo existe em mais de um lugar, vale o conteúdo da main.
  const byName = new Map();
  const sources = [
    [raw.devWorkflows, 'dev'],
    [raw.developWorkflows, 'dev'],
    [raw.headWorkflows, 'main'],
    [raw.mainWorkflows, 'main'],
  ];
  for (const [tree, source] of sources) {
    for (const e of tree?.entries ?? []) {
      if (!/\.ya?ml$/.test(e.name)) continue;
      const prev = byName.get(e.name);
      byName.set(e.name, { name: e.name, text: e.object?.text ?? '', inMain: Boolean(prev?.inMain) || source === 'main' });
    }
  }
  return [...byName.values()];
}

function runCheck(check, workflows, entry) {
  const fileRe = check.match.fileName && new RegExp(check.match.fileName, 'i');
  const contentRe = check.match.content && new RegExp(check.match.content, 'i');
  const hits = workflows.filter((w) => (fileRe && fileRe.test(w.name)) || (contentRe && contentRe.test(w.text)));
  const ok = hits.length > 0;
  const fix = check.fix;
  const keepOwn = entry.keepOwn?.includes(check.id) ?? false;
  // Desatualizado: tem o workflow, mas não o modelo atual do HUB (identificado pelo marcador no arquivo).
  const outdated = Boolean(ok && fix?.marker && !keepOwn && !hits.some((w) => w.text.includes(fix.marker)));
  // Arquivos antigos que a correção substitui: só os que casam com `replaces` pelo nome, nunca outro workflow que só cita o termo.
  const fixFile = fix?.path.split('/').pop();
  const replaces = fix?.replaces
    ? hits.filter((w) => new RegExp(fix.replaces, 'i').test(w.name) && w.name !== fixFile).map((w) => w.name)
    : [];
  // Já está na dev, mas ainda não chegou na main nem na branch padrão: chega com a próxima release.
  const inTransit = ok && !hits.some((w) => w.inMain);
  return { id: check.id, ok, outdated, inTransit, keepOwn, files: hits.map((w) => w.name), replaces };
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
  const checks = config.checks.map((c) => runCheck(c, workflows, entry));
  const names = new Set(branches.map((b) => b.name));
  const work = branches.filter((b) => !b.protected);
  const integration = ['dev', 'develop'].find((b) => names.has(b)) ?? raw.defaultBranchRef?.name ?? 'main';

  return {
    name: raw.name,
    label: entry.label ?? raw.name,
    url: raw.url,
    description: raw.description,
    pushedAt: raw.pushedAt,
    defaultBranch: raw.defaultBranchRef?.name ?? null,
    integrationBranch: integration,
    hasDevBranch: names.has('dev') || names.has('develop'),
    // Status de CI na ponta das branches principais (null quando nenhum check roda nelas).
    branchHealth: [raw.mainRef, raw.devRef, raw.developRef]
      .filter((ref) => ref?.target)
      .map((ref) => ({
        branch: ref.name,
        state: ref.target.statusCheckRollup?.state ?? null,
        failed: failedChecks(ref.target.statusCheckRollup),
        url: ref.target.url,
      })),
    permission: raw.viewerPermission,
    canWrite: WRITE_ROLES.has(raw.viewerPermission),
    note: entry.note ?? null,
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
    digest: config.digest ?? null,
    checks: config.checks.map(({ id, label, description, required, fix }) => ({ id, label, description, required, fix: fix ?? null })),
    repos,
    missing,
    rateLimit: data?.rateLimit ?? null,
  };
}

async function rest(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.message ?? `GitHub respondeu ${res.status}`, res.status);
  return data;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Conteúdo de um arquivo de texto numa ref, ou null se não existir. */
export async function getText(token, org, repo, path, ref) {
  const res = await fetch(`${API}/repos/${org}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, {
    headers: { Authorization: `bearer ${token}`, Accept: 'application/vnd.github.raw' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(`Falha ao ler ${path}: ${res.status}`, res.status);
  return res.text();
}

export async function refSha(token, org, repo, branch) {
  const ref = await rest(token, 'GET', `/repos/${org}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  return ref.object.sha;
}

export async function findOpenPr(token, org, repo, branch) {
  const prs = await rest(token, 'GET', `/repos/${org}/${repo}/pulls?state=open&head=${org}:${encodeURIComponent(branch)}`);
  return prs[0] ?? null;
}

/**
 * Abre uma PR com um único commit que grava `files` e remove `deletePaths`.
 * Se a branch já existir sem PR aberta, ela é recriada a partir da base.
 */
export async function openFixPr(token, { org, repo, base, branch, files, deletePaths = [], title, body }) {
  const r = `/repos/${org}/${repo}`;
  const baseCommit = await rest(token, 'GET', `${r}/git/commits/${await refSha(token, org, repo, base)}`);

  // Só remove o que de fato existe na base (o arquivo antigo pode estar só na main).
  const existing = await Promise.all(
    deletePaths.map((p) =>
      rest(token, 'GET', `${r}/contents/${encodePath(p)}?ref=${encodeURIComponent(base)}`)
        .then(() => p)
        .catch((err) => (err.status === 404 ? null : Promise.reject(err))),
    ),
  );

  const tree = await rest(token, 'POST', `${r}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: [
      ...files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      ...existing.filter(Boolean).map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
    ],
  });
  const commit = await rest(token, 'POST', `${r}/git/commits`, {
    message: title,
    tree: tree.sha,
    parents: [baseCommit.sha],
  });

  try {
    await rest(token, 'POST', `${r}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  } catch (err) {
    if (err.status !== 422) throw err;
    await rest(token, 'PATCH', `${r}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: true });
  }

  return rest(token, 'POST', `${r}/pulls`, { title, head: branch, base, body });
}

export async function fetchRaw(token, org, repo, path) {
  const res = await fetch(`${API}/repos/${org}/${repo}/contents/${encodePath(path)}`, {
    headers: { Authorization: `bearer ${token}`, Accept: 'application/vnd.github.raw' },
  });
  if (!res.ok) throw new Error(`Falha ao baixar ${repo}/${path}: ${res.status}`);
  return res.blob();
}
