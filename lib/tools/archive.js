const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { ext, baseName, formatBytes, walk, tempDir, removeQuiet, uniquePath, uniqueDir } = require('../core/util');
const { ARCHIVE_IN, ZIP_FAMILY } = require('../core/formats');
const { run7z, parseList } = require('../core/sevenzip');
const o = require('../core/opts');

const LEVELS = { store: { zlib: 0, sz: 0 }, fast: { zlib: 1, sz: 1 }, normal: { zlib: 6, sz: 5 }, max: { zlib: 9, sz: 9 } };

function archiveStem(file) {
  const name = path.basename(file);
  return name.replace(/\.(tar\.(gz|bz2|xz|br|zst)|tgz|tbz2?|txz|[^.]+)$/i, '') || name;
}

function kindOf(file) {
  const name = path.basename(file).toLowerCase();
  if (/\.tar\.(gz|bz2|xz|zst|br)$/.test(name) || /\.(tgz|tbz2?|txz)$/.test(name)) return 'tarball';
  const e = ext(file);
  if (ZIP_FAMILY.includes(e)) return 'zip';
  if (e === 'tar' || e === 'cbt') return 'tar';
  if (e === 'gz') return 'gz';
  if (e === 'br') return 'br';
  if (e === 'zst') return 'zst';
  return '7z';
}

async function totalSize(items) {
  let total = 0;
  for (const item of items) {
    const st = await fsp.stat(item);
    if (st.isDirectory()) for (const f of await walk(item)) total += (await fsp.stat(f).catch(() => ({ size: 0 }))).size;
    else total += st.size;
  }
  return total;
}

function progressTransform(total, onProgress) {
  let done = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (total) onProgress(done / total);
      cb(null, chunk);
    },
  });
}

async function createArchive(ctx, items, target, { format, level, password }) {
  const lv = LEVELS[level] || LEVELS.normal;
  if (format === '7z' || (format === 'zip' && password)) {
    const args = ['a', `-t${format}`, target, ...items, `-mx=${lv.sz}`];
    if (password) args.push(`-p${password}`, ...(format === '7z' ? ['-mhe=on'] : ['-mem=AES256']));
    await run7z(ctx, args, { onProgress: (f) => ctx.stepProgress(f) });
    return target;
  }
  const archiver = require('archiver');
  const total = await totalSize(items);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(target);
    const archive = format === 'zip' ? archiver('zip', { zlib: { level: lv.zlib }, store: lv.zlib === 0 }) : archiver('tar', { gzip: format === 'tgz', gzipOptions: { level: lv.zlib || 1 } });
    const abort = () => {
      archive.abort();
      reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    };
    ctx.signal.addEventListener('abort', abort, { once: true });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.on('warning', (w) => ctx.log(w.message));
    archive.on('progress', (p) => total && ctx.stepProgress(p.fs.processedBytes / total));
    archive.pipe(output);
    (async () => {
      for (const item of items) {
        const st = await fsp.stat(item);
        if (st.isDirectory()) archive.directory(item, path.basename(item));
        else archive.file(item, { name: path.basename(item) });
      }
      archive.finalize();
    })().catch(reject);
  }).catch(async (error) => {
    await fsp.rm(target, { force: true });
    throw error;
  });
  return target;
}

async function extractArchive(ctx, file, dir, { password } = {}) {
  const kind = kindOf(file);
  const onProgress = (f) => ctx.stepProgress(f);
  if (kind === 'zip' && !password) {
    const extract = require('extract-zip');
    let count = 0;
    try {
      await extract(file, {
        dir,
        onEntry: (entry, zipfile) => {
          ctx.check();
          count++;
          onProgress(count / Math.max(1, zipfile.entryCount));
          if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error('This archive is password protected, enter the password');
        },
      });
    } catch (error) {
      if (/password|encrypt/i.test(error.message)) throw new Error('This archive is password protected, enter the password');
      throw error;
    }
    return;
  }
  if (kind === 'tar') {
    const tar = require('tar');
    const size = (await fsp.stat(file)).size;
    await pipeline(fs.createReadStream(file), progressTransform(size, onProgress), tar.x({ cwd: dir }));
    return;
  }
  if (kind === 'tarball' && /\.(tar\.gz|tgz)$/i.test(file)) {
    const tar = require('tar');
    const size = (await fsp.stat(file)).size;
    await pipeline(fs.createReadStream(file), progressTransform(size, onProgress), zlib.createGunzip(), tar.x({ cwd: dir }));
    return;
  }
  if (kind === 'gz' || kind === 'br' || kind === 'zst') {
    const target = await uniquePath(path.join(dir, path.basename(file).replace(/\.(gz|br|zst)$/i, '')));
    const size = (await fsp.stat(file)).size;
    const decoder = kind === 'gz' ? zlib.createGunzip() : kind === 'br' ? zlib.createBrotliDecompress() : zstdDecompress();
    await pipeline(fs.createReadStream(file), progressTransform(size, onProgress), decoder, fs.createWriteStream(target));
    if (ext(target) === 'tar') {
      await extractArchive(ctx, target, dir);
      await fsp.rm(target, { force: true });
    }
    return;
  }
  const args = ['x', file, `-o${dir}`, `-p${password || ''}`];
  await run7z(ctx, args, { onProgress });
  if (kind === 'tarball') {
    const inner = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.tar'));
    for (const t of inner) {
      const full = path.join(dir, t);
      await extractArchive(ctx, full, dir);
      await fsp.rm(full, { force: true });
    }
  }
}

function scoped(ctx, from, to) {
  return Object.create(ctx, { stepProgress: { value: (f, message) => ctx.stepProgress(from + (f || 0) * (to - from), message) } });
}

function zstdCompress(level) {
  if (typeof zlib.createZstdCompress !== 'function') throw new Error('Zstandard is not supported by this runtime');
  return zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
}

function zstdDecompress() {
  if (typeof zlib.createZstdDecompress !== 'function') throw new Error('Zstandard is not supported by this runtime');
  return zlib.createZstdDecompress();
}

async function listEntries(ctx, file) {
  const kind = kindOf(file);
  if (kind === 'zip') {
    const yauzl = require('yauzl');
    return new Promise((resolve, reject) => {
      yauzl.open(file, { lazyEntries: true, decodeStrings: true }, (err, zip) => {
        if (err) return reject(err);
        const entries = [];
        zip.on('entry', (e) => {
          entries.push({ name: e.fileName, size: e.uncompressedSize, packed: e.compressedSize, date: e.getLastModDate().toLocaleString(), dir: e.fileName.endsWith('/'), encrypted: (e.generalPurposeBitFlag & 1) !== 0 });
          zip.readEntry();
        });
        zip.on('end', () => resolve(entries));
        zip.on('error', reject);
        zip.readEntry();
      });
    });
  }
  if (kind === 'tar' || (kind === 'tarball' && /\.(tar\.gz|tgz)$/i.test(file))) {
    const tar = require('tar');
    const entries = [];
    await tar.t({ file, onReadEntry: (e) => entries.push({ name: e.path, size: e.size, packed: null, date: e.mtime ? e.mtime.toLocaleString() : '', dir: e.type === 'Directory' }) });
    return entries;
  }
  if (kind === 'gz' || kind === 'br' || kind === 'zst') {
    const st = await fsp.stat(file);
    return [{ name: path.basename(file).replace(/\.(gz|br|zst)$/i, ''), size: null, packed: st.size, date: st.mtime.toLocaleString(), dir: false }];
  }
  return parseList(await run7z(ctx, ['l', '-slt', file, '-p']));
}

const tools = [
  {
    id: 'archive.create',
    name: 'Create archive',
    icon: '📦',
    description: 'Pack files and folders into ZIP, 7Z, TAR or TAR.GZ, with optional AES-256 password.',
    keywords: ['zip', '7z', 'compress folder', 'tar', 'tgz', 'password zip', 'pack'],
    input: { kind: 'paths', accept: null },
    options: [
      o.select('format', 'Format', [['zip', 'ZIP'], ['7z', '7Z'], ['tgz', 'TAR.GZ'], ['tar', 'TAR']], 'zip'),
      o.select('level', 'Compression', [['store', 'Store'], ['fast', 'Fast'], ['normal', 'Normal'], ['max', 'Maximum']], 'normal'),
      o.password('password', 'Password (optional, AES-256)', { confirm: true, showIf: { format: ['zip', '7z'] } }),
      o.select('mode', 'Mode', [['single', 'One archive'], ['each', 'One archive per item']], 'single'),
      o.text('name', 'Archive name (empty = automatic)', '', o.when('mode', 'single')),
    ],
    actionLabel: 'Create archive',
    async run(ctx) {
      const opt = ctx.options;
      const extension = opt.format === 'tgz' ? 'tar.gz' : opt.format;
      const password = ['zip', '7z'].includes(opt.format) ? opt.password : '';
      if (opt.mode === 'each') {
        return ctx.eachFile(async (item) => {
          const target = await uniquePath(path.join(ctx.dirFor(item), `${path.basename(item)}.${extension}`));
          await createArchive(ctx, [item], target, { format: opt.format, level: opt.level, password });
          return target;
        });
      }
      const first = ctx.files[0];
      const name = opt.name || (ctx.files.length === 1 ? path.basename(first) : path.basename(path.dirname(first)) || 'archive');
      const target = await uniquePath(path.join(ctx.dirFor(first), `${name.replace(/\.(zip|7z|tar|tar\.gz|tgz)$/i, '')}.${extension}`));
      ctx.setStep(0, 1, 'Compressing');
      await createArchive(ctx, ctx.files, target, { format: opt.format, level: opt.level, password });
      const before = await totalSize(ctx.files);
      const after = (await fsp.stat(target)).size;
      return { outputs: [target], summary: `${formatBytes(before)} → ${formatBytes(after)}${before ? ` (${Math.round((after / before) * 100)}%)` : ''}${password ? ' · encrypted' : ''}` };
    },
  },
  {
    id: 'archive.extract',
    name: 'Extract archive',
    icon: '📂',
    description: 'Unpack ZIP, 7Z, TAR, TAR.GZ, TAR.BZ2, TAR.XZ, GZ, BZ2, XZ, CAB, ZST, JAR, APK, EPUB, CBZ and more.',
    keywords: ['unzip', 'un7z', 'untar', 'decompress', 'open zip', 'extract'],
    input: { kind: 'files', accept: ARCHIVE_IN },
    options: [
      o.select('destination', 'Extract to', [['folder', 'New folder per archive'], ['here', 'Same folder']], 'folder'),
      o.password('password', 'Password (if protected)'),
    ],
    actionLabel: 'Extract',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const dir = opt.destination === 'folder' ? await uniqueDir(path.join(ctx.dirFor(file), archiveStem(file))) : ctx.dirFor(file);
        const before = opt.destination === 'here' ? new Set(await fsp.readdir(dir)) : null;
        try {
          await extractArchive(ctx, file, dir, { password: opt.password });
        } catch (error) {
          if (opt.destination === 'folder') await removeQuiet(dir);
          throw error;
        }
        if (opt.destination === 'folder') {
          const count = (await walk(dir)).length;
          return { outputs: dir, note: `${path.basename(file)}: ${count} file(s) extracted` };
        }
        const created = (await fsp.readdir(dir)).filter((f) => !before.has(f)).map((f) => path.join(dir, f));
        return created;
      });
    },
  },
  {
    id: 'archive.list',
    name: 'List archive contents',
    icon: '🧾',
    description: 'See what is inside an archive without extracting it.',
    keywords: ['peek', 'browse', 'contents', 'view zip'],
    input: { kind: 'file', accept: ARCHIVE_IN },
    output: 'none',
    options: [],
    actionLabel: 'List',
    async run(ctx) {
      const entries = await listEntries(ctx, ctx.file);
      const files = entries.filter((e) => !e.dir);
      const total = files.reduce((s, e) => s + (e.size || 0), 0);
      return {
        table: {
          title: 'Contents',
          columns: ['Name', 'Size', 'Packed', 'Modified', ''],
          rows: entries.slice(0, 5000).map((e) => [e.name, e.dir ? '📁' : e.size === null ? '?' : formatBytes(e.size), e.packed ? formatBytes(e.packed) : '', e.date, e.encrypted ? '🔒' : '']),
        },
        summary: `${files.length} files · ${formatBytes(total)} uncompressed`,
      };
    },
  },
  {
    id: 'archive.convert',
    name: 'Convert archive',
    icon: '🔁',
    description: 'Repack an archive into another format, e.g. RAR-free 7Z to ZIP or ZIP to TAR.GZ.',
    keywords: ['7z to zip', 'zip to 7z', 'tar.gz to zip', 'repack'],
    input: { kind: 'files', accept: ARCHIVE_IN },
    options: [
      o.select('format', 'Target format', [['zip', 'ZIP'], ['7z', '7Z'], ['tgz', 'TAR.GZ'], ['tar', 'TAR']], 'zip'),
      o.select('level', 'Compression', [['fast', 'Fast'], ['normal', 'Normal'], ['max', 'Maximum']], 'normal'),
      o.password('password', 'Source password (if protected)'),
    ],
    actionLabel: 'Convert',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const tmp = await tempDir('uft-arc-');
        try {
          ctx.message('Extracting');
          await extractArchive(scoped(ctx, 0, 0.5), file, tmp, { password: opt.password });
          const items = (await fsp.readdir(tmp)).map((f) => path.join(tmp, f));
          const extension = opt.format === 'tgz' ? 'tar.gz' : opt.format;
          const target = await uniquePath(path.join(ctx.dirFor(file), `${archiveStem(file)}.${extension}`));
          ctx.message('Compressing');
          await createArchive(scoped(ctx, 0.5, 1), items, target, { format: opt.format, level: opt.level });
          return target;
        } finally {
          await removeQuiet(tmp);
        }
      });
    },
  },
  {
    id: 'archive.single',
    name: 'GZip / Brotli / Zstd',
    icon: '🗜️',
    description: 'Compress or decompress single files with gzip, Brotli, Zstandard or Deflate.',
    keywords: ['gz', 'gzip', 'brotli', 'br', 'zstd', 'zst', 'deflate', 'gunzip'],
    input: { kind: 'files', accept: null },
    options: [
      o.select('mode', 'Mode', [['compress', 'Compress'], ['decompress', 'Decompress']], 'compress'),
      o.select('algorithm', 'Algorithm', [['gz', 'GZip'], ['br', 'Brotli'], ['zst', 'Zstandard'], ['zz', 'Deflate']], 'gz', o.when('mode', 'compress')),
      o.range('level', 'Level', 1, 11, 9, o.when('mode', 'compress')),
    ],
    actionLabel: 'Run',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const size = (await fsp.stat(file)).size;
        const progress = progressTransform(size, (f) => ctx.stepProgress(f));
        if (opt.mode === 'compress') {
          const level = Number(opt.level);
          const stream = {
            gz: () => zlib.createGzip({ level: Math.min(9, level) }),
            br: () => zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } }),
            zst: () => zstdCompress(Math.min(19, level * 2)),
            zz: () => zlib.createDeflate({ level: Math.min(9, level) }),
          }[opt.algorithm]();
          const target = await uniquePath(path.join(ctx.dirFor(file), `${path.basename(file)}.${opt.algorithm}`));
          await pipeline(fs.createReadStream(file), progress, stream, fs.createWriteStream(target));
          const after = (await fsp.stat(target)).size;
          return { outputs: target, note: `${path.basename(file)}: ${formatBytes(size)} → ${formatBytes(after)}` };
        }
        const e = ext(file);
        const decoder = { gz: () => zlib.createGunzip(), tgz: () => zlib.createGunzip(), br: () => zlib.createBrotliDecompress(), zst: () => zstdDecompress(), zz: () => zlib.createInflate(), deflate: () => zlib.createInflate() }[e];
        if (!decoder) throw new Error('Unknown compressed format (expected .gz, .br, .zst or .zz)');
        const name = e === 'tgz' ? `${baseName(file)}.tar` : path.basename(file).slice(0, -(e.length + 1));
        const target = await uniquePath(path.join(ctx.dirFor(file), name));
        await pipeline(fs.createReadStream(file), progress, decoder(), fs.createWriteStream(target));
        return target;
      });
    },
  },
];

module.exports = {
  category: { id: 'archive', name: 'Archives', icon: '📦', color: ['#8e2de2', '#4a00e0'], description: 'Zip, 7z, tar: create, extract, inspect, convert' },
  tools,
  createArchive,
  extractArchive,
};
