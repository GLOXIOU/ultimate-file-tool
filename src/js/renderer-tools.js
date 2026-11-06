(() => {
  const api = window.api;
  const pdfjs = window.pdfjsLib;
  if (pdfjs) pdfjs.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.js';

  const MAX_PIXELS = 120e6;
  const MAX_SIDE = 16000;

  function basename(p) {
    const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  function stem(p) {
    return basename(p).replace(/\.[^.]+$/, '');
  }

  function joinPath(dir, name) {
    const sep = dir.includes('\\') ? '\\' : '/';
    return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
  }

  function parsePages(text, total) {
    const source = String(text || '').trim();
    if (!source) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [];
    for (const raw of source.split(/[,;\s]+/).filter(Boolean)) {
      const token = raw.toLowerCase();
      const m = token.match(/^(\d+|last)?(?:-(\d+|last)?)?$/);
      if (!m) throw new Error(`Invalid page range "${raw}"`);
      const resolve = (v, fallback) => (v === undefined ? fallback : v === 'last' ? total : Number(v));
      const start = resolve(m[1], 1);
      const end = token.includes('-') ? resolve(m[2], total) : start;
      if (start < 1 || end > total || start > end) throw new Error(`Page range "${raw}" is outside 1-${total}`);
      for (let p = start; p <= end; p++) pages.push(p);
    }
    return pages;
  }

  async function openPdf(file) {
    if (!pdfjs) throw new Error('PDF engine failed to load');
    const data = await api.readFile(file);
    return pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, disableAutoFetch: true, verbosity: 0 }).promise;
  }

  async function renderPage(page, dpi, { background = '#ffffff', grayscale = false } = {}) {
    const base = page.getViewport({ scale: 1 });
    let scale = dpi / 72;
    const maxScale = Math.min(MAX_SIDE / base.width, MAX_SIDE / base.height, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
    scale = Math.min(scale, maxScale);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d', { alpha: background === null });
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    await page.render({ canvasContext: context, viewport, background: background || undefined }).promise;
    if (grayscale) {
      const img = context.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        d[i] = d[i + 1] = d[i + 2] = g;
      }
      context.putImageData(img, 0, 0);
    }
    return { canvas, width: base.width, height: base.height };
  }

  function canvasBytes(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        async (blob) => {
          if (!blob) return reject(new Error('Could not encode the page image'));
          resolve(new Uint8Array(await blob.arrayBuffer()));
        },
        type,
        quality,
      );
    });
  }

  async function eachFile(ctx, fn) {
    const outputs = [];
    const errors = [];
    const notes = [];
    for (let i = 0; i < ctx.files.length; i++) {
      if (ctx.isCancelled()) throw new Error('Cancelled');
      const file = ctx.files[i];
      const step = (fraction, message) => ctx.progress(((i + fraction) / ctx.files.length) * 100, `${ctx.files.length > 1 ? `[${i + 1}/${ctx.files.length}] ` : ''}${message || basename(file)}`);
      step(0);
      try {
        const res = await fn(file, step);
        if (res?.outputs) outputs.push(...res.outputs);
        if (res?.note) notes.push(res.note);
      } catch (error) {
        if (ctx.isCancelled()) throw new Error('Cancelled');
        errors.push({ file, error: error.message || String(error) });
      }
    }
    ctx.progress(100);
    return { outputs, errors, notes };
  }

  const handlers = {
    async 'pdf.toImages'(ctx) {
      const opt = ctx.options;
      const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[opt.format] || 'image/png';
      return eachFile(ctx, async (file, step) => {
        const doc = await openPdf(file);
        try {
          const pages = parsePages(opt.pages, doc.numPages);
          let dir = null;
          if (pages.length > 1) dir = await api.outputFolder(file, { suffix: '_pages', outDir: ctx.outDir });
          const outputs = [];
          for (let k = 0; k < pages.length; k++) {
            if (ctx.isCancelled()) throw new Error('Cancelled');
            const page = await doc.getPage(pages[k]);
            const { canvas } = await renderPage(page, Number(opt.dpi), { background: opt.format === 'png' && opt.transparent ? null : '#ffffff' });
            const bytes = await canvasBytes(canvas, mime, Number(opt.quality || 90) / 100);
            const name = `${stem(file)}_page${String(pages[k]).padStart(String(doc.numPages).length, '0')}.${opt.format}`;
            const target = dir ? joinPath(dir, name) : await api.outputPath(file, { name: `${stem(file)}_page${pages[k]}`, extension: opt.format, outDir: ctx.outDir });
            await api.writeFile(target, bytes);
            outputs.push(target);
            page.cleanup();
            step((k + 1) / pages.length, `Page ${pages[k]} of ${doc.numPages}`);
          }
          return { outputs };
        } finally {
          doc.destroy();
        }
      });
    },

    async 'pdf.toText'(ctx) {
      const opt = ctx.options;
      const texts = [];
      const result = await eachFile(ctx, async (file, step) => {
        const doc = await openPdf(file);
        try {
          const pages = parsePages(opt.pages, doc.numPages);
          const chunks = [];
          let chars = 0;
          for (let k = 0; k < pages.length; k++) {
            const page = await doc.getPage(pages[k]);
            const content = await page.getTextContent();
            let line = '';
            let lastY = null;
            const lines = [];
            for (const item of content.items) {
              if (!('str' in item)) continue;
              const y = item.transform[5];
              if (lastY !== null && Math.abs(y - lastY) > 2 && line) {
                lines.push(line);
                line = '';
              }
              line += item.str;
              if (item.hasEOL) {
                lines.push(line);
                line = '';
                lastY = null;
              } else lastY = y;
            }
            if (line) lines.push(line);
            const pageText = lines.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n');
            chars += pageText.length;
            chunks.push(opt.separators ? `──────── Page ${pages[k]} ────────\n${pageText}` : pageText);
            page.cleanup();
            step((k + 1) / pages.length, `Page ${pages[k]} of ${doc.numPages}`);
          }
          const text = chunks.join('\n\n');
          texts.push(ctx.files.length > 1 ? `═══ ${basename(file)} ═══\n${text}` : text);
          const target = await api.outputPath(file, { extension: 'txt', outDir: ctx.outDir });
          await api.writeFile(target, text);
          return { outputs: [target], note: chars ? `${basename(file)}: ${chars.toLocaleString()} characters` : `${basename(file)}: no text layer found (scanned PDF?)` };
        } finally {
          doc.destroy();
        }
      });
      result.text = texts.join('\n\n');
      result.textLabel = 'Extracted text';
      return result;
    },

    async 'pdf.compress'(ctx) {
      const opt = ctx.options;
      const PDFLib = window.PDFLib;
      if (!PDFLib) throw new Error('PDF writer failed to load');
      let before = 0;
      let after = 0;
      const result = await eachFile(ctx, async (file, step) => {
        const original = await api.readFile(file);
        const doc = await openPdf(file);
        try {
          const out = await PDFLib.PDFDocument.create();
          for (let p = 1; p <= doc.numPages; p++) {
            if (ctx.isCancelled()) throw new Error('Cancelled');
            const page = await doc.getPage(p);
            const { canvas, width, height } = await renderPage(page, Number(opt.dpi), { grayscale: opt.grayscale });
            const jpg = await canvasBytes(canvas, 'image/jpeg', Number(opt.quality) / 100);
            const image = await out.embedJpg(jpg);
            const target = out.addPage([width, height]);
            target.drawImage(image, { x: 0, y: 0, width, height });
            page.cleanup();
            step(p / doc.numPages, `Page ${p} of ${doc.numPages}`);
          }
          out.setProducer('Ultimate File Tool');
          const bytes = await out.save({ useObjectStreams: true });
          const target = await api.outputPath(file, { suffix: '_compressed', extension: 'pdf', outDir: ctx.outDir });
          if (bytes.length >= original.length && !opt.grayscale) {
            await api.writeFile(target, original);
          } else {
            await api.writeFile(target, bytes);
          }
          const finalSize = Math.min(bytes.length, opt.grayscale ? bytes.length : original.length);
          before += original.length;
          after += finalSize;
          const pct = Math.round((1 - finalSize / original.length) * 100);
          const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
          const note = finalSize === original.length && bytes.length >= original.length ? `${basename(file)}: already compact, original kept (text-based PDFs do not shrink by rasterizing)` : `${basename(file)}: ${mb(original.length)} → ${mb(finalSize)} (${pct >= 0 ? '-' : '+'}${Math.abs(pct)}%)`;
          return { outputs: [target], note };
        } finally {
          doc.destroy();
        }
      });
      if (before && after < before) result.summary = `Saved ${((before - after) / 1048576).toFixed(2)} MB (${Math.round(((before - after) / before) * 100)}%)`;
      else if (before) result.summary = 'No size gain on these files';
      return result;
    },
  };

  window.RendererTools = {
    async run(toolId, ctx) {
      const handler = handlers[toolId];
      if (!handler) throw new Error(`No renderer handler for ${toolId}`);
      return handler(ctx);
    },
  };
})();
