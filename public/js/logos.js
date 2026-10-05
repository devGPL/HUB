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
