// Resumo no terminal usando a mesma coleta do site. Útil para conferir as regras de checagem.
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { collect } from '../public/js/github.js';

const config = JSON.parse(await readFile(new URL('../public/hub.config.json', import.meta.url), 'utf8'));
const token = process.env.GITHUB_TOKEN ?? execSync('gh auth token', { encoding: 'utf8' }).trim();
const data = await collect(token, config);

for (const r of data.repos) {
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.id);
  console.log(
    `[${r.grade}] ${r.label.padEnd(14)} PRs=${String(r.prCount).padEnd(3)} branches=${String(r.workBranchCount).padEnd(3)} ` +
      `paradas=${String(r.staleBranchCount).padEnd(3)} logo=${r.logo ? 'sim' : 'não'} faltando=[${failed.join(', ')}]`,
  );
}
if (data.missing.length) console.log('\nSem acesso:', data.missing);
console.log('\nRate limit restante:', data.rateLimit?.remaining);
