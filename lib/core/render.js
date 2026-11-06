const fsp = require('fs').promises;
const path = require('path');
const { pathToFileURL } = require('url');
const { tempDir, removeQuiet } = require('./util');

const MARGINS = {
  none: { top: 0, bottom: 0, left: 0, right: 0 },
  narrow: { top: 0.3, bottom: 0.3, left: 0.3, right: 0.3 },
  normal: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
  wide: { top: 1, bottom: 1, left: 1, right: 1 },
};

function electron() {
  const mod = require('electron');
  if (typeof mod === 'string') throw new Error('This tool requires the Electron runtime');
  return mod;
}

async function withWindow(options, fn) {
  const { BrowserWindow } = electron();
  const win = new BrowserWindow({
    show: false,
    width: options.width || 1280,
    height: options.height || 900,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: options.javascript !== false,
      offscreen: Boolean(options.offscreen),
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.setAudioMuted(true);
  try {
    return await fn(win);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function loadInto(win, url, timeoutMs = 60000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Page load timed out')), timeoutMs);
  });
  try {
    await Promise.race([
      win.loadURL(url).catch((error) => {
        if (error.code === 'ERR_ABORTED' || error.errno === -3) return;
        throw new Error(`Could not load page: ${error.code || error.message}`);
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function htmlFileUrl(html, baseDir) {
  const dir = await tempDir('uft-html-');
  const file = path.join(dir, 'page.html');
  let content = html;
  if (baseDir) {
    const base = `<base href="${pathToFileURL(baseDir + path.sep).href}">`;
    content = /<head[^>]*>/i.test(content) ? content.replace(/<head[^>]*>/i, (m) => `${m}${base}`) : `${base}${content}`;
  }
  await fsp.writeFile(file, content, 'utf8');
  return { url: pathToFileURL(file).href, cleanup: () => removeQuiet(dir) };
}

async function toPdf(source, outPath, opts = {}) {
  const pageOptions = {
    pageSize: opts.pageSize || 'A4',
    landscape: Boolean(opts.landscape),
    printBackground: opts.printBackground !== false,
    margins: MARGINS[opts.margins || 'normal'] || MARGINS.normal,
    scale: opts.scale || 1,
  };
  let target = source.url;
  let cleanup = null;
  if (source.html !== undefined) {
    const prepared = await htmlFileUrl(source.html, source.baseDir);
    target = prepared.url;
    cleanup = prepared.cleanup;
  } else if (source.file) {
    target = pathToFileURL(source.file).href;
  }
  try {
    return await withWindow({ javascript: opts.javascript === true || Boolean(source.url) }, async (win) => {
      await loadInto(win, target, opts.timeout || 60000);
      await wait(opts.delay ?? (source.url ? 1500 : 300));
      const data = await win.webContents.printToPDF(pageOptions);
      await fsp.writeFile(outPath, data);
      return outPath;
    });
  } finally {
    if (cleanup) await cleanup();
  }
}

async function screenshot(url, outPath, opts = {}) {
  const width = opts.width || 1280;
  const height = opts.height || 800;
  return withWindow({ width, height, offscreen: true, javascript: true }, async (win) => {
    await loadInto(win, url, opts.timeout || 60000);
    await wait((opts.delay || 1.5) * 1000);
    let captureHeight = height;
    if (opts.fullPage) {
      const measured = await win.webContents
        .executeJavaScript(
          'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)',
        )
        .catch(() => height);
      captureHeight = Math.min(Math.max(height, Number(measured) || height), 16000);
      win.setContentSize(width, captureHeight);
      await wait(800);
    }
    const image = await win.webContents.capturePage({ x: 0, y: 0, width, height: captureHeight });
    if (image.isEmpty()) throw new Error('Capture returned an empty image');
    const buffer = opts.format === 'jpg' ? image.toJPEG(opts.quality || 90) : image.toPNG();
    await fsp.writeFile(outPath, buffer);
    return outPath;
  });
}

module.exports = { toPdf, screenshot, withWindow, loadInto, MARGINS };
