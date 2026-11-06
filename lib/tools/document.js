const fsp = require('fs').promises;
const path = require('path');
const { ext, baseName, escapeHtml, formatBytes, tempDir, removeQuiet } = require('../core/util');
const { DOC_IN, TEXT_IN } = require('../core/formats');
const { toPdf } = require('../core/render');
const { run: runFfmpeg } = require('../core/ffmpeg');
const o = require('../core/opts');

const THEMES = {
  github: `body{font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2328;max-width:860px;margin:0 auto;padding:32px}h1,h2{border-bottom:1px solid #d8dee4;padding-bottom:.3em}h1,h2,h3,h4{margin:1.4em 0 .6em;line-height:1.25}code{font-family:Consolas,'Cascadia Code',monospace;background:#eff1f3;padding:.15em .4em;border-radius:6px;font-size:85%}pre{background:#f6f8fa;padding:14px 16px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}blockquote{color:#59636e;border-left:.25em solid #d1d9e0;margin:0;padding:0 1em}table{border-collapse:collapse;margin:1em 0}td,th{border:1px solid #d1d9e0;padding:6px 13px}tr:nth-child(2n){background:#f6f8fa}img{max-width:100%}a{color:#0969da}hr{border:0;border-top:1px solid #d1d9e0;margin:24px 0}`,
  serif: `body{font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.7;color:#222;max-width:760px;margin:0 auto;padding:40px}h1,h2,h3{font-family:'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.25;margin:1.5em 0 .5em}code,pre{font-family:Consolas,monospace;font-size:14px}pre{background:#f4f4f4;padding:14px;border-radius:6px;overflow:auto}blockquote{font-style:italic;border-left:3px solid #ccc;margin:0;padding-left:1em;color:#555}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}img{max-width:100%}`,
  minimal: `body{font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#111;margin:0;padding:24px}pre{white-space:pre-wrap}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}`,
  dark: `body{font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#e6e6ef;background:#0d1117;max-width:860px;margin:0 auto;padding:32px}h1,h2{border-bottom:1px solid #30363d;padding-bottom:.3em}a{color:#4493f8}code{font-family:Consolas,monospace;background:#1f2630;padding:.15em .4em;border-radius:6px}pre{background:#161b22;padding:14px;border-radius:8px;overflow:auto}pre code{background:none}blockquote{color:#9198a1;border-left:.25em solid #3d444d;margin:0;padding:0 1em}table{border-collapse:collapse}td,th{border:1px solid #3d444d;padding:6px 13px}img{max-width:100%}`,
};

function markedParse(markdown) {
  const { marked } = require('marked');
  return marked.parse(markdown, { gfm: true, breaks: false });
}

function wrapHtml(body, title, theme = 'github', extraCss = '') {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${THEMES[theme] || THEMES.github}${extraCss}</style></head><body>${body}</body></html>`;
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function turndown(html) {
  const TurndownService = require('turndown');
  const { gfm } = require('turndown-plugin-gfm');
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  service.use(gfm);
  return service.turndown(html);
}

async function readText(file) {
  const buf = await fsp.readFile(file);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return require('iconv-lite').decode(buf.subarray(2), 'utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return require('iconv-lite').decode(buf.subarray(2), 'utf16be');
  const text = buf.toString('utf8');
  if (text.includes('�')) {
    const detected = require('chardet').detect(buf);
    if (detected && require('iconv-lite').encodingExists(detected)) return require('iconv-lite').decode(buf, detected);
  }
  return text;
}

async function load(file) {
  const e = ext(file);
  if (e === 'docx') {
    const mammoth = require('mammoth');
    const { value } = await mammoth.convertToHtml({ path: file });
    return { kind: 'docx', html: value, full: false };
  }
  const text = await readText(file);
  if (e === 'md' || e === 'markdown') return { kind: 'md', html: markedParse(text), source: text, full: false };
  if (e === 'html' || e === 'htm' || e === 'xhtml') return { kind: 'html', html: text, source: text, full: /<html|<body|<!doctype/i.test(text) };
  return { kind: 'txt', html: `<pre style="white-space:pre-wrap;font-family:Consolas,'Cascadia Code',monospace;font-size:13px">${escapeHtml(text)}</pre>`, source: text, full: false };
}

async function docxFromHtml(html, title) {
  const mod = require('html-to-docx');
  const fn = typeof mod === 'function' ? mod : mod.default;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return fn(body ? body[1] : html, null, { title, font: 'Calibri', fontSize: 22, table: { row: { cantSplit: true } }, footer: false, pageNumber: false });
}

const PDF_OPTS = [
  o.select('pageSize', 'Page size', ['A4', 'Letter', 'A3', 'A5', 'Legal'].map((s) => [s, s]), 'A4', o.when('format', 'pdf')),
  o.select('margins', 'Margins', [['none', 'None'], ['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']], 'normal', o.when('format', 'pdf')),
  o.checkbox('landscape', 'Landscape', false, o.when('format', 'pdf')),
];

function countStats(text) {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  const sentences = text.split(/[.!?…]+(?:\s|$)/).filter((s) => s.trim().length > 1).length;
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
  const freq = new Map();
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw.length < 4) continue;
    freq.set(lw, (freq.get(lw) || 0) + 1);
  }
  const top = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return {
    chars: [...text].length,
    charsNoSpaces: [...text.replace(/\s/g, '')].length,
    words: words.length,
    lines: text ? text.split(/\r\n|\r|\n/).length : 0,
    sentences,
    paragraphs,
    readingMin: words.length / 230,
    speakingMin: words.length / 140,
    top,
  };
}

const ENCODINGS = [
  ['utf8', 'UTF-8'],
  ['utf8bom', 'UTF-8 with BOM'],
  ['utf16le', 'UTF-16 LE'],
  ['utf16be', 'UTF-16 BE'],
  ['windows1252', 'Windows-1252 (Western)'],
  ['iso88591', 'ISO-8859-1 (Latin-1)'],
  ['iso885915', 'ISO-8859-15 (Latin-9)'],
  ['windows1251', 'Windows-1251 (Cyrillic)'],
  ['koi8r', 'KOI8-R'],
  ['shiftjis', 'Shift_JIS'],
  ['eucjp', 'EUC-JP'],
  ['gbk', 'GBK (Chinese)'],
  ['big5', 'Big5'],
  ['euckr', 'EUC-KR'],
  ['ascii', 'ASCII'],
];

const tools = [
  {
    id: 'doc.convert',
    name: 'Convert documents',
    icon: '🔄',
    description: 'Markdown, HTML, Word (DOCX) and text to PDF, DOCX, HTML, Markdown or plain text.',
    keywords: ['md to pdf', 'docx to pdf', 'html to pdf', 'word to pdf', 'markdown', 'txt to pdf', 'md to docx', 'html to markdown'],
    input: { kind: 'files', accept: DOC_IN },
    options: [
      o.select('format', 'Output format', [['pdf', 'PDF'], ['docx', 'Word DOCX'], ['html', 'HTML'], ['md', 'Markdown'], ['txt', 'Text']], 'pdf'),
      o.select('theme', 'Style', [['github', 'GitHub'], ['serif', 'Book (serif)'], ['minimal', 'Minimal'], ['dark', 'Dark']], 'github', o.when('format', ['pdf', 'html'])),
      ...PDF_OPTS,
      o.checkbox('scripts', 'Run scripts in HTML files', false, o.when('format', 'pdf')),
    ],
    actionLabel: 'Convert',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const doc = await load(file);
        const title = baseName(file);
        const out = await ctx.output(file, { extension: opt.format });
        const fullHtml = doc.full ? doc.html : wrapHtml(doc.html, title, opt.theme);
        if (opt.format === 'pdf') {
          ctx.stepProgress(0.3, 'Rendering PDF');
          const source = doc.kind === 'html' && doc.full ? { file } : { html: wrapHtml(doc.html, title, opt.theme === 'dark' ? 'github' : opt.theme, '@page{margin:0}body{max-width:none}'), baseDir: path.dirname(file) };
          await toPdf(source, out, { pageSize: opt.pageSize, margins: opt.margins, landscape: opt.landscape, javascript: opt.scripts });
        } else if (opt.format === 'html') {
          await fsp.writeFile(out, fullHtml, 'utf8');
        } else if (opt.format === 'md') {
          await fsp.writeFile(out, doc.kind === 'md' ? doc.source : doc.kind === 'txt' ? doc.source : turndown(doc.html), 'utf8');
        } else if (opt.format === 'txt') {
          let text;
          if (doc.kind === 'docx') text = (await require('mammoth').extractRawText({ path: file })).value;
          else if (doc.kind === 'txt') text = doc.source;
          else text = htmlToText(doc.html);
          await fsp.writeFile(out, text, 'utf8');
        } else if (opt.format === 'docx') {
          await fsp.writeFile(out, await docxFromHtml(doc.html, title));
        }
        return out;
      });
    },
  },
  {
    id: 'doc.encoding',
    name: 'Text encoding converter',
    icon: '🔤',
    description: 'Detect and convert text encodings (UTF-8, UTF-16, Windows-1252, Latin-1, Shift_JIS, GBK…). Fixes “Ã©” garbage.',
    keywords: ['utf-8', 'charset', 'bom', 'mojibake', 'ansi', 'latin1'],
    input: { kind: 'files', accept: TEXT_IN },
    options: [
      o.select('from', 'Source encoding', [['auto', 'Auto-detect'], ...ENCODINGS.filter(([v]) => v !== 'utf8bom')], 'auto'),
      o.select('to', 'Target encoding', ENCODINGS, 'utf8'),
      o.checkbox('inPlace', 'Overwrite original files', false),
    ],
    actionLabel: 'Convert',
    async run(ctx) {
      const iconv = require('iconv-lite');
      const chardet = require('chardet');
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const buf = await fsp.readFile(file);
        let from = opt.from;
        let body = buf;
        if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
          from = 'utf8';
          body = buf.subarray(3);
        } else if (buf[0] === 0xff && buf[1] === 0xfe) {
          from = 'utf16le';
          body = buf.subarray(2);
        } else if (buf[0] === 0xfe && buf[1] === 0xff) {
          from = 'utf16be';
          body = buf.subarray(2);
        } else if (from === 'auto') {
          from = chardet.detect(buf) || 'utf8';
        }
        if (!iconv.encodingExists(from)) throw new Error(`Unknown encoding ${from}`);
        const text = iconv.decode(body, from);
        const target = opt.to === 'utf8bom' ? 'utf8' : opt.to;
        let encoded = iconv.encode(text, target);
        if (opt.to === 'utf8bom') encoded = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]);
        if (target === 'utf16le' || target === 'utf16be') encoded = Buffer.concat([Buffer.from(target === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]), encoded]);
        const out = opt.inPlace ? file : await ctx.output(file, { suffix: `_${opt.to}` });
        await fsp.writeFile(out, encoded);
        return { outputs: out, note: `${path.basename(file)}: ${from} → ${ENCODINGS.find(([v]) => v === opt.to)[1]}` };
      });
    },
  },
  {
    id: 'doc.lineEndings',
    name: 'Line endings & whitespace',
    icon: '↩️',
    description: 'Convert CRLF/LF/CR, trim trailing spaces, tabs ↔ spaces, fix final newline.',
    keywords: ['crlf', 'lf', 'windows', 'unix', 'tabs', 'spaces', 'trailing'],
    input: { kind: 'files', accept: TEXT_IN },
    options: [
      o.select('eol', 'Line endings', [['keep', 'Keep'], ['lf', 'LF (Unix/macOS)'], ['crlf', 'CRLF (Windows)'], ['cr', 'CR (old Mac)']], 'lf'),
      o.select('indent', 'Indentation', [['keep', 'Keep'], ['spaces', 'Tabs → spaces'], ['tabs', 'Spaces → tabs']], 'keep'),
      o.number('tabSize', 'Tab size', 4, { min: 1, max: 8, showIf: { indent: ['spaces', 'tabs'] } }),
      o.checkbox('trim', 'Trim trailing whitespace', true),
      o.checkbox('finalNewline', 'Ensure final newline', true),
      o.checkbox('bom', 'Remove BOM', true),
      o.checkbox('inPlace', 'Overwrite original files', false),
    ],
    actionLabel: 'Apply',
    async run(ctx) {
      const opt = ctx.options;
      const eol = { lf: '\n', crlf: '\r\n', cr: '\r' }[opt.eol];
      return ctx.eachFile(async (file) => {
        let text = await fsp.readFile(file, 'utf8');
        const hadBom = text.charCodeAt(0) === 0xfeff;
        if (hadBom) text = text.slice(1);
        const original = /\r\n/.test(text) ? '\r\n' : /\r/.test(text) ? '\r' : '\n';
        let lines = text.split(/\r\n|\r|\n/);
        const size = Number(opt.tabSize) || 4;
        if (opt.indent === 'spaces') lines = lines.map((l) => l.replace(/^\t+/, (m) => ' '.repeat(m.length * size)));
        if (opt.indent === 'tabs') lines = lines.map((l) => l.replace(new RegExp(`^(?: {${size}})+`), (m) => '\t'.repeat(m.length / size)));
        if (opt.trim) lines = lines.map((l) => l.replace(/[ \t]+$/, ''));
        if (opt.finalNewline) {
          while (lines.length > 1 && lines[lines.length - 1] === '' && lines[lines.length - 2] === '') lines.pop();
          if (lines[lines.length - 1] !== '') lines.push('');
        }
        let result = lines.join(eol || original);
        if (hadBom && !opt.bom) result = `﻿${result}`;
        const out = opt.inPlace ? file : await ctx.output(file, { suffix: '_fixed' });
        await fsp.writeFile(out, result, 'utf8');
        return out;
      });
    },
  },
  {
    id: 'doc.stats',
    name: 'Word & character count',
    icon: '🔢',
    description: 'Words, characters, lines, sentences, reading time and most used words.',
    keywords: ['count words', 'characters', 'reading time', 'statistics'],
    input: { kind: 'files', accept: [...DOC_IN, ...TEXT_IN.filter((e) => !DOC_IN.includes(e))] },
    output: 'none',
    options: [],
    actionLabel: 'Count',
    async run(ctx) {
      const rows = [];
      const sections = [];
      const totals = { words: 0, chars: 0 };
      const result = await ctx.eachFile(async (file) => {
        let text;
        if (ext(file) === 'docx') text = (await require('mammoth').extractRawText({ path: file })).value;
        else if (['html', 'htm', 'xhtml'].includes(ext(file))) text = htmlToText(await readText(file));
        else text = await readText(file);
        const s = countStats(text);
        totals.words += s.words;
        totals.chars += s.chars;
        rows.push([path.basename(file), s.words.toLocaleString(), s.chars.toLocaleString(), s.charsNoSpaces.toLocaleString(), s.lines.toLocaleString(), s.sentences.toLocaleString(), s.paragraphs.toLocaleString(), `${Math.max(1, Math.round(s.readingMin))} min`]);
        if (ctx.files.length === 1 && s.top.length) sections.push({ title: 'Most frequent words', table: { columns: ['Word', 'Count'], rows: s.top } });
        return null;
      });
      result.table = { title: 'Statistics', columns: ['File', 'Words', 'Characters', 'No spaces', 'Lines', 'Sentences', 'Paragraphs', 'Reading'], rows };
      result.sections = sections;
      if (ctx.files.length > 1) result.summary = `${totals.words.toLocaleString()} words in total`;
      return result;
    },
  },
  {
    id: 'doc.findReplace',
    name: 'Find & replace in files',
    icon: '🔎',
    description: 'Search and replace text across many files at once, with regex support and preview.',
    keywords: ['search', 'replace', 'regex', 'batch edit', 'sed'],
    input: { kind: 'files', accept: TEXT_IN },
    preview: true,
    options: [
      o.text('find', 'Find', '', { required: true, wide: true }),
      o.text('replace', 'Replace with', '', { wide: true }),
      o.checkbox('regex', 'Regular expression', false),
      o.checkbox('caseSensitive', 'Case sensitive', false),
      o.checkbox('wholeWord', 'Whole words only', false),
      o.checkbox('inPlace', 'Modify files in place', false),
    ],
    actionLabel: 'Replace',
    async run(ctx) {
      const opt = ctx.options;
      let source = opt.regex ? opt.find : opt.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (opt.wholeWord) source = `\\b(?:${source})\\b`;
      let re;
      try {
        re = new RegExp(source, `g${opt.caseSensitive ? '' : 'i'}u`);
      } catch (error) {
        throw new Error(`Invalid regular expression: ${error.message}`);
      }
      const rows = [];
      let totalHits = 0;
      const result = await ctx.eachFile(async (file) => {
        const text = await fsp.readFile(file, 'utf8');
        const matches = text.match(re) || [];
        totalHits += matches.length;
        if (opt.dryRun) {
          const firstIdx = text.search(re);
          const snippet = firstIdx >= 0 ? text.slice(Math.max(0, firstIdx - 30), firstIdx + 60).replace(/\s+/g, ' ') : '';
          rows.push([path.basename(file), matches.length, snippet]);
          return null;
        }
        if (!matches.length) return { note: `${path.basename(file)}: no match` };
        const replaced = text.replace(re, opt.regex ? opt.replace : () => opt.replace);
        const out = opt.inPlace ? file : await ctx.output(file, { suffix: '_edited' });
        await fsp.writeFile(out, replaced, 'utf8');
        return { outputs: out, note: `${path.basename(file)}: ${matches.length} replacement(s)` };
      });
      if (opt.dryRun) {
        result.table = { title: 'Matches', columns: ['File', 'Matches', 'First match context'], rows };
        result.dryRun = true;
      }
      result.summary = `${totalHits} match${totalHits === 1 ? '' : 'es'}`;
      return result;
    },
  },
  {
    id: 'doc.mergeText',
    name: 'Merge text files',
    icon: '🧵',
    description: 'Concatenate text, Markdown, CSV, log or code files into a single file.',
    keywords: ['concatenate', 'combine', 'join', 'cat'],
    input: { kind: 'files', accept: TEXT_IN, min: 2, ordered: true },
    options: [
      o.checkbox('headers', 'Add file name headers', true),
      o.select('separator', 'Separator', [['blank', 'Blank line'], ['line', '──── line'], ['none', 'None']], 'blank'),
      o.text('name', 'Output name', 'merged'),
    ],
    actionLabel: 'Merge',
    async run(ctx) {
      const opt = ctx.options;
      const parts = [];
      for (let i = 0; i < ctx.files.length; i++) {
        ctx.check();
        ctx.progress((i / ctx.files.length) * 100);
        const text = (await readText(ctx.files[i])).replace(/\s+$/, '');
        parts.push(opt.headers ? `===== ${path.basename(ctx.files[i])} =====\n${text}` : text);
      }
      const sep = { blank: '\n\n', line: '\n\n────────────────────────\n\n', none: '\n' }[opt.separator];
      const out = await ctx.output(ctx.files[0], { name: opt.name || 'merged' });
      await fsp.writeFile(out, `${parts.join(sep)}\n`, 'utf8');
      return { outputs: [out], summary: `${ctx.files.length} files merged` };
    },
  },
  {
    id: 'doc.case',
    name: 'Change text case',
    icon: '🔠',
    description: 'UPPERCASE, lowercase, Title Case, Sentence case, camelCase, snake_case or kebab-case.',
    keywords: ['uppercase', 'lowercase', 'capitalize', 'title case', 'camelcase'],
    input: { kind: 'files', accept: TEXT_IN },
    options: [o.select('mode', 'Case', [['upper', 'UPPER'], ['lower', 'lower'], ['title', 'Title Case'], ['sentence', 'Sentence case'], ['camel', 'camelCase'], ['snake', 'snake_case'], ['kebab', 'kebab-case'], ['invert', 'iNVERT']], 'title')],
    actionLabel: 'Apply',
    async run(ctx) {
      const mode = ctx.options.mode;
      const words = (s) => s.match(/[\p{L}\p{N}]+/gu) || [];
      const fns = {
        upper: (t) => t.toUpperCase(),
        lower: (t) => t.toLowerCase(),
        title: (t) => t.toLowerCase().replace(/(^|[\s\-("'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()),
        sentence: (t) => t.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()),
        camel: (t) => t.split('\n').map((line) => words(line).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('')).join('\n'),
        snake: (t) => t.split('\n').map((line) => words(line).map((w) => w.toLowerCase()).join('_')).join('\n'),
        kebab: (t) => t.split('\n').map((line) => words(line).map((w) => w.toLowerCase()).join('-')).join('\n'),
        invert: (t) => [...t].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''),
      };
      return ctx.eachFile(async (file) => {
        const out = await ctx.output(file, { suffix: `_${mode}` });
        await fsp.writeFile(out, fns[mode](await readText(file)), 'utf8');
        return out;
      });
    },
  },
  {
    id: 'doc.subtitles',
    name: 'Subtitle converter & sync',
    icon: '💬',
    description: 'Convert SRT ↔ VTT ↔ ASS and shift subtitle timing forward or backward.',
    keywords: ['srt', 'vtt', 'ass', 'subtitles', 'sync', 'delay', 'offset'],
    input: { kind: 'files', accept: ['srt', 'vtt', 'ass', 'ssa', 'sub', 'sbv'] },
    options: [
      o.select('format', 'Output format', [['srt', 'SRT'], ['vtt', 'WebVTT'], ['ass', 'ASS']], 'srt'),
      o.number('shift', 'Shift timing (seconds, negative = earlier)', 0, { step: 0.1 }),
    ],
    actionLabel: 'Convert',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const out = await ctx.output(file, { suffix: Number(opt.shift) ? '_synced' : '', extension: opt.format });
        const shift = Number(opt.shift) || 0;
        await runFfmpeg(ctx, [...(shift ? ['-itsoffset', String(shift)] : []), '-i', file, out]);
        return out;
      });
    },
  },
];

module.exports = {
  category: { id: 'document', name: 'Documents', icon: '📝', color: ['#11998e', '#38ef7d'], description: 'Word, Markdown, HTML and text conversion & editing' },
  tools,
  wrapHtml,
  htmlToText,
  readText,
};
