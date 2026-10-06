// Avisa o #hub-manutencao quando a lista de repositórios monitorados muda na main.
// Compara o hub.config.json do commit anterior (BEFORE) com o atual.
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const webhook = process.env.DISCORD_MAINTENANCE_WEBHOOK_URL;
if (!webhook) throw new Error('Secret DISCORD_MAINTENANCE_WEBHOOK_URL não configurado no repositório do HUB.');

const PATH = 'public/hub.config.json';
const before = process.env.BEFORE;
const now = JSON.parse(await readFile(new URL(`../${PATH}`, import.meta.url), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(before ?? '')) {
  console.log('Commit anterior inválido; nada a comparar.');
  process.exit(0);
}
let old;
try {
  old = JSON.parse(execSync(`git show ${before}:${PATH}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
} catch {
  console.log('Sem versão anterior para comparar.');
  process.exit(0);
}

const names = (c) => new Map(c.repos.map((r) => [r.name, r.label ?? r.name]));
const was = names(old);
const is = names(now);
const added = [...is].filter(([n]) => !was.has(n));
const removed = [...was].filter(([n]) => !is.has(n));
if (!added.length && !removed.length) {
  console.log('Lista de repositórios sem mudança.');
  process.exit(0);
}

const hub = now.digest?.hubUrl ?? 'https://devgpl.github.io/HUB/';
const repoLink = ([n, label]) => `[${label}](https://github.com/${now.org}/${n})`;
const embeds = [];
if (added.length) {
  embeds.push({
    title: added.length > 1 ? 'Repositórios entraram no HUB' : 'Repositório entrou no HUB',
    url: hub,
    color: 0xb6ff3b,
    description: [
      added.map(repoLink).join(', '),
      '',
      '**Falta configurar**',
      '- Incluir no token `HUB_READ_TOKEN` do resumo diário',
      '- Para notificar PRs no canal: secret `DISCORD_WEBHOOK_URL` e variável `DISCORD_PO_USER_ID` no repositório',
      '- Abrir no HUB e usar **Corrigir** nos padrões que faltarem',
    ].join('\n'),
  });
}
if (removed.length) {
  embeds.push({
    title: removed.length > 1 ? 'Repositórios saíram do HUB' : 'Repositório saiu do HUB',
    color: 0xff4f6d,
    description: `${removed.map(repoLink).join(', ')}\nO repositório não foi alterado; só deixa de aparecer no painel e no resumo.`,
  });
}

const res = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'GPL HUB',
    avatar_url: new URL('avatar.png', hub).toString(),
    allowed_mentions: { parse: [] },
    embeds,
  }),
});
if (!res.ok) throw new Error(`Discord recusou o aviso (HTTP ${res.status}).`);
console.log('Aviso de mudança no monitoramento enviado.');
