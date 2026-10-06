// Edição cirúrgica do hub.config.json: adiciona ou remove uma linha da lista de repositórios
// sem reformatar o resto do arquivo, para a PR mostrar só o que mudou.

/** Uma entrada de repositório numa linha, no mesmo estilo do arquivo: { "name": "x", "logo": { ... } } */
export function compact(value) {
  if (Array.isArray(value)) return `[${value.map(compact).join(', ')}]`;
  if (value && typeof value === 'object') {
    const parts = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${compact(v)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  return JSON.stringify(value);
}

function reposBlock(text) {
  const start = text.indexOf('"repos": [');
  if (start < 0) throw new Error('Lista "repos" não encontrada no hub.config.json.');
  const open = text.indexOf('[', start);
  // A lista termina no primeiro "]" que fecha a linha, no mesmo nível de indentação de "repos".
  const close = text.indexOf('\n  ]', open);
  if (close < 0) throw new Error('Fim da lista "repos" não encontrado no hub.config.json.');
  return { open, close };
}

function check(text) {
  JSON.parse(text); // garante que o resultado continua sendo JSON válido
  return text;
}

export function addRepo(text, entry) {
  const config = JSON.parse(text);
  if (config.repos.some((r) => r.name === entry.name)) throw new Error(`${entry.name} já está no monitoramento.`);
  const { close } = reposBlock(text);
  const before = text.slice(0, close).replace(/\s+$/, '');
  const comma = before.endsWith('[') ? '' : ',';
  return check(`${before}${comma}\n    ${compact(entry)}${text.slice(close)}`);
}

export function removeRepo(text, name) {
  const { open, close } = reposBlock(text);
  const lines = text.slice(open + 1, close).split('\n');
  const idx = lines.findIndex((l) => l.includes(`"name": ${JSON.stringify(name)}`));
  if (idx < 0) throw new Error(`${name} não está no monitoramento.`);
  lines.splice(idx, 1);
  // Tira a vírgula que sobrou na última entrada.
  const body = lines.join('\n').replace(/,(\s*)$/, '$1');
  return check(text.slice(0, open + 1) + body + text.slice(close));
}
