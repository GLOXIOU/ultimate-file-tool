const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const { exists, sanitizeName, uniquePath } = require('../core/util');
const { downloadTo } = require('../core/net');
const { toPdf, screenshot } = require('../core/render');
const { ffmpegPath } = require('../core/ffmpeg');
const o = require('../core/opts');

const YTDLP_ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' };

function binDir() {
  const electron = require('electron');
  const base = electron && electron.app ? electron.app.getPath('userData') : require('os').tmpdir();
  return path.join(base, 'bin');
}

function ytdlpPath() {
  return path.join(binDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function runCapture(file, args, ctx) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    if (ctx) ctx.track(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function ytdlpVersion() {
  if (!(await exists(ytdlpPath()))) return null;
  const { code, out } = await runCapture(ytdlpPath(), ['--version']);
  return code === 0 ? out.trim() : null;
}

async function installYtdlp(ctx) {
  const asset = YTDLP_ASSET[process.platform];
  if (!asset) throw new Error(`yt-dlp is not available for ${process.platform}`);
  await fsp.mkdir(binDir(), { recursive: true });
  if (ctx) ctx.message('Downloading yt-dlp (first use only)…');
  await downloadTo(ctx, `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, {
    file: ytdlpPath(),
    onProgress: (f) => ctx && ctx.progress(f * 100, 'Downloading yt-dlp (first use only)…'),
  });
  if (process.platform !== 'win32') await fsp.chmod(ytdlpPath(), 0o755);
}

async function ensureYtdlp(ctx) {
  if (!(await exists(ytdlpPath()))) await installYtdlp(ctx);
}

function normalizeUrls(text) {
  return String(text || '')
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`))
    .filter((u) => {
      try {
        const parsed = new URL(u);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    });
}

function nameFromUrl(url) {
  try {
    const u = new URL(url);
    return sanitizeName(`${u.hostname}${u.pathname.replace(/\/$/, '')}`.replace(/[/.]+/g, '_')).slice(0, 80) || 'page';
  } catch {
    return 'page';
  }
}

function ytdlpDownload(ctx, url, dir, opt) {
  return new Promise((resolve, reject) => {
    const args = [
      '--newline',
      '--no-colors',
      '--quiet',
      '--progress',
      '--no-warnings',
      '--ffmpeg-location',
      path.dirname(ffmpegPath),
      '-P',
      dir,
      '--print',
      'after_move:UFTFILE:%(filepath)s',
      '--progress-template',
      'download:UFTPROG %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.title)s',
    ];
    if (opt.playlist) args.push('--yes-playlist', '-o', '%(playlist_title|Playlist)s/%(playlist_index|0)03d - %(title).150B [%(id)s].%(ext)s');
    else args.push('--no-playlist', '-o', '%(title).150B [%(id)s].%(ext)s');
    if (opt.mode === 'audio') {
      args.push('-f', 'ba/b', '-x', '--audio-format', opt.audioFormat, '--audio-quality', opt.audioFormat === 'wav' || opt.audioFormat === 'flac' ? '0' : opt.audioQuality);
    } else {
      const sort = [];
      if (opt.quality !== 'best') sort.push(`res:${opt.quality}`);
      if (opt.container === 'mp4') sort.push('vcodec:h264', 'acodec:m4a');
      if (opt.container === 'webm') sort.push('vcodec:vp9');
      args.push('-f', 'bv*+ba/b', '--merge-output-format', opt.container);
      if (sort.length) args.push('-S', sort.join(','));
      if (opt.subtitles) args.push('--write-subs', '--sub-langs', opt.subLangs || 'en.*', '--embed-subs');
    }
    if (opt.metadata) {
      args.push('--embed-metadata');
      if (opt.mode === 'audio' ? ['mp3', 'm4a', 'flac', 'opus'].includes(opt.audioFormat) : opt.container !== 'webm') args.push('--embed-thumbnail');
    }
    args.push(url);
    ctx.log(`yt-dlp ${args.join(' ')}`);
    const child = spawn(ytdlpPath(), args, { windowsHide: true });
    ctx.track(child);
    const files = [];
    const errors = [];
    let buffer = '';
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('UFTPROG')) {
          const [pct, speed, eta, title] = line.slice(8).split('|');
          const value = parseFloat(pct);
          ctx.stepProgress(Number.isFinite(value) ? value / 100 : 0, [title && title !== 'NA' ? title : null, speed && speed.trim() !== 'NA' ? speed.trim() : null, eta && eta.trim() !== 'NA' ? `ETA ${eta.trim()}` : null].filter(Boolean).join(' · '));
        } else if (line.startsWith('UFTFILE:')) {
          files.push(line.slice(8).trim());
        }
      }
    });
    child.stderr.on('data', (data) => {
      for (const line of data.toString().split(/\r?\n/)) if (/^ERROR:/i.test(line.trim())) errors.push(line.trim().replace(/^ERROR:\s*/i, ''));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (ctx.cancelled) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (code !== 0 && !files.length) return reject(new Error(errors[errors.length - 1] || `yt-dlp exited with code ${code}`));
      resolve({ files, errors });
    });
  });
}

const tools = [
  {
    id: 'web.media',
    name: 'Media downloader',
    icon: '⬇️',
    description: 'Download videos or audio from YouTube and 1000+ sites with yt-dlp. Playlists, 4K, MP3, subtitles.',
    keywords: ['youtube', 'download video', 'youtube to mp3', 'yt-dlp', 'playlist', 'twitter', 'tiktok', 'vimeo', 'soundcloud'],
    input: { kind: 'none' },
    options: [
      o.textarea('urls', 'Links (one per line)', '', { required: true, placeholder: 'https://www.youtube.com/watch?v=…', rows: 3 }),
      o.select('mode', 'Download', [['video', 'Video'], ['audio', 'Audio only']], 'video'),
      o.select('quality', 'Max quality', [['best', 'Best'], ['2160', '4K'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']], '1080', o.when('mode', 'video')),
      o.select('container', 'Container', [['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WebM']], 'mp4', o.when('mode', 'video')),
      o.select('audioFormat', 'Audio format', [['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'Opus'], ['flac', 'FLAC'], ['wav', 'WAV']], 'mp3', o.when('mode', 'audio')),
      o.select('audioQuality', 'Audio bitrate', [['320K', '320 kbps'], ['256K', '256 kbps'], ['192K', '192 kbps'], ['128K', '128 kbps']], '192K', { showIf: { mode: ['audio'], audioFormat: ['mp3', 'm4a', 'opus'] } }),
      o.checkbox('playlist', 'Download whole playlists', false),
      o.checkbox('metadata', 'Embed title, artist and thumbnail', true),
      o.checkbox('subtitles', 'Embed subtitles', false, o.when('mode', 'video')),
      o.text('subLangs', 'Subtitle languages', 'en.*,fr.*', { showIf: { mode: ['video'], subtitles: [true] } }),
    ],
    actionLabel: 'Download',
    help: 'Only download content you have the right to.',
    async run(ctx) {
      const urls = normalizeUrls(ctx.options.urls);
      if (!urls.length) throw new Error('Paste at least one valid link');
      await ensureYtdlp(ctx);
      const dir = ctx.dirFor(null);
      await fsp.mkdir(dir, { recursive: true });
      const outputs = [];
      const errors = [];
      for (let i = 0; i < urls.length; i++) {
        ctx.check();
        ctx.setStep(i, urls.length, urls[i]);
        try {
          const res = await ytdlpDownload(ctx, urls[i], dir, ctx.options);
          outputs.push(...res.files);
          for (const e of res.errors) errors.push({ file: urls[i], error: e });
        } catch (error) {
          if (error.cancelled) throw error;
          errors.push({ file: urls[i], error: error.message });
        }
      }
      ctx.progress(100);
      return { outputs, errors };
    },
  },
  {
    id: 'web.download',
    name: 'Direct file downloader',
    icon: '🌐',
    description: 'Download files from direct links with progress, in batch.',
    keywords: ['url', 'http', 'download link', 'wget', 'curl'],
    input: { kind: 'none' },
    options: [o.textarea('urls', 'Links (one per line)', '', { required: true, placeholder: 'https://example.com/file.zip', rows: 4 })],
    actionLabel: 'Download',
    async run(ctx) {
      const urls = normalizeUrls(ctx.options.urls);
      if (!urls.length) throw new Error('Paste at least one valid link');
      const dir = ctx.dirFor(null);
      await fsp.mkdir(dir, { recursive: true });
      return ctx.eachFile(async (url) => {
        const { file } = await downloadTo(ctx, url, { dir, onProgress: (f, received) => ctx.stepProgress(f, `${(received / 1048576).toFixed(1)} MB`) });
        return file;
      }, urls);
    },
  },
  {
    id: 'web.pdf',
    name: 'Web page to PDF',
    icon: '📰',
    description: 'Save any web page as a clean, printable PDF.',
    keywords: ['html to pdf', 'save page', 'print', 'article', 'url to pdf'],
    input: { kind: 'none' },
    options: [
      o.text('url', 'Page URL', '', { required: true, wide: true, placeholder: 'https://…' }),
      o.select('pageSize', 'Page size', [['A4', 'A4'], ['Letter', 'Letter'], ['A3', 'A3'], ['Legal', 'Legal']], 'A4'),
      o.select('margins', 'Margins', [['none', 'None'], ['narrow', 'Narrow'], ['normal', 'Normal']], 'narrow'),
      o.checkbox('landscape', 'Landscape', false),
      o.checkbox('background', 'Print backgrounds', true),
      o.number('delay', 'Wait before printing (s)', 2, { min: 0, max: 30, step: 0.5 }),
    ],
    actionLabel: 'Save PDF',
    async run(ctx) {
      const [url] = normalizeUrls(ctx.options.url);
      if (!url) throw new Error('Enter a valid URL');
      ctx.setStep(0, 1, `Loading ${url}`);
      const dir = ctx.dirFor(null);
      await fsp.mkdir(dir, { recursive: true });
      const target = await uniquePath(path.join(dir, `${nameFromUrl(url)}.pdf`));
      await toPdf({ url }, target, { pageSize: ctx.options.pageSize, margins: ctx.options.margins, landscape: ctx.options.landscape, printBackground: ctx.options.background, delay: Number(ctx.options.delay) * 1000 });
      ctx.progress(100);
      return { outputs: [target] };
    },
  },
  {
    id: 'web.screenshot',
    name: 'Website screenshot',
    icon: '📸',
    description: 'Capture a full-page or viewport screenshot of any website, desktop or mobile size.',
    keywords: ['capture', 'screenshot', 'full page', 'mockup', 'url to image'],
    input: { kind: 'none' },
    options: [
      o.text('url', 'Page URL', '', { required: true, wide: true, placeholder: 'https://…' }),
      o.select('device', 'Viewport', [['1920x1080', 'Desktop 1920'], ['1366x768', 'Laptop 1366'], ['768x1024', 'Tablet'], ['390x844', 'Mobile']], '1366x768'),
      o.checkbox('fullPage', 'Capture the full page', true),
      o.select('format', 'Format', ['png', 'jpg'], 'png'),
      o.number('delay', 'Wait before capture (s)', 2, { min: 0, max: 30, step: 0.5 }),
    ],
    actionLabel: 'Capture',
    async run(ctx) {
      const [url] = normalizeUrls(ctx.options.url);
      if (!url) throw new Error('Enter a valid URL');
      const [width, height] = ctx.options.device.split('x').map(Number);
      ctx.setStep(0, 1, `Loading ${url}`);
      const dir = ctx.dirFor(null);
      await fsp.mkdir(dir, { recursive: true });
      const target = await uniquePath(path.join(dir, `${nameFromUrl(url)}.${ctx.options.format}`));
      await screenshot(url, target, { width, height, fullPage: ctx.options.fullPage, format: ctx.options.format, delay: Number(ctx.options.delay) });
      ctx.progress(100);
      return { outputs: [target] };
    },
  },
];

module.exports = {
  category: { id: 'web', name: 'Web & Download', icon: '🌍', color: ['#00b09b', '#96c93d'], description: 'Download media, files, pages and screenshots' },
  tools,
  services: {
    'web.ytdlpStatus': async () => ({ installed: Boolean(await ytdlpVersion()), version: (await ytdlpVersion()) || null, path: ytdlpPath() }),
    'web.ytdlpUpdate': async () => {
      if (!(await exists(ytdlpPath()))) {
        await installYtdlp(null);
        return { message: `yt-dlp ${await ytdlpVersion()} installed` };
      }
      const { code, out, err } = await runCapture(ytdlpPath(), ['-U']);
      if (code !== 0) {
        await installYtdlp(null);
        return { message: `yt-dlp ${await ytdlpVersion()} reinstalled` };
      }
      return { message: (out || err).trim().split(/\r?\n/).pop() || 'yt-dlp is up to date' };
    },
  },
};
