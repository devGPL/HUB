// Logos vêm de repos privados, então são baixadas com o token, recortadas no símbolo da marca,
// reduzidas e guardadas no localStorage por oid do blob (só baixa de novo quando o arquivo muda).
import { fetchRaw } from './github.js';

const SIZE = 128;
const PREFIX = 'hub.logo.';

function readCache(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Sem espaço ou storage bloqueado: segue sem cache.
  }
}

async function decode(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function render(img, crop) {
  const [sx, sy, sw, sh] = crop ?? [0, 0, img.naturalWidth, img.naturalHeight];
  const scale = Math.min(SIZE / sw, SIZE / sh);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  return canvas.toDataURL('image/png');
}

/**
 * Recorte automático: tira as margens (transparentes ou da cor do fundo) e sugere o fundo do ícone.
 * A análise roda numa cópia reduzida e o recorte volta em pixels da imagem original.
 */
function autoTrim(img) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const k = Math.min(1, 600 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k));
  const h = Math.max(1, Math.round(H * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  const at = (x, y) => px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4);
  const corner = at(0, 0);
  const bgOpaque = corner[3] > 200;
  const isBg = (p) => p[3] < 16 || (bgOpaque && Math.abs(p[0] - corner[0]) + Math.abs(p[1] - corner[1]) + Math.abs(p[2] - corner[2]) < 45);

  let x0 = w, y0 = h, x1 = -1, y1 = -1, lum = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = at(x, y);
      if (isBg(p)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      lum += 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
      n++;
    }
  }
  if (x1 < 0) return { crop: null, tile: 'dark' };

  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
  const cx = Math.max(0, Math.round((x0 - pad) / k));
  const cy = Math.max(0, Math.round((y0 - pad) / k));
  const crop = [
    cx,
    cy,
    Math.min(W - cx, Math.round((x1 + 1 + pad) / k) - cx),
    Math.min(H - cy, Math.round((y1 + 1 + pad) / k) - cy),
  ];
  // Fundo opaco claro pede tile claro; sem fundo, decide pela luminosidade da própria marca.
  const bgLight = bgOpaque && 0.299 * corner[0] + 0.587 * corner[1] + 0.114 * corner[2] > 180;
  const tile = bgOpaque ? (bgLight ? 'light' : 'dark') : lum / n > 150 ? 'dark' : 'light';
  return { crop, tile };
}

/** Prévia de uma logo candidata, já recortada, com o recorte e o fundo sugeridos para o config. */
export async function previewLogo(token, org, repoName, path) {
  const img = await decode(await fetchRaw(token, org, repoName, path));
  const { crop, tile } = autoTrim(img);
  return { path, crop, tile, url: render(img, crop) };
}

export async function logoUrl(token, org, repo) {
  const { logo } = repo;
  if (!logo) return null;
  const key = `${PREFIX}${repo.name}.${logo.oid}.${(logo.crop ?? []).join('-')}`;
  const cached = readCache(key);
  if (cached) return cached;

  const img = await decode(await fetchRaw(token, org, repo.name, logo.path));
  const url = render(img, logo.crop);
  // Remove versões antigas da mesma logo antes de gravar a nova.
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(`${PREFIX}${repo.name}.`))
      .forEach((k) => localStorage.removeItem(k));
  } catch {}
  writeCache(key, url);
  return url;
}
