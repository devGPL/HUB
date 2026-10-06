// Dry-run da limpeza: mostra como o HUB classifica as branches paradas. Não apaga nada.
// Uso: npm run cleanup-plan [repo]
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { collect } from '../public/js/github.js';
import { analyzeBranches } from '../public/js/cleanup.js';

const only = process.argv[2];
const config = JSON.parse(await readFile(new URL('../public/hub.config.json', import.meta.url), 'utf8'));
const token = process.env.GITHUB_TOKEN ?? execSync('gh auth token', { encoding: 'utf8' }).trim();
const data = await collect(token, config);

const LABEL = {
  merged: 'tudo na base',
  'pr-merged': 'PR mesclada',
  'other-base': 'PR mesclada em outra branch',
  'after-merge': 'commit depois do merge',
  'pr-closed': 'PR fechada sem merge',
  unmerged: 'commits fora da base, sem PR',
};

for (const repo of data.repos.filter((r) => !only || r.name === only)) {
  const list = await analyzeBranches(token, data.org, repo, config.cleanup);
  if (!list.length) continue;
  const safe = list.filter((b) => b.safe).length;
  console.log(`\n=== ${repo.label}  base=${repo.integrationBranch}  candidatas=${list.length}  seguras=${safe}`);
  for (const b of list) {
    const pr = b.pr ? ` PR #${b.pr.number}` : '';
    console.log(`  ${b.safe ? '[x]' : '[ ]'} ${b.name.padEnd(48)} ${LABEL[b.status]}${pr}${b.ahead ? ` (+${b.ahead})` : ''}`);
  }
}
