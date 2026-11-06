const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { ext, baseName, formatBytes, walk, uniquePath, exists, escapeHtml } = require('../core/util');
const { CATEGORY_BY_EXT, MIME } = require('../core/formats');
const { hashFile, moveToTrash } = require('./security');
const o = require('../core/opts');

const JUNK = new Set(['thumbs.db', '.ds_store', 'desktop.ini', '.localized']);

function detectType(buf) {
  const ascii = buf.subarray(0, 64).toString('latin1');
  const hex = buf.subarray(0, 16).toString('hex');
  const at = (offset, text) => buf.subarray(offset, offset + text.length).toString('latin1') === text;
  if (hex.startsWith('ffd8ff')) return { ext: 'jpg', label: 'JPEG image' };
  if (hex.startsWith('89504e470d0a1a0a')) return { ext: 'png', label: 'PNG image' };
  if (at(0, 'GIF8')) return { ext: 'gif', label: 'GIF image' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { ext: 'webp', label: 'WebP image' };
  if (at(0, 'RIFF') && at(8, 'WAVE')) return { ext: 'wav', label: 'WAV audio' };
  if (at(0, 'RIFF') && at(8, 'AVI ')) return { ext: 'avi', label: 'AVI video' };
  if (at(0, '%PDF')) return { ext: 'pdf', label: 'PDF document' };
  if (at(4, 'ftyp')) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|mif1|msf1|heis)/.test(brand)) return { ext: 'heic', label: 'HEIC image' };
    if (/^avi[fs]/.test(brand)) return { ext: 'avif', label: 'AVIF image' };
    if (brand === 'qt  ') return { ext: 'mov', label: 'QuickTime video' };
    if (/^M4A|^M4B/.test(brand)) return { ext: 'm4a', label: 'MPEG-4 audio' };
    if (/^3g/.test(brand)) return { ext: '3gp', label: '3GP video' };
    return { ext: 'mp4', label: 'MPEG-4 video' };
  }
  if (hex.startsWith('1a45dfa3')) return buf.includes(Buffer.from('webm')) ? { ext: 'webm', label: 'WebM video' } : { ext: 'mkv', label: 'Matroska video' };
  if (at(0, 'PK\x03\x04') || at(0, 'PK\x05\x06')) {
    const head = buf.toString('latin1');
    if (head.includes('word/')) return { ext: 'docx', label: 'Word document' };
    if (head.includes('xl/')) return { ext: 'xlsx', label: 'Excel workbook' };
    if (head.includes('ppt/')) return { ext: 'pptx', label: 'PowerPoint presentation' };
    if (head.includes('mimetypeapplication/epub')) return { ext: 'epub', label: 'EPUB book' };
    if (head.includes('mimetypeapplication/vnd.oasis.opendocument.text')) return { ext: 'odt', label: 'OpenDocument text' };
    if (head.includes('mimetypeapplication/vnd.oasis.opendocument.spreadsheet')) return { ext: 'ods', label: 'OpenDocument spreadsheet' };
    if (head.includes('AndroidManifest.xml')) return { ext: 'apk', label: 'Android package' };
    if (head.includes('META-INF/MANIFEST.MF')) return { ext: 'jar', label: 'Java archive' };
    return { ext: 'zip', label: 'ZIP archive' };
  }
  if (hex.startsWith('377abcaf271c')) return { ext: '7z', label: '7-Zip archive' };
  if (at(0, 'Rar!\x1a\x07')) return { ext: 'rar', label: 'RAR archive' };
  if (hex.startsWith('1f8b')) return { ext: 'gz', label: 'GZip data' };
  if (at(0, 'BZh')) return { ext: 'bz2', label: 'BZip2 data' };
  if (hex.startsWith('fd377a585a00')) return { ext: 'xz', label: 'XZ data' };
  if (hex.startsWith('28b52ffd')) return { ext: 'zst', label: 'Zstandard data' };
  if (at(257, 'ustar')) return { ext: 'tar', label: 'TAR archive' };
  if (at(0, 'ID3') || /^fff[bf3a2]/.test(hex)) return { ext: 'mp3', label: 'MP3 audio' };
  if (at(0, 'fLaC')) return { ext: 'flac', label: 'FLAC audio' };
  if (at(0, 'OggS')) return { ext: buf.includes(Buffer.from('OpusHead')) ? 'opus' : 'ogg', label: 'Ogg media' };
  if (hex.startsWith('3026b2758e66cf11')) return { ext: 'wmv', label: 'Windows Media (ASF)' };
  if (at(0, 'FLV')) return { ext: 'flv', label: 'Flash video' };
  if (at(0, 'BM') && buf.length > 26) return { ext: 'bmp', label: 'Bitmap image' };
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return { ext: 'tiff', label: 'TIFF image' };
  if (hex.startsWith('00000100')) return { ext: 'ico', label: 'Icon' };
  if (at(0, '8BPS')) return { ext: 'psd', label: 'Photoshop document' };
  if (at(0, 'MZ')) return { ext: 'exe', label: 'Windows executable' };
  if (hex.startsWith('7f454c46')) return { ext: 'elf', label: 'Linux executable' };
  if (hex.startsWith('cafebabe')) return { ext: 'class', label: 'Java class / Mach-O' };
  if (hex.startsWith('d0cf11e0a1b11ae1')) return { ext: 'doc', label: 'Legacy Office document (DOC/XLS/PPT/MSI)' };
  if (at(0, 'SQLite format 3')) return { ext: 'sqlite', label: 'SQLite database' };
  if (hex.startsWith('0061736d')) return { ext: 'wasm', label: 'WebAssembly' };
  if (at(0, 'wOFF')) return { ext: 'woff', label: 'WOFF font' };
  if (at(0, 'wOF2')) return { ext: 'woff2', label: 'WOFF2 font' };
  if (hex.startsWith('00010000') || at(0, 'true')) return { ext: 'ttf', label: 'TrueType font' };
  if (at(0, 'OTTO')) return { ext: 'otf', label: 'OpenType font' };
  if (at(0, 'UFT1')) return { ext: 'enc', label: 'Ultimate File Tool encrypted file' };
  if (at(0, '{\\rtf')) return { ext: 'rtf', label: 'Rich Text document' };
  if (at(0, '%!PS')) return { ext: 'ps', label: 'PostScript' };
  const text = buf.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^<\?xml[\s\S]*<svg|^<svg/i.test(text)) return { ext: 'svg', label: 'SVG image' };
  if (/^<!doctype html|^<html/i.test(text)) return { ext: 'html', label: 'HTML document' };
  if (/^<\?xml/i.test(text)) return { ext: 'xml', label: 'XML document' };
  if (/^[{[]/.test(text)) return { ext: 'json', label: 'JSON (probably)' };
  const sample = buf.subarray(0, 4096);
  const binary = sample.some((b) => b === 0);
  if (!binary && sample.length) return { ext: 'txt', label: 'Text' };
  return { ext: null, label: ascii ? 'Unknown binary data' : 'Empty file' };
}

const COMPATIBLE = [
  ['jpg', 'jpeg', 'jfif', 'jpe'],
  ['tif', 'tiff'],
  ['mp4', 'm4v', 'm4a', 'm4b', 'm4r', 'mov', '3gp', '3g2', 'f4v'],
  ['mkv', 'mka', 'webm'],
  ['zip', 'jar', 'war', 'apk', 'epub', 'xpi', 'cbz', 'vsix', 'nupkg', 'whl', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'aab', 'ipa', 'kmz', 'xps', '3mf'],
  ['gz', 'tgz'],
  ['bz2', 'tbz2', 'tbz'],
  ['xz', 'txz'],
  ['ogg', 'oga', 'ogv', 'opus', 'spx'],
  ['doc', 'xls', 'ppt', 'msi', 'msg', 'pub', 'vsd'],
  ['exe', 'dll', 'sys', 'scr', 'com', 'ocx', 'cpl', 'efi', 'mui'],
  ['ttf', 'ttc'],
  ['txt', 'md', 'csv', 'tsv', 'log', 'ini', 'cfg', 'conf', 'js', 'ts', 'py', 'css', 'sh', 'bat', 'yml', 'yaml', 'toml', 'srt', 'vtt', 'env', 'json', 'xml', 'html', 'htm', 'svg'],
  ['json', 'geojson', 'jsonc', 'webmanifest', 'har', 'ipynb'],
  ['xml', 'svg', 'xhtml', 'plist', 'kml', 'gpx', 'rss', 'atom', 'xaml', 'csproj', 'config'],
  ['class', 'dylib'],
  ['wav', 'avi', 'webp'],
  ['wmv', 'wma', 'asf'],
];

function compatible(a, b) {
  if (a === b) return true;
  return COMPATIBLE.some((group) => group.includes(a) && group.includes(b));
}

async function readHead(file, size = 8192) {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

function applyCase(text, mode) {
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  switch (mode) {
    case 'lower':
      return text.toLowerCase();
    case 'upper':
      return text.toUpperCase();
    case 'title':
      return text.toLowerCase().replace(/(^|[\s_\-.(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    case 'kebab':
      return words.join('-').toLowerCase();
    case 'snake':
      return words.join('_').toLowerCase();
    case 'nospaces':
      return text.replace(/\s+/g, '_');
    default:
      return text;
  }
}

function stamp(date, kind) {
  const p = (n) => String(n).padStart(2, '0');
  if (kind === 'date') return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  return `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function previewTable(rows, columns = ['Current', 'New']) {
  return { title: `${rows.length} change${rows.length === 1 ? '' : 's'}`, columns, rows };
}

const tools = [
  {
    id: 'files.rename',
    name: 'Bulk rename',
    icon: '✏️',
    description: 'Rename many files at once: patterns, numbering, dates, find & replace, regex, case and extension. Preview first.',
    keywords: ['rename', 'batch rename', 'numbering', 'sequence', 'change extension', 'regex'],
    input: { kind: 'files', accept: null, ordered: true },
    output: 'none',
    preview: true,
    options: [
      o.text('pattern', 'Name pattern', '{name}', { wide: true, help: 'Tokens: {name} {n} {ext} {date} {time} {parent}. Example: Holiday_{n}' }),
      o.text('find', 'Find', ''),
      o.text('replace', 'Replace with', ''),
      o.checkbox('regex', 'Find is a regular expression', false),
      o.select('case', 'Case', [['keep', 'Keep'], ['lower', 'lowercase'], ['upper', 'UPPERCASE'], ['title', 'Title Case'], ['kebab', 'kebab-case'], ['snake', 'snake_case'], ['nospaces', 'Spaces → _']], 'keep'),
      o.number('start', 'Start number', 1, { min: 0 }),
      o.number('padding', 'Number digits', 3, { min: 1, max: 10 }),
      o.text('extension', 'New extension (empty = keep)', ''),
      o.checkbox('lowerExt', 'Lowercase extensions', false),
    ],
    actionLabel: 'Rename',
    async run(ctx) {
      const opt = ctx.options;
      let re = null;
      if (opt.find) {
        try {
          re = new RegExp(opt.regex ? opt.find : opt.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu');
        } catch (error) {
          throw new Error(`Invalid regular expression: ${error.message}`);
        }
      }
      const plan = [];
      const taken = new Set();
      const sources = new Set(ctx.files.map((f) => f.toLowerCase()));
      for (let i = 0; i < ctx.files.length; i++) {
        const file = ctx.files[i];
        const st = await fsp.stat(file);
        let name = baseName(file);
        if (re) name = name.replace(re, opt.regex ? opt.replace : () => opt.replace);
        const n = String(Number(opt.start) + i).padStart(Number(opt.padding) || 1, '0');
        let e = opt.extension ? opt.extension.replace(/^\./, '') : path.extname(file).slice(1);
        if (opt.lowerExt) e = e.toLowerCase();
        let next = (opt.pattern || '{name}')
          .replace(/\{name\}/g, name)
          .replace(/\{n\}/g, n)
          .replace(/\{ext\}/g, e)
          .replace(/\{date\}/g, stamp(st.mtime, 'date'))
          .replace(/\{time\}/g, stamp(st.mtime, 'time'))
          .replace(/\{parent\}/g, path.basename(path.dirname(file)));
        next = applyCase(next, opt.case).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'file';
        let target = path.join(path.dirname(file), e ? `${next}.${e}` : next);
        let k = 1;
        while (taken.has(target.toLowerCase()) || (target.toLowerCase() !== file.toLowerCase() && !sources.has(target.toLowerCase()) && (await exists(target)))) {
          target = path.join(path.dirname(file), `${next} (${k++})${e ? `.${e}` : ''}`);
        }
        taken.add(target.toLowerCase());
        if (target !== file) plan.push({ from: file, to: target });
      }
      if (opt.dryRun) return { dryRun: true, table: previewTable(plan.map((p) => [path.basename(p.from), path.basename(p.to)])), summary: plan.length ? `${plan.length} file(s) will be renamed` : 'Nothing to rename' };
      const temps = [];
      for (const p of plan) {
        const tmp = path.join(path.dirname(p.from), `.uft-rename-${crypto.randomBytes(6).toString('hex')}`);
        await fsp.rename(p.from, tmp);
        temps.push({ ...p, tmp });
      }
      for (const p of temps) await fsp.rename(p.tmp, p.to);
      return { outputs: plan.map((p) => p.to), summary: `${plan.length} file(s) renamed` };
    },
  },
  {
    id: 'files.duplicates',
    name: 'Find duplicates',
    icon: '👯',
    description: 'Find identical files by content (SHA-256) in a folder and send the extra copies to the recycle bin.',
    keywords: ['duplicate', 'same files', 'clean up', 'free space', 'dedupe'],
    input: { kind: 'folder' },
    output: 'none',
    preview: true,
    danger: 'Extra copies will be moved to the recycle bin (you can restore them from there).',
    options: [
      o.checkbox('recursive', 'Include subfolders', true),
      o.select('minSize', 'Ignore files smaller than', [['1', 'Nothing'], ['1024', '1 KB'], ['102400', '100 KB'], ['1048576', '1 MB']], '1'),
      o.select('keep', 'Keep', [['oldest', 'Oldest copy'], ['newest', 'Newest copy'], ['shortest', 'Shortest path']], 'oldest'),
    ],
    actionLabel: 'Remove duplicates',
    async run(ctx) {
      const opt = ctx.options;
      ctx.message('Scanning files');
      const files = await walk(ctx.file, { recursive: opt.recursive });
      const bySize = new Map();
      for (const f of files) {
        const st = await fsp.stat(f).catch(() => null);
        if (!st || st.size < Number(opt.minSize)) continue;
        if (!bySize.has(st.size)) bySize.set(st.size, []);
        bySize.get(st.size).push({ path: f, size: st.size, mtime: st.mtimeMs });
      }
      const candidates = [...bySize.values()].filter((g) => g.length > 1).flat();
      const byHash = new Map();
      for (let i = 0; i < candidates.length; i++) {
        ctx.check();
        ctx.progress((i / Math.max(1, candidates.length)) * 100, `Hashing ${path.basename(candidates[i].path)}`);
        const { sha256 } = await hashFile(candidates[i].path, ['sha256'], null, ctx.signal);
        const key = `${candidates[i].size}:${sha256}`;
        if (!byHash.has(key)) byHash.set(key, []);
        byHash.get(key).push(candidates[i]);
      }
      const groups = [...byHash.values()].filter((g) => g.length > 1);
      const rows = [];
      const remove = [];
      let wasted = 0;
      groups.forEach((group, gi) => {
        const sorted = [...group].sort((a, b) => (opt.keep === 'newest' ? b.mtime - a.mtime : opt.keep === 'shortest' ? a.path.length - b.path.length : a.mtime - b.mtime));
        sorted.forEach((f, i) => {
          rows.push([gi + 1, i === 0 ? '✅ keep' : '🗑 remove', path.relative(ctx.file, f.path), formatBytes(f.size), new Date(f.mtime).toLocaleString()]);
          if (i > 0) {
            remove.push(f.path);
            wasted += f.size;
          }
        });
      });
      const table = { title: `${groups.length} group(s) of duplicates`, columns: ['Group', 'Action', 'File', 'Size', 'Modified'], rows };
      if (opt.dryRun || !remove.length) return { dryRun: Boolean(opt.dryRun && remove.length), table, summary: remove.length ? `${remove.length} extra copies · ${formatBytes(wasted)} reclaimable` : 'No duplicates found 🎉' };
      const errors = [];
      for (let i = 0; i < remove.length; i++) {
        ctx.progress((i / remove.length) * 100, `Recycling ${path.basename(remove[i])}`);
        try {
          await moveToTrash(remove[i]);
        } catch (error) {
          errors.push({ file: remove[i], error: error.message });
        }
      }
      return { table, errors, summary: `${remove.length - errors.length} duplicates moved to the recycle bin · ${formatBytes(wasted)} freed` };
    },
  },
  {
    id: 'files.analyze',
    name: 'Folder size analyzer',
    icon: '📊',
    description: 'See what takes up space: biggest subfolders, largest files and space by file type.',
    keywords: ['disk usage', 'space', 'big files', 'storage', 'treesize', 'windirstat'],
    input: { kind: 'folder' },
    output: 'none',
    options: [o.number('top', 'Largest files to list', 30, { min: 5, max: 500 })],
    actionLabel: 'Analyze',
    async run(ctx) {
      ctx.message('Scanning');
      const root = ctx.file;
      const files = await walk(root);
      const children = new Map();
      const types = new Map();
      const list = [];
      let total = 0;
      for (let i = 0; i < files.length; i++) {
        if (i % 500 === 0) {
          ctx.check();
          ctx.progress((i / files.length) * 100, `${i.toLocaleString()} / ${files.length.toLocaleString()} files`);
        }
        const st = await fsp.stat(files[i]).catch(() => null);
        if (!st) continue;
        total += st.size;
        const rel = path.relative(root, files[i]);
        const top = rel.split(path.sep)[0];
        const isFile = !rel.includes(path.sep);
        const key = isFile ? '(files in this folder)' : `📁 ${top}`;
        const c = children.get(key) || { size: 0, count: 0 };
        c.size += st.size;
        c.count++;
        children.set(key, c);
        const group = CATEGORY_BY_EXT[ext(files[i])] || 'Other';
        const t = types.get(group) || { size: 0, count: 0 };
        t.size += st.size;
        t.count++;
        types.set(group, t);
        list.push({ path: rel, size: st.size });
      }
      const pct = (n) => (total ? `${((n / total) * 100).toFixed(1)}%` : '0%');
      list.sort((a, b) => b.size - a.size);
      return {
        summary: `${formatBytes(total)} in ${files.length.toLocaleString()} files`,
        sections: [
          { title: 'By folder', table: { columns: ['Folder', 'Size', 'Share', 'Files'], rows: [...children].sort((a, b) => b[1].size - a[1].size).map(([k, v]) => [k, formatBytes(v.size), pct(v.size), v.count.toLocaleString()]) } },
          { title: 'By type', table: { columns: ['Type', 'Size', 'Share', 'Files'], rows: [...types].sort((a, b) => b[1].size - a[1].size).map(([k, v]) => [k, formatBytes(v.size), pct(v.size), v.count.toLocaleString()]) } },
          { title: `Largest files`, table: { columns: ['File', 'Size', 'Share'], rows: list.slice(0, Number(ctx.options.top) || 30).map((f) => [f.path, formatBytes(f.size), pct(f.size)]) } },
        ],
      };
    },
  },
  {
    id: 'files.organize',
    name: 'Auto-organize folder',
    icon: '🗂️',
    description: 'Sort a messy folder (like Downloads) into subfolders by type, extension or date.',
    keywords: ['sort', 'tidy', 'clean downloads', 'organize', 'categorize'],
    input: { kind: 'folder' },
    output: 'none',
    preview: true,
    options: [o.select('mode', 'Sort by', [['category', 'Type (Images, Videos…)'], ['extension', 'Extension'], ['month', 'Year / month'], ['year', 'Year']], 'category')],
    actionLabel: 'Organize',
    async run(ctx) {
      const root = ctx.file;
      const entries = await fsp.readdir(root, { withFileTypes: true });
      const plan = [];
      for (const entry of entries) {
        if (!entry.isFile() || JUNK.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;
        const full = path.join(root, entry.name);
        const st = await fsp.stat(full);
        const e = ext(entry.name);
        let folder;
        if (ctx.options.mode === 'category') folder = CATEGORY_BY_EXT[e] || (e ? 'Other' : 'No extension');
        else if (ctx.options.mode === 'extension') folder = e ? e.toUpperCase() : 'No extension';
        else if (ctx.options.mode === 'year') folder = String(st.mtime.getFullYear());
        else folder = path.join(String(st.mtime.getFullYear()), String(st.mtime.getMonth() + 1).padStart(2, '0'));
        plan.push({ from: full, folder });
      }
      if (ctx.options.dryRun) return { dryRun: true, table: previewTable(plan.map((p) => [path.basename(p.from), `${p.folder}${path.sep}`]), ['File', 'Moves to']), summary: `${plan.length} file(s) into ${new Set(plan.map((p) => p.folder)).size} folder(s)` };
      const outputs = [];
      for (let i = 0; i < plan.length; i++) {
        ctx.progress((i / plan.length) * 100, path.basename(plan[i].from));
        const dir = path.join(root, plan[i].folder);
        await fsp.mkdir(dir, { recursive: true });
        const target = await uniquePath(path.join(dir, path.basename(plan[i].from)));
        await moveFile(plan[i].from, target);
        outputs.push(target);
      }
      return { outputs: [...new Set(outputs.map((p) => path.dirname(p)))], summary: `${plan.length} file(s) organized` };
    },
  },
  {
    id: 'files.split',
    name: 'Split file',
    icon: '🔪',
    description: 'Cut a big file into numbered parts (.001, .002…) to fit on drives or email limits.',
    keywords: ['chunk', 'parts', 'split large file', 'fat32'],
    input: { kind: 'files', accept: null },
    options: [
      o.select('size', 'Part size', [['10', '10 MB'], ['25', '25 MB (email)'], ['100', '100 MB'], ['700', '700 MB (CD)'], ['1024', '1 GB'], ['4095', '4 GB (FAT32)'], ['custom', 'Custom']], '100'),
      o.number('custom', 'Part size (MB)', 50, { min: 1, ...o.when('size', 'custom') }),
    ],
    actionLabel: 'Split',
    async run(ctx) {
      const mb = ctx.options.size === 'custom' ? Number(ctx.options.custom) : Number(ctx.options.size);
      const partSize = Math.max(1, Math.floor(mb * 1024 * 1024));
      return ctx.eachFile(async (file) => {
        const { size } = await fsp.stat(file);
        const parts = Math.max(1, Math.ceil(size / partSize));
        const digits = Math.max(3, String(parts).length);
        const dir = ctx.dirFor(file);
        const outputs = [];
        const handle = await fsp.open(file, 'r');
        try {
          const buf = Buffer.alloc(Math.min(partSize, 8 << 20));
          for (let p = 0; p < parts; p++) {
            const target = path.join(dir, `${path.basename(file)}.${String(p + 1).padStart(digits, '0')}`);
            const out = await fsp.open(target, 'w');
            try {
              let written = 0;
              const limit = Math.min(partSize, size - p * partSize);
              while (written < limit) {
                ctx.check();
                const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, limit - written), p * partSize + written);
                if (!bytesRead) break;
                await out.write(buf, 0, bytesRead);
                written += bytesRead;
                ctx.stepProgress((p * partSize + written) / size, `Part ${p + 1}/${parts}`);
              }
            } finally {
              await out.close();
            }
            outputs.push(target);
          }
        } finally {
          await handle.close();
        }
        return outputs;
      });
    },
  },
  {
    id: 'files.join',
    name: 'Join split files',
    icon: '🧷',
    description: 'Rebuild the original file from its .001, .002… parts.',
    keywords: ['merge parts', 'combine', '001', 'reassemble'],
    input: { kind: 'file', accept: null },
    options: [],
    actionLabel: 'Join',
    async run(ctx) {
      const m = /^(.*)\.(\d{3,})$/.exec(ctx.file);
      if (!m) throw new Error('Pick the first part of a split file (ending in .001)');
      const [, base, num] = m;
      const digits = num.length;
      const parts = [];
      for (let i = 1; ; i++) {
        const part = `${base}.${String(i).padStart(digits, '0')}`;
        if (!(await exists(part))) break;
        parts.push(part);
      }
      if (!parts.length) throw new Error('Part .001 not found');
      const sizes = await Promise.all(parts.map(async (p) => (await fsp.stat(p)).size));
      const total = sizes.reduce((a, b) => a + b, 0);
      const target = await uniquePath(path.join(ctx.dirFor(base), path.basename(base)));
      const out = fs.createWriteStream(target);
      let done = 0;
      try {
        for (const part of parts) {
          for await (const chunk of fs.createReadStream(part, { highWaterMark: 4 << 20 })) {
            ctx.check();
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            done += chunk.length;
            ctx.progress((done / total) * 100, path.basename(part));
          }
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      return { outputs: [target], summary: `${parts.length} parts → ${formatBytes(total)}` };
    },
  },
  {
    id: 'files.info',
    name: 'File info & real type',
    icon: '🔍',
    description: 'Size, dates, MIME type, hashes and the real file type detected from its content (magic bytes).',
    keywords: ['properties', 'mime', 'magic bytes', 'file type', 'what is this file'],
    input: { kind: 'files', accept: null },
    output: 'none',
    options: [o.checkbox('hashes', 'Compute MD5 & SHA-256', true)],
    actionLabel: 'Inspect',
    async run(ctx) {
      const sections = [];
      const result = await ctx.eachFile(async (file) => {
        const st = await fsp.stat(file);
        const detected = detectType(await readHead(file));
        const e = ext(file);
        const rows = [
          ['Name', path.basename(file)],
          ['Folder', path.dirname(file)],
          ['Size', `${formatBytes(st.size)} (${st.size.toLocaleString()} bytes)`],
          ['Created', st.birthtime.toLocaleString()],
          ['Modified', st.mtime.toLocaleString()],
          ['Accessed', st.atime.toLocaleString()],
          ['Extension', e ? `.${e}` : '(none)'],
          ['Category', CATEGORY_BY_EXT[e] || 'Other'],
          ['MIME type', MIME[e] || 'application/octet-stream'],
          ['Detected type', `${detected.label}${detected.ext ? ` (.${detected.ext})` : ''}`],
          ['Extension matches', !detected.ext || !e ? '-' : compatible(e, detected.ext) ? '✅ Yes' : `⚠️ No, looks like .${detected.ext}`],
          ['Read-only', st.mode & 0o200 ? 'No' : 'Yes'],
        ];
        if (ctx.options.hashes && st.size < 4 * 1024 ** 3) {
          const h = await hashFile(file, ['md5', 'sha256'], (f) => ctx.stepProgress(f), ctx.signal);
          rows.push(['MD5', h.md5], ['SHA-256', h.sha256]);
        }
        sections.push({ title: path.basename(file), table: { columns: ['Property', 'Value'], rows } });
        return null;
      });
      result.sections = sections;
      return result;
    },
  },
  {
    id: 'files.hex',
    name: 'Hex viewer',
    icon: '🧬',
    description: 'Inspect the raw bytes of any file as a classic hex dump.',
    keywords: ['hexdump', 'binary', 'bytes', 'raw'],
    input: { kind: 'file', accept: null },
    output: 'none',
    options: [o.text('offset', 'Offset (decimal or 0x…)', '0'), o.select('length', 'Bytes', [['256', '256'], ['1024', '1 KB'], ['4096', '4 KB'], ['16384', '16 KB'], ['65536', '64 KB']], '1024')],
    actionLabel: 'View',
    async run(ctx) {
      const offset = Number(String(ctx.options.offset).trim().toLowerCase().startsWith('0x') ? parseInt(ctx.options.offset, 16) : ctx.options.offset) || 0;
      const length = Number(ctx.options.length);
      const handle = await fsp.open(ctx.file, 'r');
      let buf;
      let size;
      try {
        size = (await handle.stat()).size;
        buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        buf = buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      const lines = [];
      for (let i = 0; i < buf.length; i += 16) {
        const row = buf.subarray(i, i + 16);
        const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
        const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        lines.push(`${(offset + i).toString(16).padStart(8, '0')}  ${hex.slice(0, 23)}  ${hex.slice(24)}  |${ascii}|`);
      }
      return { text: lines.join('\n') || '(no data at this offset)', textLabel: `Bytes ${offset}-${offset + buf.length - 1} of ${size.toLocaleString()}`, summary: detectType(await readHead(ctx.file)).label };
    },
  },
  {
    id: 'files.list',
    name: 'Export file list',
    icon: '📋',
    description: 'Export the list of files in a folder to CSV, Excel-ready TXT, JSON or HTML.',
    keywords: ['directory listing', 'inventory', 'catalog', 'tree', 'dir'],
    input: { kind: 'folder' },
    options: [
      o.select('format', 'Format', [['csv', 'CSV'], ['txt', 'Text tree'], ['json', 'JSON'], ['html', 'HTML']], 'csv'),
      o.checkbox('recursive', 'Include subfolders', true),
    ],
    actionLabel: 'Export',
    async run(ctx) {
      const root = ctx.file;
      ctx.message('Scanning');
      const files = (await walk(root, { recursive: ctx.options.recursive })).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const items = [];
      for (const f of files) {
        const st = await fsp.stat(f).catch(() => null);
        if (st) items.push({ path: path.relative(root, f), name: path.basename(f), ext: ext(f), size: st.size, modified: st.mtime.toISOString() });
      }
      let content;
      const fmt = ctx.options.format;
      if (fmt === 'csv') content = `﻿${require('papaparse').unparse(items)}`;
      else if (fmt === 'json') content = JSON.stringify(items, null, 2);
      else if (fmt === 'html') content = `<!DOCTYPE html><meta charset="utf-8"><title>${escapeHtml(path.basename(root))}</title><style>body{font-family:Segoe UI,Arial;padding:20px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 10px;text-align:left}</style><h1>${escapeHtml(root)}</h1><table><tr><th>Path</th><th>Size</th><th>Modified</th></tr>${items.map((i) => `<tr><td>${escapeHtml(i.path)}</td><td>${formatBytes(i.size)}</td><td>${i.modified.slice(0, 19).replace('T', ' ')}</td></tr>`).join('')}</table>`;
      else content = `${path.basename(root)}/\n${items.map((i) => `${'  '.repeat(i.path.split(path.sep).length)}${i.name}  (${formatBytes(i.size)})`).join('\n')}`;
      const target = await uniquePath(path.join(ctx.dirFor(root), `${path.basename(root)}_listing.${fmt}`));
      await fsp.writeFile(target, content, 'utf8');
      return { outputs: [target], summary: `${items.length.toLocaleString()} files listed` };
    },
  },
  {
    id: 'files.emptyFolders',
    name: 'Remove empty folders',
    icon: '🧹',
    description: 'Find every empty folder (ignoring Thumbs.db, .DS_Store…) and move them to the recycle bin.',
    keywords: ['empty', 'cleanup', 'directories', 'tidy'],
    input: { kind: 'folder' },
    output: 'none',
    preview: true,
    danger: 'Empty folders will be moved to the recycle bin.',
    options: [o.checkbox('junk', 'Treat folders containing only junk files (Thumbs.db, .DS_Store) as empty', true)],
    actionLabel: 'Remove',
    async run(ctx) {
      const root = ctx.file;
      const empty = new Set();
      const visit = async (dir) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        let isEmpty = true;
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!(await visit(full))) isEmpty = false;
          } else if (!(ctx.options.junk && JUNK.has(e.name.toLowerCase()))) isEmpty = false;
        }
        if (isEmpty && dir !== root) empty.add(dir);
        return isEmpty;
      };
      await visit(root);
      const top = [...empty].filter((d) => !empty.has(path.dirname(d)));
      const table = previewTable([...empty].sort().map((d) => [path.relative(root, d), top.includes(d) ? 'remove' : '(inside)']), ['Folder', '']);
      if (ctx.options.dryRun || !top.length) return { dryRun: Boolean(ctx.options.dryRun && top.length), table, summary: empty.size ? `${empty.size} empty folder(s)` : 'No empty folders' };
      const errors = [];
      for (const d of top) {
        try {
          await moveToTrash(d);
        } catch (error) {
          errors.push({ file: d, error: error.message });
        }
      }
      return { table, errors, summary: `${empty.size} empty folder(s) removed` };
    },
  },
  {
    id: 'files.flatten',
    name: 'Flatten folder',
    icon: '🥞',
    description: 'Move every file from all subfolders into the main folder.',
    keywords: ['flatten', 'move up', 'subfolders', 'collect'],
    input: { kind: 'folder' },
    output: 'none',
    preview: true,
    options: [o.checkbox('removeEmpty', 'Delete the emptied subfolders', true)],
    actionLabel: 'Flatten',
    async run(ctx) {
      const root = ctx.file;
      const files = (await walk(root)).filter((f) => path.dirname(f) !== root && !JUNK.has(path.basename(f).toLowerCase()));
      if (ctx.options.dryRun) return { dryRun: true, table: previewTable(files.map((f) => [path.relative(root, f), path.basename(f)]), ['From', 'To']), summary: `${files.length} file(s) to move` };
      const outputs = [];
      for (let i = 0; i < files.length; i++) {
        ctx.progress((i / files.length) * 100, path.basename(files[i]));
        const target = await uniquePath(path.join(root, path.basename(files[i])));
        await moveFile(files[i], target);
        outputs.push(target);
      }
      if (ctx.options.removeEmpty) {
        const dirs = (await walk(root, { includeDirs: true })).filter((e) => e.dir).map((e) => e.path).sort((a, b) => b.length - a.length);
        for (const d of dirs) {
          const left = (await fsp.readdir(d).catch(() => ['x'])).filter((n) => !JUNK.has(n.toLowerCase()));
          if (!left.length) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
        }
      }
      return { outputs, summary: `${files.length} file(s) moved` };
    },
  },
  {
    id: 'files.touch',
    name: 'Change file dates',
    icon: '📅',
    description: 'Set the modified and accessed dates of files to now or any date you choose.',
    keywords: ['timestamp', 'touch', 'modified date', 'date'],
    input: { kind: 'files', accept: null },
    output: 'none',
    options: [o.select('mode', 'Set to', [['now', 'Now'], ['custom', 'Custom date']], 'now'), o.datetime('date', 'Date & time', o.when('mode', 'custom'))],
    actionLabel: 'Apply',
    async run(ctx) {
      const date = ctx.options.mode === 'custom' ? new Date(ctx.options.date) : new Date();
      if (Number.isNaN(date.getTime())) throw new Error('Pick a valid date');
      return ctx.eachFile(async (file) => {
        await fsp.utimes(file, date, date);
        return { note: `${path.basename(file)} → ${date.toLocaleString()}` };
      });
    },
  },
  {
    id: 'files.fixExt',
    name: 'Fix wrong extensions',
    icon: '🩹',
    description: 'Detect files whose extension lies about their real content (e.g. a .png that is a JPEG) and fix them.',
    keywords: ['wrong extension', 'file type', 'repair', 'magic bytes', 'detect'],
    input: { kind: 'files', accept: null },
    output: 'none',
    preview: true,
    options: [],
    actionLabel: 'Fix extensions',
    async run(ctx) {
      const plan = [];
      const rows = [];
      for (const file of ctx.files) {
        const detected = detectType(await readHead(file));
        const e = ext(file);
        if (!detected.ext || detected.ext === 'txt' || detected.ext === 'json') continue;
        if (compatible(e, detected.ext)) continue;
        const target = await uniquePath(path.join(path.dirname(file), `${e ? baseName(file) : path.basename(file)}.${detected.ext}`));
        plan.push({ from: file, to: target });
        rows.push([path.basename(file), detected.label, path.basename(target)]);
      }
      const table = { title: `${plan.length} mismatched file(s)`, columns: ['File', 'Real type', 'New name'], rows };
      if (ctx.options.dryRun || !plan.length) return { dryRun: Boolean(ctx.options.dryRun && plan.length), table, summary: plan.length ? `${plan.length} file(s) to fix` : 'All extensions are correct ✅' };
      for (const p of plan) await fsp.rename(p.from, p.to);
      return { outputs: plan.map((p) => p.to), table, summary: `${plan.length} file(s) renamed` };
    },
  },
];

module.exports = {
  category: { id: 'files', name: 'File Manager', icon: '🗂️', color: ['#4facfe', '#00f2fe'], description: 'Rename, dedupe, organize, split and inspect' },
  tools,
  detectType,
};
