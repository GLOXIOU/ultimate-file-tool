const fsp = require('fs').promises;
const path = require('path');
const { ext, baseName, escapeHtml } = require('../core/util');
const { SHEET_IN, DATA_IN } = require('../core/formats');
const { toPdf } = require('../core/render');
const { readText } = require('./document');
const o = require('../core/opts');

function XLSX() {
  return require('xlsx');
}

function parseCsv(text, delimiter = '') {
  const Papa = require('papaparse');
  const res = Papa.parse(text.replace(/^﻿/, ''), { delimiter, skipEmptyLines: 'greedy' });
  return { rows: res.data, delimiter: res.meta.delimiter };
}

function unparseCsv(rows, delimiter = ',') {
  return require('papaparse').unparse(rows, { delimiter, newline: '\r\n' });
}

async function readWorkbook(file) {
  const X = XLSX();
  const e = ext(file);
  if (e === 'json') {
    const data = JSON.parse(await readText(file));
    const wb = X.utils.book_new();
    if (Array.isArray(data)) X.utils.book_append_sheet(wb, X.utils.json_to_sheet(data.map(flatten)), 'Sheet1');
    else
      for (const [name, value] of Object.entries(data)) {
        if (Array.isArray(value)) X.utils.book_append_sheet(wb, X.utils.json_to_sheet(value.map(flatten)), name.slice(0, 31));
      }
    if (!wb.SheetNames.length) throw new Error('JSON must be an array of objects (or an object of arrays)');
    return wb;
  }
  if (e === 'csv' || e === 'tsv') {
    const { rows } = parseCsv(await readText(file), e === 'tsv' ? '\t' : '');
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), 'Sheet1');
    return wb;
  }
  return X.read(await fsp.readFile(file), { type: 'buffer', cellDates: true, dense: true });
}

function sheetRows(ws) {
  return XLSX().utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
}

function flatten(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object' || obj instanceof Date) {
    out[prefix || 'value'] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? (v.every((x) => x === null || typeof x !== 'object') ? v.join('; ') : JSON.stringify(v)) : v;
  }
  return out;
}

function rowsToObjects(rows) {
  const [header = [], ...body] = rows;
  const keys = header.map((h, i) => String(h || `column${i + 1}`));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

function markdownTable(rows) {
  if (!rows.length) return '';
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => Array.from({ length: width }, (_, i) => esc(r[i]));
  return [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)].join('\n');
}

function sqlInserts(rows, table) {
  if (rows.length < 2) return '';
  const cols = rows[0].map((c, i) => `"${String(c || `column${i + 1}`).replace(/"/g, '""')}"`);
  const value = (v) => {
    if (v === '' || v === null || v === undefined) return 'NULL';
    if (/^-?\d+(\.\d+)?$/.test(String(v))) return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const name = `"${String(table || 'data').replace(/"/g, '""')}"`;
  const create = `CREATE TABLE IF NOT EXISTS ${name} (${cols.map((c) => `${c} TEXT`).join(', ')});`;
  return [create, ...rows.slice(1).map((r) => `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map((_, i) => value(r[i])).join(', ')});`)].join('\n');
}

function htmlTables(wb, names) {
  const X = XLSX();
  return names.map((n) => `<h2>${escapeHtml(n)}</h2>${X.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' })}`).join('\n');
}

const TABLE_CSS = 'body{font-family:Segoe UI,Arial,sans-serif;font-size:12px;padding:16px;color:#222}h2{font-size:15px;margin:18px 0 8px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 7px;text-align:left}tr:nth-child(2n){background:#f6f6f6}tr:first-child{font-weight:600;background:#eaeaea}';

function parseIni(text) {
  const result = {};
  let section = result;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = result[sec[1]] = result[sec[1]] || {};
      continue;
    }
    const idx = line.indexOf('=');
    if (idx > 0) section[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return result;
}

function stringifyIni(data) {
  const lines = [];
  const top = Object.entries(data).filter(([, v]) => v === null || typeof v !== 'object');
  for (const [k, v] of top) lines.push(`${k}=${v ?? ''}`);
  for (const [k, v] of Object.entries(data)) {
    if (v === null || typeof v !== 'object') continue;
    lines.push('', `[${k}]`);
    for (const [k2, v2] of Object.entries(Array.isArray(v) ? Object.assign({}, v) : v)) lines.push(`${k2}=${typeof v2 === 'object' && v2 !== null ? JSON.stringify(v2) : v2 ?? ''}`);
  }
  return `${lines.join('\n').trim()}\n`;
}

function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) out[k] = stripNulls(v);
    return out;
  }
  return value;
}

async function parseData(file) {
  const e = ext(file);
  const text = await readText(file);
  switch (e) {
    case 'json':
      return JSON.parse(text);
    case 'jsonl':
    case 'ndjson':
      return text.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
        try {
          return JSON.parse(l);
        } catch (error) {
          throw new Error(`Line ${i + 1}: ${error.message}`);
        }
      });
    case 'yaml':
    case 'yml': {
      const yaml = require('js-yaml');
      const docs = yaml.loadAll(text);
      return docs.length === 1 ? docs[0] : docs;
    }
    case 'xml': {
      const { XMLParser, XMLValidator } = require('fast-xml-parser');
      const valid = XMLValidator.validate(text);
      if (valid !== true) throw new Error(`Invalid XML: ${valid.err.msg} (line ${valid.err.line})`);
      return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: true, trimValues: true }).parse(text);
    }
    case 'toml':
      return require('smol-toml').parse(text);
    case 'csv':
    case 'tsv':
      return rowsToObjects(parseCsv(text, e === 'tsv' ? '\t' : '').rows);
    case 'ini':
      return parseIni(text);
    default:
      throw new Error(`Unsupported data format .${e}`);
  }
}

function serializeData(data, format, { indent = 2 } = {}) {
  const space = indent === 'tab' ? '\t' : Number(indent);
  switch (format) {
    case 'json':
      return JSON.stringify(data, null, space);
    case 'jsonl': {
      const list = Array.isArray(data) ? data : [data];
      return `${list.map((x) => JSON.stringify(x)).join('\n')}\n`;
    }
    case 'yaml':
      return require('js-yaml').dump(data, { indent: typeof space === 'number' ? space : 2, lineWidth: 120, noRefs: true });
    case 'xml': {
      const { XMLBuilder } = require('fast-xml-parser');
      let root = data;
      if (Array.isArray(data)) root = { root: { item: data } };
      else if (!data || typeof data !== 'object' || Object.keys(data).filter((k) => !k.startsWith('?')).length !== 1) root = { root: data };
      return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, indentBy: typeof space === 'number' ? ' '.repeat(space) : '\t', suppressEmptyNode: true }).build(root)}`;
    }
    case 'toml': {
      const toml = require('smol-toml');
      const clean = stripNulls(data);
      return toml.stringify(Array.isArray(clean) ? { items: clean } : typeof clean === 'object' ? clean : { value: clean });
    }
    case 'csv':
    case 'tsv': {
      let list = data;
      if (!Array.isArray(list) && list && typeof list === 'object') {
        const arrays = Object.values(list).filter(Array.isArray);
        list = arrays.length === 1 ? arrays[0] : [list];
      }
      const flat = (Array.isArray(list) ? list : [list]).map((item) => flatten(item));
      const keys = [...new Set(flat.flatMap((r) => Object.keys(r)))];
      return unparseCsv([keys, ...flat.map((r) => keys.map((k) => (r[k] instanceof Date ? r[k].toISOString() : r[k] ?? '')))], format === 'tsv' ? '\t' : ',');
    }
    case 'ini':
      return stringifyIni(data && typeof data === 'object' && !Array.isArray(data) ? data : { items: data });
    default:
      throw new Error(`Unsupported output ${format}`);
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}

const tools = [
  {
    id: 'data.sheet',
    name: 'Convert spreadsheets',
    icon: '📊',
    description: 'Excel (XLSX, XLS, XLSB), OpenDocument (ODS), Numbers, CSV, TSV, JSON to Excel, ODS, CSV, JSON, HTML, Markdown, SQL or PDF.',
    keywords: ['xlsx to csv', 'csv to xlsx', 'excel', 'ods', 'numbers', 'sql', 'json to excel', 'excel to pdf'],
    input: { kind: 'files', accept: SHEET_IN },
    options: [
      o.select('format', 'Output format', [['xlsx', 'Excel XLSX'], ['csv', 'CSV'], ['tsv', 'TSV'], ['json', 'JSON'], ['ods', 'OpenDocument ODS'], ['xls', 'Excel 97 XLS'], ['html', 'HTML table'], ['md', 'Markdown table'], ['sql', 'SQL inserts'], ['pdf', 'PDF']], 'xlsx'),
      o.select('sheets', 'Sheets', [['first', 'First sheet'], ['all', 'All sheets']], 'all', o.when('format', ['csv', 'tsv', 'json', 'html', 'md', 'sql', 'pdf'])),
      o.select('delimiter', 'Delimiter', [[',', 'Comma'], [';', 'Semicolon'], ['|', 'Pipe']], ',', o.when('format', 'csv')),
      o.text('table', 'SQL table name', 'data', o.when('format', 'sql')),
    ],
    actionLabel: 'Convert',
    async run(ctx) {
      const X = XLSX();
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const wb = await readWorkbook(file);
        const names = opt.sheets === 'first' && !['xlsx', 'ods', 'xls'].includes(opt.format) ? wb.SheetNames.slice(0, 1) : wb.SheetNames;
        if (['xlsx', 'ods', 'xls'].includes(opt.format)) {
          const out = await ctx.output(file, { extension: opt.format });
          X.writeFile(wb, out, { bookType: opt.format === 'xls' ? 'biff8' : opt.format, compression: true });
          return out;
        }
        if (opt.format === 'html' || opt.format === 'pdf') {
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(baseName(file))}</title><style>${TABLE_CSS}</style></head><body>${htmlTables(wb, names)}</body></html>`;
          const out = await ctx.output(file, { extension: opt.format });
          if (opt.format === 'html') await fsp.writeFile(out, html, 'utf8');
          else await toPdf({ html }, out, { landscape: true, margins: 'narrow' });
          return out;
        }
        if (opt.format === 'json') {
          const data = names.length === 1 ? X.utils.sheet_to_json(wb.Sheets[names[0]], { defval: null, raw: true }) : Object.fromEntries(names.map((n) => [n, X.utils.sheet_to_json(wb.Sheets[n], { defval: null, raw: true })]));
          const out = await ctx.output(file, { extension: 'json' });
          await fsp.writeFile(out, JSON.stringify(data, null, 2), 'utf8');
          return out;
        }
        const outputs = [];
        for (const name of names) {
          const rows = sheetRows(wb.Sheets[name]);
          let content;
          if (opt.format === 'csv') content = `﻿${unparseCsv(rows, opt.delimiter)}`;
          else if (opt.format === 'tsv') content = unparseCsv(rows, '\t');
          else if (opt.format === 'md') content = markdownTable(rows);
          else content = sqlInserts(rows, names.length > 1 ? `${opt.table}_${name}` : opt.table);
          const out = await ctx.output(file, { suffix: names.length > 1 ? `_${name.replace(/[^\w.-]+/g, '_')}` : '', extension: opt.format });
          await fsp.writeFile(out, content, 'utf8');
          outputs.push(out);
        }
        return outputs;
      });
    },
  },
  {
    id: 'data.view',
    name: 'View spreadsheet / CSV',
    icon: '👀',
    description: 'Preview the first rows of any spreadsheet or CSV without opening Excel.',
    keywords: ['preview', 'open', 'read', 'table', 'viewer'],
    input: { kind: 'file', accept: SHEET_IN },
    output: 'none',
    options: [o.number('limit', 'Rows to show', 200, { min: 1, max: 5000 })],
    actionLabel: 'Open',
    async run(ctx) {
      const wb = await readWorkbook(ctx.file);
      const sections = wb.SheetNames.slice(0, 10).map((name) => {
        const rows = sheetRows(wb.Sheets[name]);
        const width = Math.max(1, ...rows.slice(0, 1).map((r) => r.length));
        const header = (rows[0] || []).map((c, i) => String(c || `#${i + 1}`));
        while (header.length < width) header.push(`#${header.length + 1}`);
        return { title: `${name} · ${Math.max(0, rows.length - 1).toLocaleString()} rows × ${header.length} columns`, table: { columns: header, rows: rows.slice(1, 1 + Number(ctx.options.limit)) } };
      });
      return { sections, summary: `${wb.SheetNames.length} sheet(s)` };
    },
  },
  {
    id: 'data.convert',
    name: 'Convert data formats',
    icon: '🔁',
    description: 'JSON, YAML, XML, TOML, CSV, TSV, JSON Lines and INI, converted in any direction.',
    keywords: ['json to yaml', 'yaml to json', 'xml to json', 'json to csv', 'toml', 'csv to json', 'jsonl', 'ini'],
    input: { kind: 'files', accept: DATA_IN },
    options: [
      o.select('format', 'Output format', [['json', 'JSON'], ['yaml', 'YAML'], ['xml', 'XML'], ['toml', 'TOML'], ['csv', 'CSV'], ['tsv', 'TSV'], ['jsonl', 'JSON Lines'], ['ini', 'INI']], 'yaml'),
      o.select('indent', 'Indentation', [['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'Tab']], '2', o.when('format', ['json', 'yaml', 'xml'])),
    ],
    actionLabel: 'Convert',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const data = await parseData(file);
        const out = await ctx.output(file, { extension: opt.format === 'yaml' && ext(file) === 'yml' ? 'yml' : opt.format });
        await fsp.writeFile(out, serializeData(data, opt.format, { indent: opt.indent }), 'utf8');
        return out;
      });
    },
  },
  {
    id: 'data.jsonFormat',
    name: 'JSON formatter & validator',
    icon: '🧹',
    description: 'Validate, prettify, minify and sort keys of JSON files, with precise error positions.',
    keywords: ['beautify', 'pretty print', 'minify', 'lint', 'validate', 'json'],
    input: { kind: 'files', accept: ['json', 'geojson', 'webmanifest', 'jsonc', 'har'] },
    options: [
      o.select('mode', 'Mode', [['pretty', 'Prettify'], ['minify', 'Minify'], ['validate', 'Validate only']], 'pretty'),
      o.select('indent', 'Indentation', [['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'Tab']], '2', o.when('mode', 'pretty')),
      o.checkbox('sort', 'Sort keys alphabetically', false, o.when('mode', ['pretty', 'minify'])),
      o.checkbox('inPlace', 'Overwrite original files', false, o.when('mode', ['pretty', 'minify'])),
    ],
    actionLabel: 'Format',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const text = await readText(file);
        let data;
        try {
          data = JSON.parse(text);
        } catch (error) {
          const pos = Number((/position (\d+)/.exec(error.message) || [])[1]);
          if (Number.isFinite(pos)) {
            const before = text.slice(0, pos);
            const line = before.split('\n').length;
            const col = pos - before.lastIndexOf('\n');
            throw new Error(`Invalid JSON at line ${line}, column ${col}: ${error.message.replace(/ in JSON at position \d+.*$/, '')}`);
          }
          throw new Error(`Invalid JSON: ${error.message}`);
        }
        if (opt.mode === 'validate') return { note: `✅ ${path.basename(file)} is valid JSON` };
        if (opt.sort) data = sortKeys(data);
        const output = opt.mode === 'minify' ? JSON.stringify(data) : JSON.stringify(data, null, opt.indent === 'tab' ? '\t' : Number(opt.indent));
        const out = opt.inPlace ? file : await ctx.output(file, { suffix: opt.mode === 'minify' ? '.min' : '_pretty' });
        await fsp.writeFile(out, output, 'utf8');
        return { outputs: out, note: `${path.basename(file)}: ${text.length.toLocaleString()} → ${output.length.toLocaleString()} chars` };
      });
    },
  },
  {
    id: 'data.csvClean',
    name: 'Clean CSV',
    icon: '🧽',
    description: 'Change delimiter, remove duplicate or empty rows, trim cells, keep selected columns.',
    keywords: ['csv', 'dedupe', 'duplicates', 'delimiter', 'semicolon', 'columns'],
    input: { kind: 'files', accept: ['csv', 'tsv', 'txt'] },
    options: [
      o.select('delimiter', 'Output delimiter', [[',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab'], ['|', 'Pipe']], ','),
      o.checkbox('dedupe', 'Remove duplicate rows', true),
      o.checkbox('empty', 'Remove empty rows', true),
      o.checkbox('trim', 'Trim cell whitespace', true),
      o.text('columns', 'Keep only these columns (comma separated, empty = all)', '', { wide: true }),
      o.text('sortBy', 'Sort by column (optional)', ''),
    ],
    actionLabel: 'Clean',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        let { rows } = parseCsv(await readText(file));
        const before = rows.length;
        if (opt.trim) rows = rows.map((r) => r.map((c) => String(c).trim()));
        if (opt.empty) rows = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
        let header = rows[0] || [];
        let body = rows.slice(1);
        if (opt.columns.trim()) {
          const wanted = opt.columns.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
          const idx = wanted.map((w) => header.findIndex((h) => String(h).trim().toLowerCase() === w));
          if (idx.some((i) => i < 0)) throw new Error(`Unknown column(s): ${wanted.filter((_, k) => idx[k] < 0).join(', ')}`);
          header = idx.map((i) => header[i]);
          body = body.map((r) => idx.map((i) => r[i] ?? ''));
        }
        if (opt.dedupe) {
          const seen = new Set();
          body = body.filter((r) => {
            const key = JSON.stringify(r);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (opt.sortBy.trim()) {
          const i = header.findIndex((h) => String(h).trim().toLowerCase() === opt.sortBy.trim().toLowerCase());
          if (i < 0) throw new Error(`Unknown sort column ${opt.sortBy}`);
          body.sort((a, b) => String(a[i]).localeCompare(String(b[i]), undefined, { numeric: true }));
        }
        const out = await ctx.output(file, { suffix: '_clean', extension: opt.delimiter === '\t' ? 'tsv' : 'csv' });
        await fsp.writeFile(out, unparseCsv([header, ...body], opt.delimiter), 'utf8');
        return { outputs: out, note: `${path.basename(file)}: ${before} → ${body.length + 1} rows` };
      });
    },
  },
  {
    id: 'data.csvMerge',
    name: 'Merge CSV files',
    icon: '🔗',
    description: 'Stack many CSV files into one, aligning columns by header name.',
    keywords: ['combine', 'append', 'union', 'concat csv'],
    input: { kind: 'files', accept: ['csv', 'tsv'], min: 2, ordered: true },
    options: [o.checkbox('source', 'Add a "source_file" column', true), o.text('name', 'Output name', 'merged')],
    actionLabel: 'Merge',
    async run(ctx) {
      const all = [];
      const headers = [];
      for (const file of ctx.files) {
        const { rows } = parseCsv(await readText(file), ext(file) === 'tsv' ? '\t' : '');
        const objects = rowsToObjects(rows);
        for (const k of rows[0] || []) if (!headers.includes(String(k))) headers.push(String(k));
        for (const obj of objects) all.push(ctx.options.source ? { ...obj, source_file: path.basename(file) } : obj);
      }
      if (ctx.options.source) headers.push('source_file');
      const out = await ctx.output(ctx.files[0], { name: ctx.options.name || 'merged', extension: 'csv' });
      await fsp.writeFile(out, unparseCsv([headers, ...all.map((r) => headers.map((h) => r[h] ?? ''))]), 'utf8');
      return { outputs: [out], summary: `${all.length.toLocaleString()} rows, ${headers.length} columns` };
    },
  },
  {
    id: 'data.csvSplit',
    name: 'Split CSV',
    icon: '🪓',
    description: 'Split a large CSV into chunks of N rows or one file per value of a column.',
    keywords: ['chunk', 'divide', 'large csv', 'group by'],
    input: { kind: 'files', accept: ['csv', 'tsv'] },
    options: [
      o.select('mode', 'Split by', [['rows', 'Number of rows'], ['column', 'Column value']], 'rows'),
      o.number('rows', 'Rows per file', 1000, { min: 1, ...o.when('mode', 'rows') }),
      o.text('column', 'Column name', '', o.when('mode', 'column')),
    ],
    actionLabel: 'Split',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const delimiter = ext(file) === 'tsv' ? '\t' : '';
        const { rows, delimiter: detected } = parseCsv(await readText(file), delimiter);
        const [header, ...body] = rows;
        const dir = await ctx.outputFolder(file, '_split');
        const groups = new Map();
        if (opt.mode === 'rows') {
          const n = Math.max(1, Number(opt.rows));
          for (let i = 0; i < body.length; i += n) groups.set(String(i / n + 1).padStart(String(Math.ceil(body.length / n)).length, '0'), body.slice(i, i + n));
        } else {
          const idx = header.findIndex((h) => String(h).trim().toLowerCase() === String(opt.column).trim().toLowerCase());
          if (idx < 0) throw new Error(`Column "${opt.column}" not found`);
          for (const r of body) {
            const key = String(r[idx] ?? '').trim() || 'empty';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(r);
          }
        }
        const outputs = [];
        for (const [key, chunk] of groups) {
          const target = path.join(dir, `${baseName(file)}_${key.replace(/[<>:"/\\|?*\s]+/g, '_').slice(0, 60)}.${ext(file)}`);
          await fsp.writeFile(target, unparseCsv([header, ...chunk], detected || ','), 'utf8');
          outputs.push(target);
        }
        return outputs;
      });
    },
  },
  {
    id: 'data.sheetMerge',
    name: 'Merge workbooks',
    icon: '📚',
    description: 'Combine several Excel/ODS/CSV files into one workbook, one sheet per source.',
    keywords: ['combine excel', 'merge sheets', 'workbook'],
    input: { kind: 'files', accept: SHEET_IN, min: 2, ordered: true },
    options: [o.select('format', 'Output', [['xlsx', 'XLSX'], ['ods', 'ODS']], 'xlsx'), o.text('name', 'Output name', 'merged')],
    actionLabel: 'Merge',
    async run(ctx) {
      const X = XLSX();
      const out = X.utils.book_new();
      const used = new Set();
      for (const file of ctx.files) {
        const wb = await readWorkbook(file);
        for (const name of wb.SheetNames) {
          let sheetName = (wb.SheetNames.length > 1 ? `${baseName(file)}-${name}` : baseName(file)).replace(/[\\/?*[\]:]/g, '_').slice(0, 31);
          let n = 2;
          while (used.has(sheetName.toLowerCase())) sheetName = `${sheetName.slice(0, 28)}_${n++}`;
          used.add(sheetName.toLowerCase());
          X.utils.book_append_sheet(out, wb.Sheets[name], sheetName);
        }
      }
      const target = await ctx.output(ctx.files[0], { name: ctx.options.name || 'merged', extension: ctx.options.format });
      X.writeFile(out, target, { bookType: ctx.options.format, compression: true });
      return { outputs: [target], summary: `${out.SheetNames.length} sheets` };
    },
  },
  {
    id: 'data.sheetSplit',
    name: 'Split workbook',
    icon: '📄',
    description: 'Save every sheet of a workbook as its own file.',
    keywords: ['split excel', 'sheets', 'tabs', 'separate'],
    input: { kind: 'files', accept: ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'fods', 'numbers'] },
    options: [o.select('format', 'Output', [['xlsx', 'XLSX'], ['csv', 'CSV'], ['ods', 'ODS']], 'xlsx')],
    actionLabel: 'Split',
    async run(ctx) {
      const X = XLSX();
      return ctx.eachFile(async (file) => {
        const wb = await readWorkbook(file);
        const dir = await ctx.outputFolder(file, '_sheets');
        const outputs = [];
        for (const name of wb.SheetNames) {
          const target = path.join(dir, `${name.replace(/[<>:"/\\|?*]+/g, '_')}.${ctx.options.format}`);
          if (ctx.options.format === 'csv') await fsp.writeFile(target, `﻿${unparseCsv(sheetRows(wb.Sheets[name]))}`, 'utf8');
          else {
            const single = X.utils.book_new();
            X.utils.book_append_sheet(single, wb.Sheets[name], name.slice(0, 31));
            X.writeFile(single, target, { bookType: ctx.options.format, compression: true });
          }
          outputs.push(target);
        }
        return outputs;
      });
    },
  },
];

module.exports = {
  category: { id: 'data', name: 'Data & Sheets', icon: '📊', color: ['#f7971e', '#ffd200'], description: 'Excel, CSV, JSON, YAML, XML and TOML tools' },
  tools,
  parseData,
  serializeData,
};
