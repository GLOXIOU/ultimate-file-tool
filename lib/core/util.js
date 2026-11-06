const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

function unpacked(p) {
  if (!p) return p;
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function ext(file) {
  return path.extname(file).slice(1).toLowerCase();
}

function baseName(file) {
  return path.basename(file, path.extname(file));
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

const reservedPaths = new Set();

async function uniquePath(p) {
  const dir = path.dirname(p);
  const extension = path.extname(p);
  const stem = path.basename(p, extension);
  let candidate = p;
  for (let i = 1; (await exists(candidate)) || reservedPaths.has(candidate.toLowerCase()); i++) {
    candidate = path.join(dir, `${stem} (${i})${extension}`);
  }
  reservedPaths.add(candidate.toLowerCase());
  setTimeout(() => reservedPaths.delete(candidate.toLowerCase()), 1500);
  return candidate;
}

async function uniqueDir(p) {
  let candidate = p;
  for (let i = 1; await exists(candidate); i++) candidate = `${p} (${i})`;
  await fsp.mkdir(candidate, { recursive: true });
  return candidate;
}

function sanitizeName(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 200) || 'file';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const sign = bytes < 0 ? '-' : '';
  return `${sign}${value.toFixed(unit === 0 ? 0 : value < 10 ? 2 : 1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const sec = s.toFixed(seconds < 60 ? 2 : 0).padStart(seconds < 60 ? 5 : 2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${String(m).padStart(2, '0')}:${sec}`;
}

function parseTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim().replace(',', '.');
  if (!text) return null;
  const parts = text.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) throw new Error(`Invalid time "${value}". Use seconds or hh:mm:ss`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function parseRanges(text, total) {
  const pages = [];
  const groups = [];
  const source = String(text || '').trim();
  if (!source) return { pages: [], groups: [] };
  for (const raw of source.split(/[,;\s]+/).filter(Boolean)) {
    const token = raw.toLowerCase();
    let start;
    let end;
    if (token === 'odd' || token === 'even') {
      const list = [];
      for (let p = token === 'odd' ? 1 : 2; p <= total; p += 2) list.push(p);
      groups.push({ label: token, pages: list });
      pages.push(...list);
      continue;
    }
    const match = token.match(/^(\d+|last)?(?:-(\d+|last)?)?$/);
    if (!match || (!match[1] && !match[2] && !token.includes('-'))) throw new Error(`Invalid page range "${raw}"`);
    const resolve = (v, fallback) => (v === undefined ? fallback : v === 'last' ? total : Number(v));
    start = resolve(match[1], 1);
    end = token.includes('-') ? resolve(match[2], total) : start;
    if (start < 1 || end < 1 || start > total || end > total) throw new Error(`Page range "${raw}" is outside 1-${total}`);
    const list = [];
    const step = start <= end ? 1 : -1;
    for (let p = start; step > 0 ? p <= end : p >= end; p += step) list.push(p);
    groups.push({ label: start === end ? String(start) : `${start}-${end}`, pages: list });
    pages.push(...list);
  }
  return { pages, groups };
}

async function walk(dir, { recursive = true, includeDirs = false, skipHidden = false } = {}) {
  const results = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skipHidden && entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (includeDirs) results.push({ path: full, dir: true });
        if (recursive) stack.push(full);
      } else if (entry.isFile()) {
        results.push(includeDirs ? { path: full, dir: false } : full);
      }
    }
  }
  return results;
}

async function tempDir(prefix = 'uft-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeQuiet(p) {
  try {
    await fsp.rm(p, { recursive: true, force: true });
  } catch {}
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(text) {
  return escapeHtml(text);
}

function hexToRgb(hex) {
  const clean = String(hex || '#000000').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0');
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

module.exports = {
  unpacked,
  ext,
  baseName,
  exists,
  uniquePath,
  uniqueDir,
  sanitizeName,
  formatBytes,
  formatDuration,
  parseTime,
  parseRanges,
  walk,
  tempDir,
  removeQuiet,
  escapeHtml,
  escapeXml,
  hexToRgb,
};
