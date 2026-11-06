const fsp = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const { decodeFirstFrame, run: runFfmpeg } = require('../core/ffmpeg');
const { ext, baseName, formatBytes, hexToRgb, escapeXml, tempDir, removeQuiet } = require('../core/util');
const { IMAGE_IN, IMAGE_NATIVE, MIME } = require('../core/formats');
const o = require('../core/opts');

sharp.cache(false);

const ANIMATABLE = new Set(['gif', 'webp']);
const SAME_FORMAT = { jpg: 'jpg', jpeg: 'jpg', jfif: 'jpg', jpe: 'jpg', png: 'png', webp: 'webp', avif: 'avif', tif: 'tiff', tiff: 'tiff', gif: 'gif', bmp: 'bmp', ico: 'ico' };

async function loadImage(file, { animated = false, density } = {}) {
  const e = ext(file);
  if (e === 'heic' || e === 'heif') {
    try {
      const probe = sharp(file);
      await probe.metadata();
      await probe.clone().resize(8).toBuffer();
      return sharp(file, { limitInputPixels: false });
    } catch {
      const convert = require('heic-convert');
      const png = await convert({ buffer: await fsp.readFile(file), format: 'PNG' });
      return sharp(Buffer.from(png), { limitInputPixels: false });
    }
  }
  if (IMAGE_NATIVE.includes(e)) {
    try {
      const options = { limitInputPixels: false, animated: animated && ANIMATABLE.has(e) };
      if (e === 'svg') options.density = density || 192;
      const img = sharp(file, options);
      await img.metadata();
      return img;
    } catch {}
  }
  const png = await decodeFirstFrame(file);
  return sharp(png, { limitInputPixels: false });
}

async function oriented(file, opts) {
  const img = await loadImage(file, opts);
  return img.autoOrient();
}

async function materialize(img) {
  const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
  return { img: sharp(data, { limitInputPixels: false }), width: info.width, height: info.height, buffer: data };
}

function encodeBmp(data, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelSize = rowSize * height;
  const buf = Buffer.alloc(54 + pixelSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + pixelSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 3;
    const dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      buf[dst + x * 3] = data[src + x * 3 + 2];
      buf[dst + x * 3 + 1] = data[src + x * 3 + 1];
      buf[dst + x * 3 + 2] = data[src + x * 3];
    }
  }
  return buf;
}

async function buildIco(img, sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const source = (await materialize(img)).buffer;
  const pngs = await Promise.all(
    sizes.map((s) =>
      sharp(source)
        .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
    ),
  );
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const base = 6 + i * 16;
    header.writeUInt8(s >= 256 ? 0 : s, base);
    header.writeUInt8(s >= 256 ? 0 : s, base + 1);
    header.writeUInt8(0, base + 2);
    header.writeUInt8(0, base + 3);
    header.writeUInt16LE(1, base + 4);
    header.writeUInt16LE(32, base + 6);
    header.writeUInt32LE(pngs[i].length, base + 8);
    header.writeUInt32LE(offset, base + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, ...pngs]);
}

async function encode(img, format, opts = {}) {
  const quality = Math.max(1, Math.min(100, Math.round(opts.quality ?? 90)));
  switch (format) {
    case 'jpg':
    case 'jpeg':
      return img
        .flatten({ background: opts.background || '#ffffff' })
        .jpeg({ quality, mozjpeg: true, progressive: true })
        .toBuffer();
    case 'png':
      return img
        .png(opts.palette ? { palette: true, quality, compressionLevel: 9, effort: 10 } : { compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
    case 'webp':
      return img.webp({ quality, lossless: Boolean(opts.lossless), effort: 5, smartSubsample: true }).toBuffer();
    case 'avif':
      return img.avif({ quality: Math.max(1, Math.round(quality * 0.75)), lossless: Boolean(opts.lossless), effort: 4 }).toBuffer();
    case 'tiff':
      return img.tiff({ compression: 'lzw' }).toBuffer();
    case 'gif':
      return img.gif({ effort: 8, dither: 0.8 }).toBuffer();
    case 'bmp': {
      const { data, info } = await img
        .flatten({ background: opts.background || '#ffffff' })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return encodeBmp(data, info.width, info.height);
    }
    case 'ico':
      return buildIco(img, opts.icoSizes);
    default:
      throw new Error(`Unsupported output format ${format}`);
  }
}

function sameFormat(file) {
  return SAME_FORMAT[ext(file)] || (ext(file) === 'heic' || ext(file) === 'heif' ? 'jpg' : 'png');
}

function outExtFor(file, format) {
  const e = ext(file);
  if (format === 'jpg' && ['jpg', 'jpeg'].includes(e)) return e;
  if (format === 'tiff' && ['tif', 'tiff'].includes(e)) return e;
  return format;
}

async function save(ctx, file, buffer, format, suffix, extra = {}) {
  const out = await ctx.output(file, { suffix, extension: outExtFor(file, format), ...extra });
  await fsp.writeFile(out, buffer);
  return out;
}

function positionToGravity(pos) {
  return (
    {
      center: 'centre',
      'top-left': 'northwest',
      top: 'north',
      'top-right': 'northeast',
      left: 'west',
      right: 'east',
      'bottom-left': 'southwest',
      bottom: 'south',
      'bottom-right': 'southeast',
    }[pos] || 'centre'
  );
}

async function dimensions(img) {
  const meta = await img.metadata();
  const swap = (meta.orientation || 1) >= 5;
  return { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height, meta };
}

function kmeans(pixels, k, iterations = 12) {
  const n = pixels.length / 3;
  const sorted = [];
  for (let i = 0; i < n; i++) sorted.push(i);
  sorted.sort((a, b) => {
    const la = pixels[a * 3] * 0.299 + pixels[a * 3 + 1] * 0.587 + pixels[a * 3 + 2] * 0.114;
    const lb = pixels[b * 3] * 0.299 + pixels[b * 3 + 1] * 0.587 + pixels[b * 3 + 2] * 0.114;
    return la - lb;
  });
  let centers = [];
  for (let c = 0; c < k; c++) {
    const idx = sorted[Math.floor(((c + 0.5) / k) * n)];
    centers.push([pixels[idx * 3], pixels[idx * 3 + 1], pixels[idx * 3 + 2]]);
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iterations; it++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dr = pixels[i * 3] - centers[c][0];
        const dg = pixels[i * 3 + 1] - centers[c][1];
        const db = pixels[i * 3 + 2] - centers[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      assign[i] = best;
      sums[best][0] += pixels[i * 3];
      sums[best][1] += pixels[i * 3 + 1];
      sums[best][2] += pixels[i * 3 + 2];
      sums[best][3]++;
    }
    centers = centers.map((c, idx) => (sums[idx][3] ? [sums[idx][0] / sums[idx][3], sums[idx][1] / sums[idx][3], sums[idx][2] / sums[idx][3]] : c));
  }
  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < n; i++) counts[assign[i]]++;
  return centers
    .map((c, i) => ({ rgb: c.map(Math.round), share: counts[i] / n }))
    .filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share);
}

const toHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function dmsToDecimal(value, ref) {
  if (!Array.isArray(value)) return null;
  const [d, m, s] = value;
  let dec = d + m / 60 + s / 3600;
  if (ref === 'S' || ref === 'W') dec = -dec;
  return Number(dec.toFixed(6));
}

const QUALITY_FORMATS = ['jpg', 'webp', 'avif'];

const tools = [
  {
    id: 'image.convert',
    name: 'Convert images',
    icon: '🔄',
    description: 'Convert between JPG, PNG, WebP, AVIF, TIFF, GIF, BMP, ICO. Reads HEIC, SVG, PSD, TGA, DDS, EXR and more.',
    keywords: ['jpg to png', 'png to jpg', 'heic to jpg', 'webp', 'avif', 'svg to png', 'ico', 'bmp'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [
      o.select('format', 'Output format', ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico'], 'png'),
      o.range('quality', 'Quality', 1, 100, 90, o.when('format', QUALITY_FORMATS)),
      o.checkbox('lossless', 'Lossless', false, o.when('format', ['webp', 'avif'])),
      o.checkbox('animated', 'Keep animation (GIF/WebP)', true, o.when('format', ['gif', 'webp'])),
      o.color('background', 'Background for transparency', '#ffffff', o.when('format', ['jpg', 'bmp'])),
    ],
    actionLabel: 'Convert',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const img = await oriented(file, { animated: opt.animated && ANIMATABLE.has(opt.format) });
        const buffer = await encode(img, opt.format, opt);
        return save(ctx, file, buffer, opt.format, '');
      });
    },
  },
  {
    id: 'image.compress',
    name: 'Compress images',
    icon: '🗜️',
    description: 'Shrink JPG, PNG, WebP and AVIF files with smart quantization and optional downscaling.',
    keywords: ['reduce size', 'optimize', 'tinypng', 'smaller'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [
      o.range('quality', 'Quality', 10, 100, 75),
      o.select('format', 'Output format', [['keep', 'Same as input'], ['webp', 'WebP'], ['avif', 'AVIF'], ['jpg', 'JPG']], 'keep'),
      o.select('maxSize', 'Max dimension', [['0', 'Original'], ['3840', '3840 px'], ['2560', '2560 px'], ['1920', '1920 px'], ['1280', '1280 px'], ['800', '800 px']], '0'),
    ],
    actionLabel: 'Compress',
    async run(ctx) {
      const opt = ctx.options;
      let before = 0;
      let after = 0;
      const result = await ctx.eachFile(async (file) => {
        const original = (await fsp.stat(file)).size;
        let format = opt.format === 'keep' ? sameFormat(file) : opt.format;
        if (format === 'ico' || format === 'bmp' || format === 'tiff') format = format === 'tiff' ? 'tiff' : 'png';
        let img = await oriented(file, { animated: ANIMATABLE.has(format) });
        const max = Number(opt.maxSize);
        if (max) img = img.resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true });
        let buffer = await encode(img, format, { quality: opt.quality, palette: format === 'png' });
        if (buffer.length >= original && format === sameFormat(file) && !max) buffer = await fsp.readFile(file);
        before += original;
        after += buffer.length;
        const out = await save(ctx, file, buffer, format, '_compressed');
        const pct = original ? Math.round((1 - buffer.length / original) * 100) : 0;
        return { outputs: out, note: `${path.basename(file)}: ${formatBytes(original)} → ${formatBytes(buffer.length)} (${pct >= 0 ? '-' : '+'}${Math.abs(pct)}%)` };
      });
      const saved = before - after;
      result.summary = `Saved ${formatBytes(saved)} (${before ? Math.round((saved / before) * 100) : 0}%)`;
      return result;
    },
  },
  {
    id: 'image.resize',
    name: 'Resize images',
    icon: '📐',
    description: 'Resize by percentage, width, height or exact dimensions with fit modes.',
    keywords: ['scale', 'dimensions', 'thumbnail', 'upscale', 'downscale'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [
      o.select('mode', 'Resize by', [['percent', 'Percent'], ['width', 'Width'], ['height', 'Height'], ['box', 'Max box'], ['exact', 'Exact size']], 'percent'),
      o.range('percent', 'Scale (%)', 1, 400, 50, o.when('mode', 'percent')),
      o.number('width', 'Width (px)', 1280, { min: 1, ...o.when('mode', ['width', 'box', 'exact']) }),
      o.number('height', 'Height (px)', 720, { min: 1, ...o.when('mode', ['height', 'box', 'exact']) }),
      o.select('fit', 'Fit', [['cover', 'Crop to fill'], ['contain', 'Letterbox'], ['fill', 'Stretch']], 'cover', o.when('mode', 'exact')),
      o.color('background', 'Letterbox color', '#000000', { showIf: { mode: ['exact'], fit: ['contain'] } }),
      o.checkbox('enlarge', 'Allow enlarging', false, o.when('mode', ['width', 'height', 'box'])),
    ],
    actionLabel: 'Resize',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const format = sameFormat(file);
        const img = await oriented(file, { animated: ANIMATABLE.has(format) });
        const { width, height } = await dimensions(img);
        const noEnlarge = !opt.enlarge;
        if (opt.mode === 'percent') {
          img.resize(Math.max(1, Math.round((width * opt.percent) / 100)), null);
        } else if (opt.mode === 'width') {
          img.resize({ width: Number(opt.width), withoutEnlargement: noEnlarge });
        } else if (opt.mode === 'height') {
          img.resize({ height: Number(opt.height), withoutEnlargement: noEnlarge });
        } else if (opt.mode === 'box') {
          img.resize({ width: Number(opt.width), height: Number(opt.height), fit: 'inside', withoutEnlargement: noEnlarge });
        } else {
          img.resize({ width: Number(opt.width), height: Number(opt.height), fit: opt.fit, background: opt.background, position: 'centre' });
        }
        const buffer = await encode(img, format, { quality: 92 });
        return save(ctx, file, buffer, format, '_resized');
      });
    },
  },
  {
    id: 'image.crop',
    name: 'Crop images',
    icon: '✂️',
    description: 'Crop to an aspect ratio with smart subject detection, or to an exact box.',
    keywords: ['aspect ratio', 'square', 'instagram', 'smart crop', 'trim'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [
      o.select('mode', 'Mode', [['ratio', 'Aspect ratio'], ['box', 'Exact box'], ['trim', 'Auto-trim borders']], 'ratio'),
      o.select('ratio', 'Aspect ratio', [['1:1', '1:1'], ['4:3', '4:3'], ['3:4', '3:4'], ['16:9', '16:9'], ['9:16', '9:16'], ['3:2', '3:2'], ['2:3', '2:3'], ['4:5', '4:5'], ['21:9', '21:9']], '1:1', o.when('mode', 'ratio')),
      o.select('position', 'Focus', [['attention', 'Smart (subject)'], ['entropy', 'Smart (detail)'], ['centre', 'Center'], ['north', 'Top'], ['south', 'Bottom'], ['west', 'Left'], ['east', 'Right']], 'attention', o.when('mode', 'ratio')),
      o.number('left', 'Left (px)', 0, { min: 0, ...o.when('mode', 'box') }),
      o.number('top', 'Top (px)', 0, { min: 0, ...o.when('mode', 'box') }),
      o.number('width', 'Width (px)', 500, { min: 1, ...o.when('mode', 'box') }),
      o.number('height', 'Height (px)', 500, { min: 1, ...o.when('mode', 'box') }),
      o.range('threshold', 'Trim tolerance', 1, 100, 10, o.when('mode', 'trim')),
    ],
    actionLabel: 'Crop',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const format = sameFormat(file);
        const { img, width, height } = await materialize(await oriented(file));
        if (opt.mode === 'ratio') {
          const [rw, rh] = opt.ratio.split(':').map(Number);
          const ratio = rw / rh;
          let w = width;
          let h = Math.round(width / ratio);
          if (h > height) {
            h = height;
            w = Math.round(height * ratio);
          }
          const position = opt.position === 'attention' ? sharp.strategy.attention : opt.position === 'entropy' ? sharp.strategy.entropy : opt.position;
          img.resize(w, h, { fit: 'cover', position });
        } else if (opt.mode === 'box') {
          const left = Number(opt.left);
          const top = Number(opt.top);
          const w = Math.min(Number(opt.width), width - left);
          const h = Math.min(Number(opt.height), height - top);
          if (w <= 0 || h <= 0) throw new Error(`Crop box is outside the image (${width}×${height})`);
          img.extract({ left, top, width: w, height: h });
        } else {
          img.trim({ threshold: Number(opt.threshold) });
        }
        const buffer = await encode(img, format, { quality: 92 });
        return save(ctx, file, buffer, format, '_cropped');
      });
    },
  },
  {
    id: 'image.rotate',
    name: 'Rotate & flip',
    icon: '🔃',
    description: 'Rotate by any angle, mirror horizontally or vertically, fix EXIF orientation.',
    keywords: ['mirror', 'orientation', 'turn', 'flip'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [
      o.select('angle', 'Rotation', [['0', 'None'], ['90', '90° ↻'], ['180', '180°'], ['270', '90° ↺'], ['custom', 'Custom']], '90'),
      o.number('customAngle', 'Angle (°)', 15, o.when('angle', 'custom')),
      o.color('background', 'Fill color', '#ffffff', o.when('angle', 'custom')),
      o.checkbox('flipH', 'Mirror horizontally'),
      o.checkbox('flipV', 'Flip vertically'),
    ],
    actionLabel: 'Apply',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const format = sameFormat(file);
        const { img } = await materialize(await oriented(file));
        const angle = opt.angle === 'custom' ? Number(opt.customAngle) : Number(opt.angle);
        if (angle) img.rotate(angle, { background: opt.background });
        if (opt.flipH) img.flop();
        if (opt.flipV) img.flip();
        const buffer = await encode(img, format, { quality: 92 });
        return save(ctx, file, buffer, format, '_rotated');
      });
    },
  },
  {
    id: 'image.adjust',
    name: 'Filters & adjustments',
    icon: '🎨',
    description: 'Brightness, contrast, saturation, hue, blur, sharpen, grayscale, sepia, invert, auto-enhance.',
    keywords: ['black and white', 'grayscale', 'sepia', 'blur', 'sharpen', 'invert', 'brightness'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [
      o.range('brightness', 'Brightness (%)', 0, 200, 100),
      o.range('contrast', 'Contrast (%)', 0, 200, 100),
      o.range('saturation', 'Saturation (%)', 0, 300, 100),
      o.range('hue', 'Hue shift (°)', -180, 180, 0),
      o.range('blur', 'Blur', 0, 30, 0),
      o.checkbox('sharpen', 'Sharpen'),
      o.checkbox('normalize', 'Auto-enhance levels'),
      o.select('effect', 'Effect', [['none', 'None'], ['grayscale', 'Grayscale'], ['sepia', 'Sepia'], ['invert', 'Invert']], 'none'),
    ],
    actionLabel: 'Apply',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const format = sameFormat(file);
        const img = await oriented(file);
        if (opt.normalize) img.normalise();
        if (opt.brightness !== 100 || opt.saturation !== 100 || opt.hue !== 0) {
          img.modulate({ brightness: opt.brightness / 100, saturation: opt.saturation / 100, hue: Number(opt.hue) });
        }
        if (opt.contrast !== 100) {
          const a = opt.contrast / 100;
          img.linear(a, 128 * (1 - a));
        }
        if (opt.effect === 'grayscale') img.grayscale();
        if (opt.effect === 'sepia') img.recomb([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]);
        if (opt.effect === 'invert') img.negate({ alpha: false });
        if (opt.blur > 0) img.blur(Math.max(0.3, opt.blur / 2));
        if (opt.sharpen) img.sharpen({ sigma: 1.2 });
        const buffer = await encode(img, format, { quality: 92 });
        return save(ctx, file, buffer, format, '_edited');
      });
    },
  },
  {
    id: 'image.watermark',
    name: 'Watermark',
    icon: '💧',
    description: 'Stamp a text or logo watermark at any position, or tile it across the image.',
    keywords: ['logo', 'copyright', 'stamp', 'overlay'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [
      o.select('type', 'Watermark', [['text', 'Text'], ['image', 'Logo image']], 'text'),
      o.text('text', 'Text', '© My Name', o.when('type', 'text')),
      o.color('color', 'Color', '#ffffff', o.when('type', 'text')),
      o.range('size', 'Text size (% of width)', 1, 30, 5, o.when('type', 'text')),
      o.file('logo', 'Logo file', IMAGE_IN, o.when('type', 'image')),
      o.range('logoScale', 'Logo width (%)', 5, 100, 20, o.when('type', 'image')),
      o.select('position', 'Position', [['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-right', 'Top right'], ['top-left', 'Top left'], ['center', 'Center'], ['bottom', 'Bottom'], ['top', 'Top'], ['tile', 'Tiled']], 'bottom-right'),
      o.range('opacity', 'Opacity (%)', 5, 100, 60),
      o.range('margin', 'Margin (%)', 0, 20, 3),
    ],
    actionLabel: 'Apply watermark',
    async run(ctx) {
      const opt = ctx.options;
      if (opt.type === 'image' && !opt.logo) throw new Error('Pick a logo file');
      if (opt.type === 'text' && !String(opt.text).trim()) throw new Error('Enter watermark text');
      return ctx.eachFile(async (file) => {
        const format = sameFormat(file);
        const { img, width, height } = await materialize(await oriented(file));
        const margin = Math.round((Math.min(width, height) * opt.margin) / 100);
        const alpha = opt.opacity / 100;
        let overlay;
        if (opt.type === 'text') {
          const fontSize = Math.max(8, Math.round((width * opt.size) / 100));
          const textWidth = Math.ceil(String(opt.text).length * fontSize * 0.62);
          const textHeight = Math.ceil(fontSize * 1.4);
          const tile = opt.position === 'tile';
          const w = tile ? textWidth + fontSize * 3 : textWidth + margin * 2;
          const h = tile ? textHeight + fontSize * 3 : textHeight + margin * 2;
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="${opt.color}" fill-opacity="${alpha}" stroke="#000000" stroke-opacity="${alpha * 0.25}" stroke-width="${Math.max(1, fontSize / 30)}" paint-order="stroke"${tile ? ` transform="rotate(-30 ${w / 2} ${h / 2})"` : ''}>${escapeXml(opt.text)}</text></svg>`;
          overlay = await sharp(Buffer.from(svg)).png().toBuffer();
        } else {
          const logo = await oriented(opt.logo);
          overlay = await logo
            .resize({ width: Math.max(8, Math.round((width * opt.logoScale) / 100)) })
            .ensureAlpha()
            .composite([{ input: Buffer.from([255, 255, 255, Math.round(alpha * 255)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
            .png()
            .toBuffer();
          if (opt.position !== 'tile' && margin) {
            overlay = await sharp(overlay).extend({ top: margin, bottom: margin, left: margin, right: margin, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
          }
        }
        const meta = await sharp(overlay).metadata();
        if (meta.width > width || meta.height > height) {
          overlay = await sharp(overlay).resize(width, height, { fit: 'inside' }).png().toBuffer();
        }
        const layer = opt.position === 'tile' ? { input: overlay, tile: true } : { input: overlay, gravity: positionToGravity(opt.position) };
        img.composite([layer]);
        const buffer = await encode(img, format, { quality: 92 });
        return save(ctx, file, buffer, format, '_watermarked');
      });
    },
  },
  {
    id: 'image.strip',
    name: 'Remove metadata',
    icon: '🕵️',
    description: 'Strip EXIF, GPS location, camera info and XMP data for privacy.',
    keywords: ['exif', 'gps', 'privacy', 'location', 'clean'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [o.checkbox('keepIcc', 'Keep color profile', true)],
    actionLabel: 'Clean',
    async run(ctx) {
      return ctx.eachFile(async (file) => {
        const format = sameFormat(file);
        const img = await oriented(file, { animated: ANIMATABLE.has(format) });
        const meta = await img.metadata();
        if (ctx.options.keepIcc) img.keepIccProfile();
        const buffer = await encode(img, format, { quality: 95 });
        const removed = [meta.exif && 'EXIF', meta.xmp && 'XMP', meta.iptc && 'IPTC', !ctx.options.keepIcc && meta.icc && 'ICC'].filter(Boolean);
        const out = await save(ctx, file, buffer, format, '_clean');
        return { outputs: out, note: `${path.basename(file)}: ${removed.length ? `removed ${removed.join(', ')}` : 'no metadata found'}` };
      });
    },
  },
  {
    id: 'image.favicon',
    name: 'Favicon & app icons',
    icon: '⭐',
    description: 'Generate favicon.ico, PNG icons, Apple touch icon, Android icons and a web manifest.',
    keywords: ['ico', 'icon', 'website', 'pwa', 'apple-touch-icon'],
    input: { kind: 'file', accept: IMAGE_IN },
    options: [
      o.range('padding', 'Padding (%)', 0, 30, 0),
      o.checkbox('useBackground', 'Solid background', false),
      o.color('background', 'Background color', '#0073ff', o.when('useBackground', true)),
      o.text('appName', 'App name (manifest)', 'My App'),
    ],
    actionLabel: 'Generate icons',
    async run(ctx) {
      const opt = ctx.options;
      const file = ctx.file;
      ctx.setStep(0, 1, 'Rendering icons');
      const source = (await materialize(await oriented(file, { density: 512 }))).buffer;
      const dir = await ctx.outputFolder(file, '_favicon');
      const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
      const render = async (size, forceBg) => {
        const pad = Math.round((size * opt.padding) / 100);
        const inner = Math.max(1, size - pad * 2);
        const bg = opt.useBackground || forceBg ? opt.background || '#ffffff' : transparent;
        return sharp(source)
          .resize(inner, inner, { fit: 'contain', background: transparent })
          .extend({ top: pad, bottom: size - inner - pad, left: pad, right: size - inner - pad, background: transparent })
          .flatten(opt.useBackground || forceBg ? { background: bg } : false)
          .png()
          .toBuffer();
      };
      const outputs = [];
      const pngs = { 'favicon-16x16.png': 16, 'favicon-32x32.png': 32, 'favicon-48x48.png': 48, 'android-chrome-192x192.png': 192, 'android-chrome-512x512.png': 512, 'mstile-150x150.png': 150 };
      let i = 0;
      for (const [name, size] of Object.entries(pngs)) {
        const target = path.join(dir, name);
        await fsp.writeFile(target, await render(size));
        outputs.push(target);
        ctx.progress((++i / 9) * 100);
      }
      const apple = path.join(dir, 'apple-touch-icon.png');
      await fsp.writeFile(apple, await render(180, true));
      outputs.push(apple);
      const icoSource = sharp(await render(256));
      const ico = path.join(dir, 'favicon.ico');
      await fsp.writeFile(ico, await buildIco(icoSource, [16, 32, 48, 64, 128, 256]));
      outputs.unshift(ico);
      const manifest = {
        name: opt.appName,
        short_name: opt.appName,
        icons: [
          { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
        theme_color: opt.useBackground ? opt.background : '#ffffff',
        background_color: opt.useBackground ? opt.background : '#ffffff',
        display: 'standalone',
      };
      const manifestPath = path.join(dir, 'site.webmanifest');
      await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      outputs.push(manifestPath);
      const snippet = [
        '<link rel="icon" href="/favicon.ico" sizes="any">',
        '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
        '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
        '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
        '<link rel="manifest" href="/site.webmanifest">',
      ].join('\n');
      await fsp.writeFile(path.join(dir, 'snippet.html'), snippet);
      ctx.progress(100);
      return { outputs, folder: dir, text: snippet, textLabel: 'HTML snippet' };
    },
  },
  {
    id: 'image.base64',
    name: 'Image to Base64',
    icon: '🔤',
    description: 'Encode images as Base64 or data URIs for HTML, CSS and JSON.',
    keywords: ['data uri', 'inline', 'css', 'encode'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [
      o.select('format', 'Output', [['datauri', 'Data URI'], ['raw', 'Raw Base64'], ['css', 'CSS background'], ['html', 'HTML <img>']], 'datauri'),
      o.checkbox('save', 'Also save as .txt', false),
    ],
    actionLabel: 'Encode',
    async run(ctx) {
      const texts = [];
      const result = await ctx.eachFile(async (file) => {
        const data = await fsp.readFile(file);
        const mime = MIME[ext(file)] || 'application/octet-stream';
        const b64 = data.toString('base64');
        const uri = `data:${mime};base64,${b64}`;
        const value = { datauri: uri, raw: b64, css: `background-image: url("${uri}");`, html: `<img src="${uri}" alt="${escapeXml(baseName(file))}">` }[ctx.options.format];
        texts.push(ctx.files.length > 1 ? `/* ${path.basename(file)} */\n${value}` : value);
        if (ctx.options.save) {
          const out = await ctx.output(file, { suffix: '_base64', extension: 'txt' });
          await fsp.writeFile(out, value);
          return out;
        }
        return null;
      });
      result.text = texts.join('\n\n');
      return result;
    },
  },
  {
    id: 'image.info',
    name: 'Image info & EXIF',
    icon: 'ℹ️',
    description: 'Dimensions, format, color space, DPI, camera, lens, exposure and GPS location.',
    keywords: ['metadata', 'exif', 'camera', 'gps', 'resolution', 'dpi'],
    input: { kind: 'files', accept: IMAGE_IN },
    output: 'none',
    options: [],
    actionLabel: 'Analyze',
    async run(ctx) {
      const sections = [];
      const result = await ctx.eachFile(async (file) => {
        const img = await loadImage(file);
        const meta = await img.metadata();
        const stats = await img.stats().catch(() => null);
        const size = (await fsp.stat(file)).size;
        const swap = (meta.orientation || 1) >= 5;
        const rows = [
          ['File', path.basename(file)],
          ['Size', formatBytes(size)],
          ['Format', String(meta.format || ext(file)).toUpperCase()],
          ['Dimensions', `${swap ? meta.height : meta.width} × ${swap ? meta.width : meta.height} px`],
          ['Megapixels', (((meta.width || 0) * (meta.height || 0)) / 1e6).toFixed(2)],
          ['Color space', meta.space || '-'],
          ['Channels', meta.channels],
          ['Bit depth', meta.depth || '-'],
          ['Transparency', meta.hasAlpha ? 'Yes' : 'No'],
          ['DPI', meta.density || '-'],
          ['Frames', meta.pages || 1],
          ['Orientation', meta.orientation || 1],
          ['Color profile', meta.icc ? 'Embedded' : 'None'],
          ['Progressive', meta.isProgressive ? 'Yes' : 'No'],
        ];
        if (stats && stats.dominant) rows.push(['Dominant color', toHex([stats.dominant.r, stats.dominant.g, stats.dominant.b])]);
        if (meta.exif) {
          try {
            const exif = require('exif-reader')(meta.exif);
            const image = exif.Image || exif.image || {};
            const photo = exif.Photo || exif.exif || {};
            const gps = exif.GPSInfo || exif.gps || {};
            const add = (label, value) => value !== undefined && value !== null && value !== '' && rows.push([label, value instanceof Date ? value.toLocaleString() : String(value)]);
            add('Camera', [image.Make, image.Model].filter(Boolean).join(' '));
            add('Lens', photo.LensModel);
            add('Taken', photo.DateTimeOriginal);
            add('Exposure', photo.ExposureTime ? (photo.ExposureTime < 1 ? `1/${Math.round(1 / photo.ExposureTime)} s` : `${photo.ExposureTime} s`) : null);
            add('Aperture', photo.FNumber ? `f/${photo.FNumber}` : null);
            add('ISO', photo.ISOSpeedRatings || photo.PhotographicSensitivity);
            add('Focal length', photo.FocalLength ? `${photo.FocalLength} mm` : null);
            add('Software', image.Software);
            const lat = dmsToDecimal(gps.GPSLatitude, gps.GPSLatitudeRef);
            const lon = dmsToDecimal(gps.GPSLongitude, gps.GPSLongitudeRef);
            if (lat !== null && lon !== null) add('GPS', `${lat}, ${lon}`);
          } catch {}
        }
        sections.push({ title: path.basename(file), table: { columns: ['Property', 'Value'], rows }, image: file });
        return null;
      });
      result.sections = sections;
      return result;
    },
  },
  {
    id: 'image.palette',
    name: 'Extract color palette',
    icon: '🌈',
    description: 'Find the dominant colors of an image and export them as a swatch image.',
    keywords: ['colors', 'swatch', 'hex', 'dominant', 'design'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [o.range('count', 'Number of colors', 2, 16, 6), o.checkbox('save', 'Save swatch image', true)],
    actionLabel: 'Extract',
    async run(ctx) {
      const sections = [];
      const result = await ctx.eachFile(async (file) => {
        const img = await oriented(file);
        const { data } = await img.resize(96, 96, { fit: 'inside' }).flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const palette = kmeans(data, ctx.options.count);
        const colors = palette.map((p) => ({ hex: toHex(p.rgb), share: p.share }));
        sections.push({
          title: path.basename(file),
          colors,
          table: { columns: ['Color', 'RGB', 'Share'], rows: palette.map((p) => [toHex(p.rgb), `rgb(${p.rgb.join(', ')})`, `${(p.share * 100).toFixed(1)}%`]) },
        });
        if (!ctx.options.save) return null;
        const sw = 160;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sw * colors.length}" height="220">${colors
          .map((c, i) => {
            const rgb = hexToRgb(c.hex);
            const light = rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114 > 150;
            return `<rect x="${i * sw}" y="0" width="${sw}" height="220" fill="${c.hex}"/><text x="${i * sw + sw / 2}" y="200" text-anchor="middle" font-family="Segoe UI, Arial" font-size="20" font-weight="600" fill="${light ? '#111' : '#fff'}">${c.hex.toUpperCase()}</text>`;
          })
          .join('')}</svg>`;
        const out = await ctx.output(file, { suffix: '_palette', extension: 'png' });
        await sharp(Buffer.from(svg)).png().toFile(out);
        return out;
      });
      result.sections = sections;
      return result;
    },
  },
  {
    id: 'image.combine',
    name: 'Combine images',
    icon: '🧩',
    description: 'Stitch images side by side, stacked vertically or in a grid collage.',
    keywords: ['collage', 'stitch', 'merge', 'grid', 'join'],
    input: { kind: 'files', accept: IMAGE_IN, min: 2, ordered: true },
    options: [
      o.select('layout', 'Layout', [['horizontal', 'Side by side'], ['vertical', 'Stacked'], ['grid', 'Grid']], 'horizontal'),
      o.number('columns', 'Columns', 2, { min: 1, max: 20, ...o.when('layout', 'grid') }),
      o.number('spacing', 'Spacing (px)', 0, { min: 0, max: 500 }),
      o.color('background', 'Background', '#ffffff'),
      o.checkbox('match', 'Match sizes', true),
      o.select('format', 'Output format', ['png', 'jpg', 'webp'], 'png'),
      o.text('name', 'Output name', 'combined'),
    ],
    actionLabel: 'Combine',
    async run(ctx) {
      const opt = ctx.options;
      const items = [];
      for (let i = 0; i < ctx.files.length; i++) {
        ctx.check();
        ctx.progress((i / ctx.files.length) * 70, `Loading ${path.basename(ctx.files[i])}`);
        items.push(await materialize(await oriented(ctx.files[i])));
      }
      const gap = Number(opt.spacing) || 0;
      let placements = [];
      let canvasW = 0;
      let canvasH = 0;
      if (opt.layout === 'horizontal') {
        const h = opt.match ? Math.min(...items.map((it) => it.height)) : Math.max(...items.map((it) => it.height));
        let x = 0;
        for (const it of items) {
          const buf = opt.match ? await sharp(it.buffer).resize({ height: h }).png().toBuffer({ resolveWithObject: true }) : { data: it.buffer, info: { width: it.width, height: it.height } };
          placements.push({ input: buf.data, left: x, top: Math.round((h - buf.info.height) / 2) });
          x += buf.info.width + gap;
        }
        canvasW = x - gap;
        canvasH = h;
      } else if (opt.layout === 'vertical') {
        const w = opt.match ? Math.min(...items.map((it) => it.width)) : Math.max(...items.map((it) => it.width));
        let y = 0;
        for (const it of items) {
          const buf = opt.match ? await sharp(it.buffer).resize({ width: w }).png().toBuffer({ resolveWithObject: true }) : { data: it.buffer, info: { width: it.width, height: it.height } };
          placements.push({ input: buf.data, left: Math.round((w - buf.info.width) / 2), top: y });
          y += buf.info.height + gap;
        }
        canvasW = w;
        canvasH = y - gap;
      } else {
        const cols = Math.max(1, Math.min(Number(opt.columns) || 2, items.length));
        const rows = Math.ceil(items.length / cols);
        const cellW = Math.min(...items.map((it) => it.width));
        const cellH = Math.round(cellW * (items[0].height / items[0].width));
        for (let i = 0; i < items.length; i++) {
          const buf = await sharp(items[i].buffer)
            .resize(cellW, cellH, { fit: opt.match ? 'cover' : 'contain', background: opt.background })
            .png()
            .toBuffer();
          placements.push({ input: buf, left: (i % cols) * (cellW + gap), top: Math.floor(i / cols) * (cellH + gap) });
        }
        canvasW = cols * cellW + (cols - 1) * gap;
        canvasH = rows * cellH + (rows - 1) * gap;
      }
      ctx.progress(85, 'Composing');
      const canvas = sharp({ create: { width: canvasW, height: canvasH, channels: 4, background: opt.background }, limitInputPixels: false }).composite(placements);
      const buffer = await encode(sharp(await canvas.png().toBuffer(), { limitInputPixels: false }), opt.format, { quality: 92, background: opt.background });
      const out = await ctx.output(ctx.files[0], { name: opt.name || 'combined', extension: opt.format });
      await fsp.writeFile(out, buffer);
      ctx.progress(100);
      return { outputs: [out], summary: `${canvasW} × ${canvasH} px` };
    },
  },
  {
    id: 'image.split',
    name: 'Split into tiles',
    icon: '🔲',
    description: 'Cut an image into a grid of tiles, perfect for Instagram grids or sprite sheets.',
    keywords: ['grid', 'tiles', 'slice', 'instagram', 'sprite'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [o.number('rows', 'Rows', 3, { min: 1, max: 50 }), o.number('cols', 'Columns', 3, { min: 1, max: 50 })],
    actionLabel: 'Split',
    async run(ctx) {
      const rows = Math.max(1, Number(ctx.options.rows) || 1);
      const cols = Math.max(1, Number(ctx.options.cols) || 1);
      return ctx.eachFile(async (file) => {
        const format = sameFormat(file) === 'ico' ? 'png' : sameFormat(file);
        const { buffer, width, height } = await materialize(await oriented(file));
        const dir = await ctx.outputFolder(file, '_tiles');
        const outputs = [];
        const tileW = Math.floor(width / cols);
        const tileH = Math.floor(height / rows);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const tile = sharp(buffer).extract({ left: c * tileW, top: r * tileH, width: c === cols - 1 ? width - c * tileW : tileW, height: r === rows - 1 ? height - r * tileH : tileH });
            const target = path.join(dir, `${baseName(file)}_r${r + 1}_c${c + 1}.${outExtFor(file, format)}`);
            await fsp.writeFile(target, await encode(tile, format, { quality: 95 }));
            outputs.push(target);
            ctx.stepProgress((r * cols + c + 1) / (rows * cols));
          }
        }
        return outputs;
      });
    },
  },
  {
    id: 'image.border',
    name: 'Border & round corners',
    icon: '🖼️',
    description: 'Add a colored border, padding and rounded corners.',
    keywords: ['frame', 'rounded', 'padding', 'radius'],
    input: { kind: 'files', accept: IMAGE_IN },
    options: [
      o.range('radius', 'Corner radius (%)', 0, 50, 8),
      o.number('border', 'Border width (px)', 20, { min: 0, max: 2000 }),
      o.color('color', 'Border color', '#ffffff'),
      o.checkbox('transparent', 'Transparent outside corners (PNG)', true),
    ],
    actionLabel: 'Apply',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const { buffer, width, height } = await materialize(await oriented(file));
        const radius = Math.round((Math.min(width, height) * opt.radius) / 100);
        const border = Math.max(0, Number(opt.border) || 0);
        let inner = buffer;
        if (radius > 0) {
          const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}"/></svg>`);
          inner = await sharp(buffer).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
        }
        const W = width + border * 2;
        const H = height + border * 2;
        const outerRadius = radius ? radius + border : 0;
        const frameSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="${outerRadius}" ry="${outerRadius}" fill="${opt.color}"/></svg>`;
        const base = border > 0 ? sharp(Buffer.from(frameSvg)) : sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
        const composed = base.composite([{ input: inner, left: border, top: border }]);
        const keepAlpha = opt.transparent && (radius > 0 || border === 0);
        let format = keepAlpha ? (['webp', 'avif', 'png'].includes(sameFormat(file)) ? sameFormat(file) : 'png') : sameFormat(file);
        if (format === 'ico' || format === 'bmp') format = 'png';
        const buffer2 = await encode(sharp(await composed.png().toBuffer()), format, { quality: 92, background: opt.color });
        return save(ctx, file, buffer2, format, '_framed');
      });
    },
  },
  {
    id: 'image.animate',
    name: 'Images → GIF / video',
    icon: '🎞️',
    description: 'Turn a series of images into an animated GIF, animated WebP or an MP4 slideshow.',
    keywords: ['animation', 'slideshow', 'gif maker', 'frames'],
    input: { kind: 'files', accept: IMAGE_IN, min: 2, ordered: true },
    options: [
      o.select('format', 'Output', [['gif', 'GIF'], ['webp', 'Animated WebP'], ['mp4', 'MP4 video']], 'gif'),
      o.number('delay', 'Frame duration (ms)', 500, { min: 20, max: 20000 }),
      o.select('width', 'Width', [['320', '320 px'], ['480', '480 px'], ['640', '640 px'], ['800', '800 px'], ['1080', '1080 px'], ['1920', '1920 px']], '640'),
      o.checkbox('loop', 'Loop forever', true, o.when('format', ['gif', 'webp'])),
      o.color('background', 'Background', '#000000'),
      o.text('name', 'Output name', 'animation'),
    ],
    actionLabel: 'Create',
    async run(ctx) {
      const opt = ctx.options;
      const dir = await tempDir('uft-frames-');
      ctx.onCleanup(() => removeQuiet(dir));
      const width = Number(opt.width);
      const first = await dimensions(await oriented(ctx.files[0]));
      let height = Math.round((width * first.height) / first.width);
      height += height % 2;
      for (let i = 0; i < ctx.files.length; i++) {
        ctx.check();
        ctx.progress((i / ctx.files.length) * 40, `Preparing frame ${i + 1}`);
        const img = await oriented(ctx.files[i]);
        await img.resize(width, height, { fit: 'contain', background: opt.background }).flatten({ background: opt.background }).png().toFile(path.join(dir, `frame_${String(i + 1).padStart(5, '0')}.png`));
      }
      const fps = (1000 / Math.max(20, Number(opt.delay))).toFixed(4);
      const out = await ctx.output(ctx.files[0], { name: opt.name || 'animation', extension: opt.format });
      const input = ['-framerate', fps, '-i', path.join(dir, 'frame_%05d.png')];
      const duration = (ctx.files.length * Number(opt.delay)) / 1000;
      const progress = (f) => ctx.progress(40 + f * 60, 'Encoding');
      if (opt.format === 'gif') {
        await runFfmpeg(ctx, [...input, '-filter_complex', 'split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a', '-loop', opt.loop ? '0' : '-1', out], { duration, onProgress: progress });
      } else if (opt.format === 'webp') {
        await runFfmpeg(ctx, [...input, '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '80', '-loop', opt.loop ? '0' : '1', out], { duration, onProgress: progress });
      } else {
        await runFfmpeg(ctx, [...input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', out], { duration, onProgress: progress });
      }
      return { outputs: [out], summary: `${ctx.files.length} frames, ${duration.toFixed(1)} s` };
    },
  },
];

module.exports = {
  category: { id: 'image', name: 'Images', icon: '🖼️', color: ['#ff0080', '#ff6a00'], description: 'Convert, compress, resize, edit and inspect pictures' },
  tools,
  loadImage,
  oriented,
  encode,
  materialize,
};
