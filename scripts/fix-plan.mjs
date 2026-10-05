// Dry-run das correções: mostra, para cada repo, o que o botão Corrigir faria. Não escreve nada no GitHub.
// Uso: npm run fix-plan [repo] [--show]   (--show imprime o conteúdo dos arquivos gerados)
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collect } from '../public/js/github.js';

// O fetch do Node não lê file://; os modelos ficam em disco.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('file:')) {
    const text = await readFile(fileURLToPath(url), 'utf8').catch(() => null);
    return new Response(text, { status: text == null ? 404 : 200 });
  }
  return nativeFetch(url, opts);
};

const { buildPlan } = await import('../public/js/fixes.js');

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--'));
const show = args.includes('--show');

const config = JSON.parse(await readFile(new URL('../public/hub.config.json', import.meta.url), 'utf8'));
const token = process.env.GITHUB_TOKEN ?? execSync('gh auth token', { encoding: 'utf8' }).trim();
const data = await collect(token, config);

for (const repo of data.repos.filter((r) => !only || r.name === only)) {
  const defs = data.checks.filter((def) => {
    const res = repo.checks.find((c) => c.id === def.id);
    return def.fix && !res.keepOwn && (!res.ok || res.outdated);
  });
  if (!defs.length) continue;

  const plan = await buildPlan(token, data.org, repo, defs);
  console.log(`\n=== ${repo.label}  base=${plan.base}  branch=${plan.branch}  escrita=${repo.canWrite ? 'sim' : 'não'}`);
  for (const part of plan.parts) {
    if (!part.ok) {
      console.log(`  [${part.def.label}] ERRO: ${part.error}`);
      continue;
    }
    console.log(`  [${part.def.label}] +${part.files.map((f) => f.path).join(' +')}${part.remove.length ? ` -${part.remove.join(' -')}` : ''}`);
    part.notes.forEach((n) => console.log(`      ${n}`));
    if (show) part.files.forEach((f) => console.log(`\n--- ${f.path}\n${f.content}`));
  }
}
