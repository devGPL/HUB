// Envia o resumo diário do HUB para o Discord.
//
//   node scripts/digest.mjs           coleta e envia para DISCORD_DIGEST_WEBHOOK_URL
//   node scripts/digest.mjs --print   só imprime o payload (uso local, nunca no Actions)
//
// O repositório do HUB é público e os logs do Actions também. Por isso o envio não imprime
// nada dos repositórios: só quantas seções foram enviadas.
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { collect } from '../public/js/github.js';
import { buildDigest } from '../public/js/digest.js';
import { collectFailures } from '../public/js/failures.js';

const print = process.argv.includes('--print');

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.CI) throw new Error('Secret HUB_READ_TOKEN não configurado no repositório do HUB.');
  return execSync('gh auth token', { encoding: 'utf8' }).trim();
}

const config = JSON.parse(await readFile(new URL('../public/hub.config.json', import.meta.url), 'utf8'));
const data = await collect(token(), config);

if (data.missing.length) {
  // Só a quantidade: o nome dos repositórios não vai para o log público.
  console.warn(`Aviso: ${data.missing.length} repositório(s) sem acesso com este token.`);
}

data.failures = await collectFailures(token(), data);
const payload = buildDigest(data);

if (print) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const webhook = process.env.DISCORD_DIGEST_WEBHOOK_URL;
if (!webhook) throw new Error('Secret DISCORD_DIGEST_WEBHOOK_URL não configurado no repositório do HUB.');

const res = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
if (!res.ok) throw new Error(`Discord recusou o resumo (HTTP ${res.status}).`);
console.log(`Resumo enviado: ${payload.embeds.length} seção(ões).`);
