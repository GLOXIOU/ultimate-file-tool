const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { sanitizeName, uniquePath } = require('./util');

function fetchImpl() {
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return electron.net.fetch.bind(electron.net);
  } catch {}
  return fetch;
}

function filenameFromResponse(response, url) {
  const disposition = response.headers.get('content-disposition') || '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  if (star) {
    try {
      return sanitizeName(decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')));
    } catch {}
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  if (plain) return sanitizeName(plain[1].trim());
  try {
    const last = decodeURIComponent(new URL(response.url || url).pathname.split('/').filter(Boolean).pop() || '');
    if (last) return sanitizeName(last);
  } catch {}
  const type = (response.headers.get('content-type') || '').split(';')[0];
  const guessed = { 'text/html': 'html', 'application/json': 'json', 'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf' }[type];
  return `download${guessed ? `.${guessed}` : ''}`;
}

async function downloadTo(ctx, url, { dir, file, onProgress } = {}) {
  const response = await fetchImpl()(url, { redirect: 'follow', signal: ctx ? ctx.signal : undefined });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
  const target = file || (await uniquePath(path.join(dir, filenameFromResponse(response, url))));
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  const partial = `${target}.part`;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    if (onProgress) onProgress(total ? received / total : 0, received, total);
  });
  try {
    await pipeline(body, fs.createWriteStream(partial));
    await fsp.rename(partial, target);
  } catch (error) {
    await fsp.rm(partial, { force: true });
    if (ctx && ctx.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    throw error;
  }
  return { file: target, size: received };
}

module.exports = { downloadTo, fetchImpl };
