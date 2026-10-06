// Limpeza de branches paradas: decide quais podem sair, com que grau de segurança, e executa.
// Sem DOM: a interface só mostra o resultado da análise e chama deleteMany/restoreMany.
import { commitsAhead, deleteBranch, dispatchEvent, lastPrByBranch, restoreBranch } from './github.js';

const ALWAYS_KEEP = new Set(['main', 'master', 'dev', 'develop']);

/** Branches paradas que podem entrar na limpeza (sem PR aberta e fora das protegidas). */
export function cleanupCandidates(repo, rules) {
  const keep = new RegExp(rules?.keep ?? '^release-please--|^gh-pages$', 'i');
  return repo.branches.filter(
    (b) => b.stale && !b.hasOpenPr && b.sha && !ALWAYS_KEEP.has(b.name) && b.name !== repo.defaultBranch && !keep.test(b.name),
  );
}

/**
 * Classifica cada candidata:
 *  - merged:        tudo o que tem na branch já está na base;
 *  - pr-merged:     PR mesclada e nada commitado depois do merge (caso de squash merge);
 *  - other-base:    PR mesclada em outra branch que não a dev/main (o código pode não ter chegado);
 *  - after-merge:   PR mesclada, mas com commit depois do merge;
 *  - pr-closed:     PR fechada sem merge;
 *  - unmerged:      commits fora da base e sem PR.
 * `safe` diz se a branch vem selecionada por padrão.
 */
export async function analyzeBranches(token, org, repo, rules) {
  const base = repo.integrationBranch;
  const candidates = cleanupCandidates(repo, rules);
  const prs = await lastPrByBranch(token, org, repo.name, candidates.map((b) => b.name));

  const analyzed = [];
  // Em lotes, para não abrir dezenas de requisições de uma vez.
  for (let i = 0; i < candidates.length; i += 6) {
    const batch = candidates.slice(i, i + 6);
    analyzed.push(
      ...(await Promise.all(
        batch.map(async (b) => {
          const pr = prs.get(b.name);
          const ahead = await commitsAhead(token, org, repo.name, base, b.name).catch(() => null);
          let status;
          if (ahead === 0) status = 'merged';
          else if (pr?.state === 'MERGED' && ![base, 'main'].includes(pr.baseRefName)) status = 'other-base';
          else if (pr?.state === 'MERGED') status = Date.parse(b.lastCommit) > Date.parse(pr.mergedAt) ? 'after-merge' : 'pr-merged';
          else if (pr?.state === 'CLOSED') status = 'pr-closed';
          else status = 'unmerged';
          return { ...b, base, ahead, pr, status, safe: status === 'merged' || status === 'pr-merged' };
        }),
      )),
    );
  }
  const order = { merged: 0, 'pr-merged': 1, 'other-base': 2, 'after-merge': 3, 'pr-closed': 4, unmerged: 5 };
  return analyzed.sort((a, b) => order[a.status] - order[b.status] || Date.parse(a.lastCommit) - Date.parse(b.lastCommit));
}

/** Exclui uma a uma e devolve o resultado de cada branch. */
export async function deleteMany(token, org, repoName, branches) {
  const results = [];
  for (const b of branches) {
    try {
      await deleteBranch(token, org, repoName, b.name);
      results.push({ name: b.name, sha: b.sha, ok: true });
    } catch (err) {
      results.push({ name: b.name, sha: b.sha, ok: false, error: err.message, status: err.status });
    }
  }
  return results;
}

export async function restoreMany(token, org, repoName, branches) {
  const results = [];
  for (const b of branches) {
    try {
      await restoreBranch(token, org, repoName, b.name, b.sha);
      results.push({ name: b.name, sha: b.sha, ok: true });
    } catch (err) {
      results.push({ name: b.name, sha: b.sha, ok: false, error: err.message, status: err.status });
    }
  }
  return results;
}

/** Avisa o #hub-manutencao pelo workflow do repositório do HUB. Nunca derruba a limpeza se falhar. */
export async function notifyMaintenance(token, data, payload) {
  try {
    await dispatchEvent(token, data.org, data.hubRepo, 'hub-maintenance', payload);
    return true;
  } catch {
    return false;
  }
}
