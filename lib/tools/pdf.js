const fsp = require('fs').promises;
const path = require('path');
const { PDFDocument, PDFName, degrees, StandardFonts, rgb } = require('pdf-lib');
const sharp = require('sharp');
const { baseName, ext, formatBytes, parseRanges, hexToRgb } = require('../core/util');
const { IMAGE_IN } = require('../core/formats');
const { oriented } = require('./image');
const o = require('../core/opts');

const PAGE_SIZES = { A3: [841.89, 1190.55], A4: [595.28, 841.89], A5: [419.53, 595.28], Letter: [612, 792], Legal: [612, 1008] };

async function loadPdf(file) {
  const bytes = await fsp.readFile(file);
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (error) {
    throw new Error(`Cannot read PDF: ${error.message}`);
  }
  if (doc.isEncrypted) throw new Error('This PDF is password protected');
  return doc;
}

async function savePdf(doc, out) {
  await fsp.writeFile(out, await doc.save({ useObjectStreams: true }));
  return out;
}

async function subset(src, pages) {
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(src, pages.map((p) => p - 1));
  copied.forEach((p) => doc.addPage(p));
  return doc;
}

function colorOf(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgb(r / 255, g / 255, b / 255);
}

function friendlyFontError(error) {
  if (/WinAnsi cannot encode/i.test(error.message)) return new Error('The built-in PDF font only supports Latin characters. Remove emojis or non-Latin letters.');
  return error;
}

const PAGES_HELP = 'Examples: 1-3, 5, 8-last, odd, even';

const tools = [
  {
    id: 'pdf.merge',
    name: 'Merge PDFs',
    icon: '🔗',
    description: 'Combine several PDF files into one document, in the order you choose.',
    keywords: ['combine', 'join', 'append', 'concat'],
    input: { kind: 'files', accept: ['pdf'], min: 2, ordered: true },
    options: [o.text('name', 'Output name', 'merged')],
    actionLabel: 'Merge',
    async run(ctx) {
      const out = await PDFDocument.create();
      let pages = 0;
      for (let i = 0; i < ctx.files.length; i++) {
        ctx.check();
        ctx.progress((i / ctx.files.length) * 95, path.basename(ctx.files[i]));
        const src = await loadPdf(ctx.files[i]);
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((p) => out.addPage(p));
        pages += copied.length;
      }
      const target = await ctx.output(ctx.files[0], { name: ctx.options.name || 'merged', extension: 'pdf' });
      await savePdf(out, target);
      ctx.progress(100);
      return { outputs: [target], summary: `${ctx.files.length} files, ${pages} pages` };
    },
  },
  {
    id: 'pdf.split',
    name: 'Split PDF',
    icon: '✂️',
    description: 'Split into single pages, every N pages, or custom ranges, each saved as its own PDF.',
    keywords: ['separate', 'divide', 'pages', 'burst'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [
      o.select('mode', 'Split', [['each', 'Every page'], ['every', 'Every N pages'], ['ranges', 'Custom ranges']], 'each'),
      o.number('n', 'Pages per file', 2, { min: 1, ...o.when('mode', 'every') }),
      o.text('ranges', 'Ranges (one file per range)', '1-3, 4-6', { help: PAGES_HELP, ...o.when('mode', 'ranges') }),
    ],
    actionLabel: 'Split',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const src = await loadPdf(file);
        const total = src.getPageCount();
        let groups;
        if (opt.mode === 'each') groups = Array.from({ length: total }, (_, i) => ({ label: String(i + 1), pages: [i + 1] }));
        else if (opt.mode === 'every') {
          const n = Math.max(1, Number(opt.n) || 1);
          groups = [];
          for (let s = 1; s <= total; s += n) {
            const e = Math.min(total, s + n - 1);
            groups.push({ label: s === e ? String(s) : `${s}-${e}`, pages: Array.from({ length: e - s + 1 }, (_, k) => s + k) });
          }
        } else groups = parseRanges(opt.ranges, total).groups;
        if (!groups.length) throw new Error('No pages selected');
        const dir = await ctx.outputFolder(file, '_split');
        const outputs = [];
        for (let i = 0; i < groups.length; i++) {
          ctx.check();
          const doc = await subset(src, groups[i].pages);
          const target = path.join(dir, `${baseName(file)}_p${groups[i].label}.pdf`);
          await savePdf(doc, target);
          outputs.push(target);
          ctx.stepProgress((i + 1) / groups.length);
        }
        return outputs;
      });
    },
  },
  {
    id: 'pdf.extract',
    name: 'Extract pages',
    icon: '📑',
    description: 'Pick the pages you want and save them as a new PDF.',
    keywords: ['select pages', 'keep pages', 'subset'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [o.text('pages', 'Pages to keep', '1-3', { help: PAGES_HELP, required: true })],
    actionLabel: 'Extract',
    async run(ctx) {
      return ctx.eachFile(async (file) => {
        const src = await loadPdf(file);
        const { pages } = parseRanges(ctx.options.pages, src.getPageCount());
        if (!pages.length) throw new Error('No pages selected');
        const target = await ctx.output(file, { suffix: '_extract', extension: 'pdf' });
        return savePdf(await subset(src, pages), target);
      });
    },
  },
  {
    id: 'pdf.delete',
    name: 'Delete pages',
    icon: '🗑️',
    description: 'Remove unwanted pages from a PDF.',
    keywords: ['remove pages', 'drop pages'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [o.text('pages', 'Pages to delete', '1', { help: PAGES_HELP, required: true })],
    actionLabel: 'Delete pages',
    async run(ctx) {
      return ctx.eachFile(async (file) => {
        const src = await loadPdf(file);
        const total = src.getPageCount();
        const remove = new Set(parseRanges(ctx.options.pages, total).pages);
        const keep = Array.from({ length: total }, (_, i) => i + 1).filter((p) => !remove.has(p));
        if (!keep.length) throw new Error('You cannot delete every page');
        const target = await ctx.output(file, { suffix: '_edited', extension: 'pdf' });
        await savePdf(await subset(src, keep), target);
        return { outputs: target, note: `${path.basename(file)}: removed ${remove.size} page(s), ${keep.length} left` };
      });
    },
  },
  {
    id: 'pdf.rotate',
    name: 'Rotate pages',
    icon: '🔃',
    description: 'Rotate all pages or only some of them by 90°, 180° or 270°.',
    keywords: ['orientation', 'turn', 'landscape'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [
      o.select('angle', 'Rotation', [['90', '90° ↻'], ['180', '180°'], ['270', '90° ↺']], '90'),
      o.text('pages', 'Pages (empty = all)', '', { help: PAGES_HELP }),
    ],
    actionLabel: 'Rotate',
    async run(ctx) {
      const angle = Number(ctx.options.angle);
      return ctx.eachFile(async (file) => {
        const doc = await loadPdf(file);
        const total = doc.getPageCount();
        const pages = ctx.options.pages ? parseRanges(ctx.options.pages, total).pages : Array.from({ length: total }, (_, i) => i + 1);
        for (const p of new Set(pages)) {
          const page = doc.getPage(p - 1);
          page.setRotation(degrees((page.getRotation().angle + angle) % 360));
        }
        return savePdf(doc, await ctx.output(file, { suffix: '_rotated', extension: 'pdf' }));
      });
    },
  },
  {
    id: 'pdf.reorder',
    name: 'Reorder pages',
    icon: '🔀',
    description: 'Reverse the page order, set a custom order, or collate double-sided scans.',
    keywords: ['order', 'sort', 'reverse', 'duplex', 'scan', 'organize'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [
      o.select('mode', 'Mode', [['reverse', 'Reverse'], ['custom', 'Custom order'], ['duplex', 'Collate duplex scan']], 'reverse'),
      o.text('order', 'New order', '3, 1, 2, 4-last', { help: 'Pages not listed are dropped', ...o.when('mode', 'custom') }),
    ],
    actionLabel: 'Reorder',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const src = await loadPdf(file);
        const total = src.getPageCount();
        let order;
        if (opt.mode === 'reverse') order = Array.from({ length: total }, (_, i) => total - i);
        else if (opt.mode === 'custom') order = parseRanges(opt.order, total).pages;
        else {
          const half = Math.ceil(total / 2);
          order = [];
          for (let i = 0; i < half; i++) {
            order.push(i + 1);
            const back = total - i;
            if (back > half) order.push(back);
          }
        }
        return savePdf(await subset(src, order), await ctx.output(file, { suffix: '_reordered', extension: 'pdf' }));
      });
    },
  },
  {
    id: 'pdf.fromImages',
    name: 'Images to PDF',
    icon: '🖼️',
    description: 'Turn photos, scans and screenshots (JPG, PNG, HEIC, WebP…) into a PDF.',
    keywords: ['jpg to pdf', 'png to pdf', 'scan', 'photos to pdf', 'heic to pdf'],
    input: { kind: 'files', accept: IMAGE_IN, ordered: true },
    options: [
      o.select('size', 'Page size', [['fit', 'Fit image'], ['A4', 'A4'], ['Letter', 'Letter'], ['A3', 'A3'], ['A5', 'A5'], ['Legal', 'Legal']], 'A4'),
      o.select('orientation', 'Orientation', [['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], 'auto', { showIf: { size: ['A4', 'Letter', 'A3', 'A5', 'Legal'] } }),
      o.number('margin', 'Margin (mm)', 10, { min: 0, max: 80, showIf: { size: ['A4', 'Letter', 'A3', 'A5', 'Legal'] } }),
      o.range('quality', 'JPEG quality', 40, 100, 90),
      o.checkbox('separate', 'One PDF per image', false),
      o.text('name', 'Output name', 'images', o.when('separate', false)),
    ],
    actionLabel: 'Create PDF',
    async run(ctx) {
      const opt = ctx.options;
      const margin = (Number(opt.margin) || 0) * 2.8346;
      const addImage = async (doc, file) => {
        const img = await oriented(file);
        const meta = await img.metadata();
        let embedded;
        if (meta.hasAlpha) embedded = await doc.embedPng(await img.png().toBuffer());
        else if (['jpg', 'jpeg'].includes(ext(file)) && (meta.orientation || 1) === 1 && opt.quality >= 95) embedded = await doc.embedJpg(await fsp.readFile(file));
        else embedded = await doc.embedJpg(await img.jpeg({ quality: Number(opt.quality), mozjpeg: true }).toBuffer());
        const iw = embedded.width * 0.75;
        const ih = embedded.height * 0.75;
        if (opt.size === 'fit') {
          const page = doc.addPage([iw, ih]);
          page.drawImage(embedded, { x: 0, y: 0, width: iw, height: ih });
          return;
        }
        let [pw, ph] = PAGE_SIZES[opt.size];
        const landscape = opt.orientation === 'landscape' || (opt.orientation === 'auto' && iw > ih);
        if (landscape) [pw, ph] = [ph, pw];
        const page = doc.addPage([pw, ph]);
        const scale = Math.min((pw - margin * 2) / iw, (ph - margin * 2) / ih, 1e9);
        const w = iw * scale;
        const hgt = ih * scale;
        page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - hgt) / 2, width: w, height: hgt });
      };
      if (opt.separate) {
        return ctx.eachFile(async (file) => {
          const doc = await PDFDocument.create();
          await addImage(doc, file);
          return savePdf(doc, await ctx.output(file, { extension: 'pdf' }));
        });
      }
      const doc = await PDFDocument.create();
      const result = await ctx.eachFile(async (file) => {
        await addImage(doc, file);
        return null;
      });
      if (!doc.getPageCount()) return result;
      const target = await ctx.output(ctx.files[0], { name: opt.name || 'images', extension: 'pdf' });
      await savePdf(doc, target);
      result.outputs = [target];
      result.summary = `${doc.getPageCount()} pages`;
      return result;
    },
  },
  {
    id: 'pdf.toImages',
    name: 'PDF to images',
    icon: '🏞️',
    description: 'Render PDF pages as PNG, JPG or WebP images at the resolution you need.',
    keywords: ['pdf to jpg', 'pdf to png', 'render', 'export pages'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [
      o.select('format', 'Format', ['png', 'jpg', 'webp'], 'png'),
      o.select('dpi', 'Resolution', [['72', '72 DPI'], ['150', '150 DPI'], ['200', '200 DPI'], ['300', '300 DPI'], ['600', '600 DPI']], '150'),
      o.range('quality', 'Quality', 30, 100, 90, o.when('format', ['jpg', 'webp'])),
      o.checkbox('transparent', 'Transparent background', false, o.when('format', 'png')),
      o.text('pages', 'Pages (empty = all)', '', { help: PAGES_HELP }),
    ],
    actionLabel: 'Export',
    run: null,
  },
  {
    id: 'pdf.toText',
    name: 'PDF to text',
    icon: '📝',
    description: 'Extract all the text from PDF files into .txt files.',
    keywords: ['extract text', 'copy text', 'txt', 'read pdf'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [o.text('pages', 'Pages (empty = all)', '', { help: PAGES_HELP }), o.checkbox('separators', 'Add page separators', true)],
    actionLabel: 'Extract text',
    run: null,
  },
  {
    id: 'pdf.compress',
    name: 'Compress PDF',
    icon: '🗜️',
    description: 'Shrink heavy scanned PDFs by re-rendering pages as optimized images.',
    keywords: ['reduce size', 'smaller', 'optimize', 'scan', 'email'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [
      o.select('dpi', 'Resolution', [['72', 'Low (72)'], ['110', 'Medium (110)'], ['150', 'High (150)'], ['200', 'Very high (200)']], '110'),
      o.range('quality', 'Image quality', 20, 95, 65),
      o.checkbox('grayscale', 'Convert to grayscale', false),
    ],
    actionLabel: 'Compress',
    help: 'Text becomes part of the image, best for scans.',
    run: null,
  },
  {
    id: 'pdf.watermark',
    name: 'Watermark PDF',
    icon: '💧',
    description: 'Stamp a diagonal or horizontal text watermark on every page.',
    keywords: ['confidential', 'draft', 'stamp', 'copyright'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [
      o.text('text', 'Text', 'CONFIDENTIAL', { required: true }),
      o.range('size', 'Font size', 10, 200, 60),
      o.range('opacity', 'Opacity (%)', 5, 100, 20),
      o.color('color', 'Color', '#ff0000'),
      o.select('style', 'Style', [['diagonal', 'Diagonal'], ['horizontal', 'Horizontal'], ['tile', 'Tiled']], 'diagonal'),
      o.text('pages', 'Pages (empty = all)', '', { help: PAGES_HELP }),
    ],
    actionLabel: 'Apply',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const doc = await loadPdf(file);
        const font = await doc.embedFont(StandardFonts.HelveticaBold);
        const total = doc.getPageCount();
        const pages = opt.pages ? new Set(parseRanges(opt.pages, total).pages) : null;
        const size = Number(opt.size);
        let textWidth;
        try {
          textWidth = font.widthOfTextAtSize(opt.text, size);
        } catch (e) {
          throw friendlyFontError(e);
        }
        const color = colorOf(opt.color);
        const opacity = opt.opacity / 100;
        doc.getPages().forEach((page, i) => {
          if (pages && !pages.has(i + 1)) return;
          const { width, height } = page.getSize();
          const draw = (cx, cy, angle) => {
            const rad = (angle * Math.PI) / 180;
            const x = cx - (textWidth / 2) * Math.cos(rad) + (size / 3) * Math.sin(rad);
            const y = cy - (textWidth / 2) * Math.sin(rad) - (size / 3) * Math.cos(rad);
            page.drawText(opt.text, { x, y, size, font, color, opacity, rotate: degrees(angle) });
          };
          if (opt.style === 'tile') {
            const stepX = textWidth + size * 2;
            const stepY = size * 4;
            for (let y = 0; y < height + stepY; y += stepY) for (let x = (y / stepY) % 2 ? stepX / 2 : 0; x < width + stepX; x += stepX) draw(x, y, 30);
          } else draw(width / 2, height / 2, opt.style === 'diagonal' ? (Math.atan2(height, width) * 180) / Math.PI : 0);
        });
        return savePdf(doc, await ctx.output(file, { suffix: '_watermarked', extension: 'pdf' }));
      });
    },
  },
  {
    id: 'pdf.pageNumbers',
    name: 'Add page numbers',
    icon: '🔢',
    description: 'Number pages with custom position, format and starting number.',
    keywords: ['numbering', 'footer', 'pagination'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [
      o.select('position', 'Position', [['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-center', 'Top center'], ['top-right', 'Top right'], ['top-left', 'Top left']], 'bottom-center'),
      o.select('format', 'Format', [['{n}', '1'], ['{n} / {total}', '1 / 10'], ['Page {n}', 'Page 1'], ['Page {n} of {total}', 'Page 1 of 10'], ['- {n} -', '- 1 -']], '{n} / {total}'),
      o.range('size', 'Font size', 6, 32, 11),
      o.number('start', 'Start at', 1, { min: 0 }),
      o.checkbox('skipFirst', 'Skip the first page (cover)', false),
      o.color('color', 'Color', '#333333'),
    ],
    actionLabel: 'Add numbers',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const doc = await loadPdf(file);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const pages = doc.getPages();
        const size = Number(opt.size);
        const counted = opt.skipFirst ? pages.length - 1 : pages.length;
        const start = Number(opt.start) || 0;
        pages.forEach((page, i) => {
          if (opt.skipFirst && i === 0) return;
          const n = (opt.skipFirst ? i : i + 1) + start - 1;
          const label = opt.format.replace('{n}', n).replace('{total}', counted + start - 1);
          const { width, height } = page.getSize();
          const tw = font.widthOfTextAtSize(label, size);
          const [vert, horiz] = opt.position.split('-');
          const margin = 28;
          const x = horiz === 'center' ? (width - tw) / 2 : horiz === 'right' ? width - margin - tw : margin;
          const y = vert === 'bottom' ? margin * 0.8 : height - margin * 0.8 - size;
          page.drawText(label, { x, y, size, font, color: colorOf(opt.color) });
        });
        return savePdf(doc, await ctx.output(file, { suffix: '_numbered', extension: 'pdf' }));
      });
    },
  },
  {
    id: 'pdf.metadata',
    name: 'Edit PDF metadata',
    icon: '🏷️',
    description: 'Change the title, author, subject and keywords, or wipe all metadata.',
    keywords: ['title', 'author', 'properties', 'privacy', 'clean'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [
      o.checkbox('clear', 'Remove all metadata', false),
      o.text('title', 'Title', '', { placeholder: 'unchanged', ...o.when('clear', false) }),
      o.text('author', 'Author', '', { placeholder: 'unchanged', ...o.when('clear', false) }),
      o.text('subject', 'Subject', '', { placeholder: 'unchanged', ...o.when('clear', false) }),
      o.text('keywords', 'Keywords (comma separated)', '', { placeholder: 'unchanged', ...o.when('clear', false) }),
      o.text('creator', 'Creator', '', { placeholder: 'unchanged', ...o.when('clear', false) }),
    ],
    actionLabel: 'Save',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const doc = await loadPdf(file);
        if (opt.clear) {
          doc.setTitle('');
          doc.setAuthor('');
          doc.setSubject('');
          doc.setKeywords([]);
          doc.setCreator('');
          doc.setProducer('');
          doc.catalog.delete(PDFName.of('Metadata'));
        } else {
          if (opt.title) doc.setTitle(opt.title);
          if (opt.author) doc.setAuthor(opt.author);
          if (opt.subject) doc.setSubject(opt.subject);
          if (opt.keywords) doc.setKeywords(opt.keywords.split(',').map((k) => k.trim()).filter(Boolean));
          if (opt.creator) doc.setCreator(opt.creator);
          doc.setModificationDate(new Date());
        }
        return savePdf(doc, await ctx.output(file, { suffix: '_meta', extension: 'pdf' }));
      });
    },
  },
  {
    id: 'pdf.flatten',
    name: 'Flatten forms',
    icon: '📋',
    description: 'Make filled form fields permanent so they cannot be edited anymore.',
    keywords: ['form', 'fields', 'fillable', 'lock'],
    input: { kind: 'files', accept: ['pdf'] },
    options: [],
    actionLabel: 'Flatten',
    async run(ctx) {
      return ctx.eachFile(async (file) => {
        const doc = await loadPdf(file);
        const form = doc.getForm();
        const count = form.getFields().length;
        form.flatten();
        const out = await savePdf(doc, await ctx.output(file, { suffix: '_flat', extension: 'pdf' }));
        return { outputs: out, note: `${path.basename(file)}: ${count} field(s) flattened` };
      });
    },
  },
  {
    id: 'pdf.info',
    name: 'PDF info',
    icon: 'ℹ️',
    description: 'Page count, page sizes, version, metadata and form fields.',
    keywords: ['properties', 'pages', 'details', 'metadata'],
    input: { kind: 'files', accept: ['pdf'] },
    output: 'none',
    options: [],
    actionLabel: 'Analyze',
    async run(ctx) {
      const sections = [];
      const result = await ctx.eachFile(async (file) => {
        const bytes = await fsp.readFile(file);
        const version = (/%PDF-(\d\.\d)/.exec(bytes.subarray(0, 1024).toString('latin1')) || [])[1] || '?';
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        const pages = doc.getPages();
        const sizes = new Map();
        for (const p of pages) {
          const { width, height } = p.getSize();
          const key = `${Math.round(width / 2.8346)} × ${Math.round(height / 2.8346)} mm`;
          sizes.set(key, (sizes.get(key) || 0) + 1);
        }
        let fields = 0;
        try {
          fields = doc.getForm().getFields().length;
        } catch {}
        const rows = [
          ['File', path.basename(file)],
          ['Size', formatBytes(bytes.length)],
          ['PDF version', version],
          ['Pages', pages.length],
          ['Page sizes', [...sizes].map(([k, n]) => `${k}${sizes.size > 1 ? ` (${n})` : ''}`).join(', ')],
          ['Encrypted', doc.isEncrypted ? 'Yes' : 'No'],
          ['Form fields', fields],
          ['Title', doc.getTitle() || '-'],
          ['Author', doc.getAuthor() || '-'],
          ['Subject', doc.getSubject() || '-'],
          ['Keywords', doc.getKeywords() || '-'],
          ['Creator', doc.getCreator() || '-'],
          ['Producer', doc.getProducer() || '-'],
          ['Created', doc.getCreationDate()?.toLocaleString() || '-'],
          ['Modified', doc.getModificationDate()?.toLocaleString() || '-'],
        ];
        sections.push({ title: path.basename(file), table: { columns: ['Property', 'Value'], rows } });
        return null;
      });
      result.sections = sections;
      return result;
    },
  },
];

module.exports = {
  category: { id: 'pdf', name: 'PDF', icon: '📕', color: ['#ff416c', '#ff4b2b'], description: 'Merge, split, convert, watermark and edit PDFs' },
  tools,
  loadPdf,
};
