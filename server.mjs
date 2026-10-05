// Servidor de desenvolvimento: serve a pasta public/ como o GitHub Pages serviria.
// Extra só local: /dev-token repassa o token do `gh` para não precisar colar um na tela de acesso.
import http from 'node:http';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('./public', import.meta.url));
const PORT = Number(process.env.PORT ?? 4321);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};

function devToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const headers = { 'Cache-Control': 'no-store' };

  if (url.pathname === '/dev-token') {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' });
    return res.end(devToken());
  }

  const path = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!path.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  const file = await readFile(path).catch(() => null);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { ...headers, 'Content-Type': `${MIME[extname(path)] ?? 'application/octet-stream'}; charset=utf-8` });
  res.end(file);
});

server.listen(PORT, HOST, () => console.log(`GPL HUB em http://localhost:${PORT}`));
