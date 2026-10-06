// Posta no #hub-manutencao o que foi feito pelo HUB (branches excluídas ou restauradas).
// Roda no workflow maintenance.yml, disparado pelo HUB via repository_dispatch.
//
// O conteúdo vem do navegador de quem usou o HUB, então tudo é validado antes de ir
// para o Discord: repositório da lista monitorada, nome de branch e SHA em formato estrito.
// Quem fez a ação vem do GitHub (github.actor), não do payload.
// O repositório é público e os logs também: nada do payload é impresso.
import { readFile } from 'node:fs/promises';

const KINDS = {
  'branches-deleted': { title: 'Branches excluídas', color: 0xff4f6d, verb: 'excluiu' },
  'branches-restored': { title: 'Branches restauradas', color: 0xb6ff3b, verb: 'restaurou' },
};
const BRANCH = /^[\w./-]{1,200}$/;
const SHA = /^[0-9a-f]{40}$/;
const LIMIT = 3800;

const webhook = process.env.DISCORD_MAINTENANCE_WEBHOOK_URL;
if (!webhook) throw new Error('Secret DISCORD_MAINTENANCE_WEBHOOK_URL não configurado no repositório do HUB.');

const config = JSON.parse(await readFile(new URL('../public/hub.config.json', import.meta.url), 'utf8'));
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const p = event.client_payload ?? {};

const kind = KINDS[p.kind];
const repo = config.repos.find((r) => r.name === p.repo);
const branches = Array.isArray(p.branches) ? p.branches.filter((b) => BRANCH.test(b?.name) && SHA.test(b?.sha)) : [];
if (!kind || !repo || !branches.length || branches.length > 200) throw new Error('Evento inválido; nada foi enviado.');

const actor = process.env.ACTOR;
const label = repo.label ?? repo.name;
const repoUrl = `https://github.com/${config.org}/${repo.name}`;
const lines = branches.map((b) => `\`${b.name}\` · [\`${b.sha.slice(0, 7)}\`](${repoUrl}/commit/${b.sha})`);

// Quebra em vários embeds se a lista passar do limite de texto do Discord.
const chunks = [[]];
let size = 0;
for (const line of lines) {
  if (size + line.length + 1 > LIMIT) {
    chunks.push([]);
    size = 0;
  }
  chunks.at(-1).push(line);
  size += line.length + 1;
}

const embeds = chunks.slice(0, 9).map((chunk, i) => ({
  ...(i === 0 ? { title: `${kind.title} em ${label}`, url: `${repoUrl}/branches`, author: { name: `${actor} ${kind.verb} ${branches.length} branch${branches.length > 1 ? 'es' : ''}` } } : {}),
  color: kind.color,
  description: chunk.join('\n'),
}));
if (p.kind === 'branches-deleted') {
  embeds.at(-1).footer = {
    text: 'Para restaurar: botão Desfazer no HUB, ou git push origin <commit>:refs/heads/<branch> com o commit desta lista.',
  };
}

const res = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'GPL HUB',
    avatar_url: new URL('avatar.png', config.digest?.hubUrl ?? 'https://devgpl.github.io/HUB/').toString(),
    allowed_mentions: { parse: [] },
    embeds,
  }),
});
if (!res.ok) throw new Error(`Discord recusou o aviso (HTTP ${res.status}).`);
console.log('Aviso de manutenção enviado.');
