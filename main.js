const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const { pathToFileURL } = require('url');
const { categories, handlers, services } = require('./lib/tools');
const { JobContext } = require('./lib/core/job');
const { uniquePath, uniqueDir, baseName, ext, walk } = require('./lib/core/util');

const IMAGE_PREVIEW = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico']);
const jobs = new Map();
let mainWindow = null;

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Ultimate File Tool',
    backgroundColor: '#050505',
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: '#ffffff', height: 44 },
    trafficLightPosition: isMac ? { x: 16, y: 15 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!app.isPackaged && input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      mainWindow.webContents.toggleDevTools();
    }
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'r' && !app.isPackaged) {
      mainWindow.webContents.reload();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('job:event', payload);
}

async function describe(file) {
  try {
    const stat = await fsp.stat(file);
    const e = ext(file);
    return {
      path: file,
      name: path.basename(file),
      dir: stat.isDirectory(),
      size: stat.size,
      mtime: stat.mtimeMs,
      ext: e,
      url: pathToFileURL(file).href,
      image: !stat.isDirectory() && IMAGE_PREVIEW.has(e),
    };
  } catch {
    return { path: file, name: path.basename(file), missing: true };
  }
}

ipcMain.handle('app:bootstrap', async () => ({
  categories,
  platform: process.platform,
  versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  paths: { downloads: app.getPath('downloads'), documents: app.getPath('documents'), home: app.getPath('home') },
  packaged: app.isPackaged,
}));

ipcMain.handle('job:run', async (_event, { jobId, toolId, files = [], options = {}, outDir = null, fallbackDir = null }) => {
  const handler = handlers.get(toolId);
  if (!handler) return { ok: false, error: `Unknown tool ${toolId}` };
  const ctx = new JobContext({
    id: jobId,
    files,
    options,
    outDir,
    settings: { fallbackDir: fallbackDir || app.getPath('downloads') },
    emit: (type, data) => send({ jobId, type, ...data }),
  });
  jobs.set(jobId, ctx);
  const started = Date.now();
  try {
    const result = (await handler(ctx)) || {};
    const outputs = [];
    for (const out of result.outputs || []) if (out) outputs.push(await describe(out));
    return {
      ok: true,
      elapsed: Date.now() - started,
      outputs,
      errors: result.errors || [],
      notes: (result.notes || []).filter(Boolean),
      summary: result.summary || null,
      text: result.text ?? null,
      textLabel: result.textLabel || null,
      textExt: result.textExt || null,
      table: result.table || null,
      sections: (result.sections || []).map((s) => ({ ...s, image: s.image ? pathToFileURL(s.image).href : null })),
      folder: result.folder || null,
      dryRun: Boolean(result.dryRun),
    };
  } catch (error) {
    return { ok: false, cancelled: Boolean(error.cancelled || ctx.cancelled), error: error.message || String(error), elapsed: Date.now() - started };
  } finally {
    await ctx.cleanup();
    jobs.delete(jobId);
  }
});

ipcMain.handle('job:cancel', (_event, jobId) => {
  const ctx = jobs.get(jobId);
  if (ctx) ctx.cancel();
  return Boolean(ctx);
});

ipcMain.handle('service:call', async (_event, name, args = []) => {
  const fn = services.get(name);
  if (!fn) throw new Error(`Unknown service ${name}`);
  return fn(...args);
});

function filtersFor(accept) {
  if (!accept || !accept.length) return [{ name: 'All files', extensions: ['*'] }];
  return [
    { name: 'Supported files', extensions: accept },
    { name: 'All files', extensions: ['*'] },
  ];
}

ipcMain.handle('dialog:openFiles', async (_event, { accept, multiple = true, title } = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Select files',
    properties: ['openFile', ...(multiple ? ['multiSelections'] : [])],
    filters: filtersFor(accept),
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:openFolder', async (_event, { title, multiple = false } = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Select a folder',
    properties: ['openDirectory', 'createDirectory', ...(multiple ? ['multiSelections'] : [])],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('fs:describe', async (_event, paths) => Promise.all((paths || []).map(describe)));

ipcMain.handle('fs:listFiles', async (_event, dir, accept, recursive = true) => {
  const all = await walk(dir, { recursive, skipHidden: true });
  const allowed = accept && accept.length ? new Set(accept.map((a) => a.toLowerCase())) : null;
  return all.filter((f) => !allowed || allowed.has(ext(f))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
});

ipcMain.handle('fs:read', async (_event, file) => fsp.readFile(file));

ipcMain.handle('fs:write', async (_event, file, data) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, typeof data === 'string' ? data : Buffer.from(data));
  return describe(file);
});

ipcMain.handle('fs:outputPath', async (_event, input, { suffix = '', extension, name, outDir, fallbackDir } = {}) => {
  const dir = outDir || (input ? path.dirname(input) : fallbackDir || app.getPath('downloads'));
  await fsp.mkdir(dir, { recursive: true });
  const stem = name || `${baseName(input)}${suffix}`;
  return uniquePath(path.join(dir, `${stem}.${extension || ext(input)}`));
});

ipcMain.handle('fs:outputFolder', async (_event, input, { suffix = '', outDir } = {}) => {
  const dir = outDir || path.dirname(input);
  return uniqueDir(path.join(dir, `${baseName(input)}${suffix}`));
});

ipcMain.handle('shell:open', async (_event, target) => {
  const error = await shell.openPath(target);
  return error || null;
});

ipcMain.handle('shell:show', (_event, target) => {
  shell.showItemInFolder(target);
  return true;
});

ipcMain.handle('shell:external', (_event, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const ctx of jobs.values()) ctx.cancel();
  if (process.platform !== 'darwin') app.quit();
});
