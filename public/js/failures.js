// Falhas que importam para o resumo: o que impede o merge e o que pode dar problema depois.
// As regras ficam em hub.config.json (digest.failures) e casam com o nome do workflow do Actions.
import { failedWorkflowRuns } from './github.js';

const DEFAULTS = { ignore: 'vercel|discord', block: '^ci$|lint|test|typecheck|build|pr title|commitlint' };

export function classifier(rules = {}) {
  const ignore = new RegExp(rules.ignore ?? DEFAULTS.ignore, 'i');
  const block = new RegExp(rules.block ?? DEFAULTS.block, 'i');
  return (workflow) => (ignore.test(workflow) ? 'ignore' : block.test(workflow) ? 'block' : 'risk');
}

/**
 * Para cada repo, olha a última execução de cada workflow:
 *  - nas PRs abertas (não draft): só o que bloqueia o merge, mais conflito;
 *  - na branch de integração (dev/develop): o que bloqueia (toda PR nova herda) e os riscos;
 *  - na main: só os riscos (release, sync, monitoramento, rotinas).
 */
export async function collectFailures(token, data) {
  const classify = classifier(data.digest?.failures);
  const blocking = [];
  const risks = [];
  const blockedPrs = new Set();

  await Promise.all(
    data.repos.map(async (repo) => {
      const integration = repo.integrationBranch;
      const heads = new Map(repo.branchHealth.map((b) => [b.branch, b.sha]));
      const branches = [...new Set(['main', integration])].filter((b) => heads.has(b));

      for (const branch of branches) {
        // Sem filtro de evento: entram push, agendamentos e disparos manuais do commit atual.
        const runs = await failedWorkflowRuns(token, data.org, repo.name, branch, heads.get(branch)).catch(() => []);
        for (const run of runs) {
          const kind = classify(run.workflow);
          if (kind === 'ignore') continue;
          const item = { repo: repo.name, branch, ...run };
          if (kind === 'block' && branch === integration) blocking.push(item);
          else risks.push(item);
        }
      }

      const prs = repo.pullRequests.filter((p) => !p.draft);
      await Promise.all(
        prs.map(async (pr) => {
          if (pr.mergeable === 'CONFLICTING') {
            blocking.push({ repo: repo.name, pr, workflow: 'conflito de merge', url: pr.url });
            blockedPrs.add(pr.url);
          }
          const runs = await failedWorkflowRuns(token, data.org, repo.name, pr.head, pr.headSha, 'pull_request').catch(() => []);
          for (const run of runs.filter((r) => classify(r.workflow) === 'block')) {
            blocking.push({ repo: repo.name, pr, ...run });
            blockedPrs.add(pr.url);
          }
        }),
      );
    }),
  );

  const byRepo = (a, b) => a.repo.localeCompare(b.repo);
  return { blocking: blocking.sort(byRepo), risks: risks.sort(byRepo), blockedPrs };
}
