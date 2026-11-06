const path = require('path');
const fsp = require('fs').promises;
const { probe, run, atempoChain } = require('../core/ffmpeg');
const { ext, baseName, parseTime, formatBytes, formatDuration } = require('../core/util');
const { VIDEO_IN, AUDIO_IN, IMAGE_IN } = require('../core/formats');
const { EVEN, videoArgs, audioArgs } = require('./media-presets');
const o = require('../core/opts');

const VIDEO_OUT = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'mpeg', 'ogv', '3gp', 'ts'];
const QUALITY = [['high', 'High'], ['balanced', 'Balanced'], ['small', 'Small'], ['tiny', 'Tiny']];

function containerFor(file) {
  const e = ext(file);
  return videoArgs(e) ? e : 'mp4';
}

function encodeFor(file, quality = 'high') {
  const container = containerFor(file);
  return { container, args: videoArgs(container, quality) };
}

function mediaTable(info, file, size) {
  const rows = [
    ['File', path.basename(file)],
    ['Size', formatBytes(size)],
    ['Container', info.format || '-'],
    ['Duration', info.duration ? formatDuration(info.duration) : '-'],
    ['Overall bitrate', info.bitrate ? `${info.bitrate} kb/s` : '-'],
  ];
  info.streams.forEach((s, i) => {
    const label = `${s.type[0].toUpperCase()}${s.type.slice(1)} #${i}`;
    let detail = s.codec;
    if (s.type === 'video') detail += `${s.width ? `, ${s.width}×${s.height}` : ''}${s.fps ? `, ${s.fps} fps` : ''}${s.attachedPic ? ' (cover art)' : ''}`;
    if (s.type === 'audio') detail += `${s.sampleRate ? `, ${s.sampleRate} Hz` : ''}${s.channels ? `, ${s.channels}` : ''}${s.bitrate ? `, ${s.bitrate} kb/s` : ''}`;
    if (s.language) detail += ` [${s.language}]`;
    rows.push([label, detail]);
  });
  for (const [k, v] of Object.entries(info.metadata || {})) rows.push([`Tag: ${k}`, v]);
  return { columns: ['Property', 'Value'], rows };
}

const tools = [
  {
    id: 'video.convert',
    name: 'Convert videos',
    icon: '🔄',
    description: 'Convert between MP4, MKV, WebM, MOV, AVI, WMV, FLV, MPEG, OGV, 3GP and more.',
    keywords: ['mkv to mp4', 'mov to mp4', 'avi', 'webm', 'gif to mp4', 'transcode'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [
      o.select('format', 'Output format', VIDEO_OUT, 'mp4'),
      o.select('quality', 'Quality', QUALITY, 'balanced'),
      o.checkbox('remux', 'Fast mode: copy streams without re-encoding (when compatible)', false),
    ],
    actionLabel: 'Convert',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        const out = await ctx.output(file, { extension: opt.format });
        if (opt.remux) {
          try {
            await run(ctx, ['-i', file, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', out], { duration: info.duration });
            return out;
          } catch (error) {
            if (ctx.cancelled) throw error;
            ctx.log(`Remux failed, re-encoding: ${error.message}`);
          }
        }
        await run(ctx, ['-i', file, '-vf', EVEN, ...videoArgs(opt.format, opt.quality), '-map_metadata', '0', out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'video.compress',
    name: 'Compress videos',
    icon: '🗜️',
    description: 'Reduce video size by quality level or hit an exact target size (e.g. 10 MB for Discord).',
    keywords: ['reduce size', 'discord', 'whatsapp', 'email', 'smaller', 'h265', 'hevc'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [
      o.select('mode', 'Mode', [['quality', 'Quality level'], ['size', 'Target size']], 'quality'),
      o.select('quality', 'Quality', QUALITY, 'small', o.when('mode', 'quality')),
      o.number('targetMb', 'Target size (MB)', 10, { min: 1, step: 0.5, ...o.when('mode', 'size') }),
      o.select('resolution', 'Max resolution', [['0', 'Keep'], ['2160', '4K'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']], '0'),
      o.select('codec', 'Codec', [['h264', 'H.264 (compatible)'], ['h265', 'H.265 (smaller)']], 'h264'),
      o.select('audio', 'Audio', [['128k', '128 kbps'], ['96k', '96 kbps'], ['64k', '64 kbps'], ['none', 'Remove audio']], '128k'),
      o.select('preset', 'Speed', [['veryfast', 'Fast'], ['medium', 'Balanced'], ['slow', 'Best compression']], 'medium'),
    ],
    actionLabel: 'Compress',
    async run(ctx) {
      const opt = ctx.options;
      let before = 0;
      let after = 0;
      const result = await ctx.eachFile(async (file) => {
        const info = await probe(file);
        const original = (await fsp.stat(file)).size;
        const out = await ctx.output(file, { suffix: '_compressed', extension: 'mp4' });
        const height = Number(opt.resolution);
        const vf = height ? `scale=-2:'trunc(min(${height},ih)/2)*2'` : EVEN;
        const codec = opt.codec === 'h265' ? ['-c:v', 'libx265', '-tag:v', 'hvc1'] : ['-c:v', 'libx264'];
        const audio = opt.audio === 'none' ? ['-an'] : ['-c:a', 'aac', '-b:a', opt.audio];
        let rate;
        if (opt.mode === 'size') {
          if (!info.duration) throw new Error('Cannot read the video duration');
          const audioKbps = opt.audio === 'none' ? 0 : parseInt(opt.audio, 10);
          const totalKbps = (Number(opt.targetMb) * 8192 * 0.95) / info.duration;
          const videoKbps = Math.max(50, Math.floor(totalKbps - audioKbps));
          rate = ['-b:v', `${videoKbps}k`, '-maxrate', `${Math.floor(videoKbps * 1.4)}k`, '-bufsize', `${videoKbps * 2}k`];
        } else {
          const crf = { high: 21, balanced: 25, small: 29, tiny: 34 }[opt.quality] + (opt.codec === 'h265' ? 3 : 0);
          rate = ['-crf', String(crf)];
        }
        await run(ctx, ['-i', file, '-vf', vf, ...codec, '-preset', opt.preset, ...rate, '-pix_fmt', 'yuv420p', ...audio, '-movflags', '+faststart', '-sn', out], { duration: info.duration });
        const size = (await fsp.stat(out)).size;
        before += original;
        after += size;
        const pct = Math.round((1 - size / original) * 100);
        return { outputs: out, note: `${path.basename(file)}: ${formatBytes(original)} → ${formatBytes(size)} (${pct >= 0 ? '-' : '+'}${Math.abs(pct)}%)` };
      });
      if (before) result.summary = `Saved ${formatBytes(before - after)} (${Math.round(((before - after) / before) * 100)}%)`;
      return result;
    },
  },
  {
    id: 'video.trim',
    name: 'Trim / cut video',
    icon: '✂️',
    description: 'Keep only the part you need. Lossless fast cut or frame-accurate re-encode.',
    keywords: ['cut', 'clip', 'split', 'shorten', 'extract part'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [
      o.text('start', 'Start (hh:mm:ss or seconds)', '00:00:00'),
      o.text('end', 'End (empty = until the end)', ''),
      o.select('mode', 'Mode', [['accurate', 'Frame accurate'], ['fast', 'Instant (keyframes)']], 'accurate'),
    ],
    actionLabel: 'Trim',
    async run(ctx) {
      const opt = ctx.options;
      const start = parseTime(opt.start) || 0;
      const end = parseTime(opt.end);
      if (end !== null && end <= start) throw new Error('End must be after start');
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        const length = (end ?? info.duration) - start;
        const args = ['-ss', String(start), '-i', file];
        if (end !== null) args.push('-t', String(end - start));
        if (opt.mode === 'fast') {
          const out = await ctx.output(file, { suffix: '_trimmed' });
          await run(ctx, [...args, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', out], { duration: length });
          return out;
        }
        const { container, args: codec } = encodeFor(file, 'high');
        const out = await ctx.output(file, { suffix: '_trimmed', extension: container });
        await run(ctx, [...args, '-vf', EVEN, ...codec, out], { duration: length });
        return out;
      });
    },
  },
  {
    id: 'video.gif',
    name: 'Video to GIF',
    icon: '🎞️',
    description: 'Create high quality animated GIFs or WebPs with an optimized color palette.',
    keywords: ['gif maker', 'animated', 'meme', 'webp'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [
      o.select('format', 'Output', [['gif', 'GIF'], ['webp', 'Animated WebP']], 'gif'),
      o.text('start', 'Start (hh:mm:ss)', '0'),
      o.text('duration', 'Duration in seconds (empty = all)', '5'),
      o.select('fps', 'Frame rate', [['10', '10 fps'], ['15', '15 fps'], ['20', '20 fps'], ['24', '24 fps'], ['30', '30 fps']], '15'),
      o.select('width', 'Width', [['240', '240 px'], ['320', '320 px'], ['480', '480 px'], ['640', '640 px'], ['800', '800 px'], ['-1', 'Original']], '480'),
      o.select('dither', 'Dithering', [['sierra2_4a', 'Smooth'], ['bayer', 'Pattern (smaller)'], ['none', 'None (flat)']], 'sierra2_4a', o.when('format', 'gif')),
    ],
    actionLabel: 'Create GIF',
    async run(ctx) {
      const opt = ctx.options;
      const start = parseTime(opt.start) || 0;
      const dur = parseTime(opt.duration);
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        const length = dur || Math.max(0.1, (info.duration || 0) - start);
        const scale = opt.width === '-1' ? 'scale=iw:-1:flags=lanczos' : `scale=${opt.width}:-1:flags=lanczos`;
        const args = ['-ss', String(start), ...(dur ? ['-t', String(dur)] : []), '-i', file];
        const out = await ctx.output(file, { extension: opt.format });
        if (opt.format === 'gif') {
          const dither = opt.dither === 'bayer' ? 'dither=bayer:bayer_scale=4' : `dither=${opt.dither}`;
          await run(ctx, [...args, '-vf', `fps=${opt.fps},${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=${dither}:diff_mode=rectangle`, '-loop', '0', out], { duration: length });
        } else {
          await run(ctx, [...args, '-vf', `fps=${opt.fps},${scale}`, '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '75', '-loop', '0', '-an', out], { duration: length });
        }
        return out;
      });
    },
  },
  {
    id: 'video.extractAudio',
    name: 'Extract audio',
    icon: '🎧',
    description: 'Save the soundtrack of a video as MP3, M4A, WAV, FLAC, OGG or Opus.',
    keywords: ['mp4 to mp3', 'video to mp3', 'rip audio', 'soundtrack'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [
      o.select('format', 'Format', ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'], 'mp3'),
      o.select('bitrate', 'Bitrate', [['320k', '320 kbps'], ['256k', '256 kbps'], ['192k', '192 kbps'], ['128k', '128 kbps'], ['96k', '96 kbps']], '192k', o.when('format', ['mp3', 'm4a', 'ogg', 'opus'])),
    ],
    actionLabel: 'Extract',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        if (!info.audio) throw new Error('This video has no audio track');
        const { ext: outExt, args } = audioArgs(opt.format, opt.bitrate);
        const out = await ctx.output(file, { extension: outExt });
        await run(ctx, ['-i', file, ...args, out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'video.mute',
    name: 'Remove audio',
    icon: '🔇',
    description: 'Strip the audio track instantly without re-encoding the video.',
    keywords: ['mute', 'silent', 'no sound'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [],
    actionLabel: 'Remove audio',
    async run(ctx) {
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        const out = await ctx.output(file, { suffix: '_muted' });
        await run(ctx, ['-i', file, '-map', '0:v', '-c', 'copy', '-an', out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'video.resize',
    name: 'Resize video',
    icon: '📐',
    description: 'Change resolution to 4K, 1080p, 720p, 480p or a custom width.',
    keywords: ['resolution', 'scale', 'downscale', '1080p', '720p'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [
      o.select('height', 'Resolution', [['2160', '2160p (4K)'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p'], ['240', '240p'], ['custom', 'Custom width']], '720'),
      o.number('width', 'Width (px)', 1280, { min: 16, ...o.when('height', 'custom') }),
      o.select('quality', 'Quality', QUALITY, 'high'),
    ],
    actionLabel: 'Resize',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        const container = containerFor(file);
        const vf = opt.height === 'custom' ? `scale=${Math.round(opt.width / 2) * 2}:-2:flags=lanczos` : `scale=-2:${opt.height}:flags=lanczos`;
        const out = await ctx.output(file, { suffix: `_${opt.height === 'custom' ? `${opt.width}w` : `${opt.height}p`}`, extension: container });
        await run(ctx, ['-i', file, '-vf', vf, ...videoArgs(container, opt.quality), out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'video.crop',
    name: 'Crop to aspect ratio',
    icon: '📱',
    description: 'Center-crop videos to 9:16 for TikTok/Reels/Shorts, 1:1, 4:5 or 16:9.',
    keywords: ['vertical', 'tiktok', 'reels', 'shorts', 'square', 'portrait'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [
      o.select('ratio', 'Aspect ratio', [['9:16', '9:16 vertical'], ['1:1', '1:1 square'], ['4:5', '4:5 portrait'], ['16:9', '16:9 wide'], ['4:3', '4:3'], ['21:9', '21:9 cinema']], '9:16'),
      o.select('anchor', 'Keep', [['center', 'Center'], ['start', 'Left / top'], ['end', 'Right / bottom']], 'center'),
      o.select('quality', 'Quality', QUALITY, 'high'),
    ],
    actionLabel: 'Crop',
    async run(ctx) {
      const opt = ctx.options;
      const [rw, rh] = opt.ratio.split(':').map(Number);
      const r = rw / rh;
      const w = `trunc(min(iw\\,ih*${r})/2)*2`;
      const h = `trunc(min(ih\\,iw/${r})/2)*2`;
      const pos = { center: ['(iw-ow)/2', '(ih-oh)/2'], start: ['0', '0'], end: ['iw-ow', 'ih-oh'] }[opt.anchor];
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        const container = containerFor(file);
        const out = await ctx.output(file, { suffix: `_${rw}x${rh}`, extension: container });
        await run(ctx, ['-i', file, '-vf', `crop=${w}:${h}:${pos[0]}:${pos[1]}`, ...videoArgs(container, opt.quality), out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'video.speed',
    name: 'Change speed',
    icon: '⏩',
    description: 'Speed up or slow down videos from 0.25× to 4× with pitch-corrected audio.',
    keywords: ['slow motion', 'timelapse', 'fast forward'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [
      o.select('speed', 'Speed', [['0.25', '0.25×'], ['0.5', '0.5×'], ['0.75', '0.75×'], ['1.25', '1.25×'], ['1.5', '1.5×'], ['2', '2×'], ['3', '3×'], ['4', '4×'], ['custom', 'Custom']], '2'),
      o.number('custom', 'Custom factor', 1.1, { min: 0.1, max: 16, step: 0.05, ...o.when('speed', 'custom') }),
      o.checkbox('keepAudio', 'Keep audio', true),
    ],
    actionLabel: 'Apply',
    async run(ctx) {
      const opt = ctx.options;
      const factor = opt.speed === 'custom' ? Number(opt.custom) : Number(opt.speed);
      if (!(factor > 0)) throw new Error('Invalid speed factor');
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        const container = containerFor(file);
        const out = await ctx.output(file, { suffix: `_${factor}x`, extension: container });
        const args = ['-i', file, '-filter:v', `setpts=PTS/${factor},${EVEN}`];
        if (opt.keepAudio && info.audio) args.push('-filter:a', atempoChain(factor));
        else args.push('-an');
        await run(ctx, [...args, ...videoArgs(container, 'high'), out], { duration: info.duration ? info.duration / factor : null });
        return out;
      });
    },
  },
  {
    id: 'video.rotate',
    name: 'Rotate & flip video',
    icon: '🔃',
    description: 'Rotate 90°/180° or mirror videos filmed the wrong way.',
    keywords: ['orientation', 'mirror', 'sideways', 'upside down'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [o.select('transform', 'Transform', [['cw', '90° ↻'], ['ccw', '90° ↺'], ['180', '180°'], ['hflip', 'Mirror'], ['vflip', 'Flip vertical']], 'cw')],
    actionLabel: 'Apply',
    async run(ctx) {
      const filter = { cw: 'transpose=1', ccw: 'transpose=2', 180: 'hflip,vflip', hflip: 'hflip', vflip: 'vflip' }[ctx.options.transform];
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        const container = containerFor(file);
        const out = await ctx.output(file, { suffix: '_rotated', extension: container });
        await run(ctx, ['-i', file, '-vf', `${filter},${EVEN}`, ...videoArgs(container, 'high'), '-metadata:s:v', 'rotate=0', out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'video.frames',
    name: 'Extract frames & thumbnails',
    icon: '📸',
    description: 'Grab a still at any time, export frames at intervals, or build a contact sheet.',
    keywords: ['screenshot', 'thumbnail', 'still', 'contact sheet', 'storyboard'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [
      o.select('mode', 'Mode', [['single', 'Single frame'], ['interval', 'Every N seconds'], ['count', 'N evenly spaced'], ['sheet', 'Contact sheet']], 'single'),
      o.text('time', 'Time (hh:mm:ss)', '00:00:01', o.when('mode', 'single')),
      o.number('interval', 'Interval (seconds)', 10, { min: 0.1, step: 0.5, ...o.when('mode', 'interval') }),
      o.number('count', 'Number of frames', 12, { min: 1, max: 500, ...o.when('mode', 'count') }),
      o.number('cols', 'Columns', 4, { min: 1, max: 12, ...o.when('mode', 'sheet') }),
      o.number('rows', 'Rows', 4, { min: 1, max: 12, ...o.when('mode', 'sheet') }),
      o.select('format', 'Image format', ['jpg', 'png', 'webp'], 'jpg'),
    ],
    actionLabel: 'Extract',
    async run(ctx) {
      const opt = ctx.options;
      const q = opt.format === 'jpg' ? ['-q:v', '2'] : [];
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        if (!info.video) throw new Error('No video stream');
        if (opt.mode === 'single') {
          const t = parseTime(opt.time) || 0;
          const out = await ctx.output(file, { suffix: `_${String(t).replace('.', '_')}s`, extension: opt.format });
          await run(ctx, ['-ss', String(t), '-i', file, '-frames:v', '1', ...q, out]);
          return out;
        }
        if (opt.mode === 'sheet') {
          const n = opt.cols * opt.rows;
          const fps = (n / Math.max(1, info.duration || n)).toFixed(6);
          const out = await ctx.output(file, { suffix: '_sheet', extension: opt.format });
          await run(ctx, ['-i', file, '-vf', `fps=${fps},scale=360:-2,tile=${opt.cols}x${opt.rows}:padding=6:margin=6:color=0x111111`, '-frames:v', '1', ...q, out], { duration: info.duration });
          return out;
        }
        const dir = await ctx.outputFolder(file, '_frames');
        const fps = opt.mode === 'interval' ? (1 / Number(opt.interval)).toFixed(6) : (Number(opt.count) / Math.max(1, info.duration || 1)).toFixed(6);
        const limit = opt.mode === 'count' ? ['-frames:v', String(opt.count)] : [];
        await run(ctx, ['-i', file, '-vf', `fps=${fps}`, ...limit, ...q, path.join(dir, `${baseName(file)}_%04d.${opt.format}`)], { duration: info.duration });
        const frames = (await fsp.readdir(dir)).map((f) => path.join(dir, f));
        return { outputs: frames, note: `${frames.length} frames saved to ${dir}` };
      });
    },
  },
  {
    id: 'video.merge',
    name: 'Merge videos',
    icon: '🔗',
    description: 'Join several clips into one video, even with different sizes or formats.',
    keywords: ['join', 'concat', 'combine', 'append'],
    input: { kind: 'files', accept: VIDEO_IN, min: 2, ordered: true },
    options: [
      o.select('resolution', 'Output size', [['first', 'Same as first clip'], ['1080', '1920×1080'], ['720', '1280×720'], ['vertical', '1080×1920 vertical']], 'first'),
      o.select('quality', 'Quality', QUALITY, 'high'),
      o.text('name', 'Output name', 'merged'),
    ],
    actionLabel: 'Merge',
    async run(ctx) {
      const opt = ctx.options;
      ctx.message('Analyzing clips');
      const infos = [];
      for (const f of ctx.files) infos.push(await probe(f));
      const first = infos[0].video || { width: 1280, height: 720, fps: 30 };
      const [W, H] = { first: [first.width, first.height], 1080: [1920, 1080], 720: [1280, 720], vertical: [1080, 1920] }[opt.resolution].map((v) => Math.round(v / 2) * 2);
      const fps = Math.min(60, Math.round(first.fps || 30));
      const inputs = [];
      const filters = [];
      const labels = [];
      let extra = ctx.files.length;
      ctx.files.forEach((f, i) => inputs.push('-i', f));
      infos.forEach((info, i) => {
        filters.push(`[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`);
        if (info.audio) {
          filters.push(`[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
        } else {
          inputs.push('-f', 'lavfi', '-t', String(info.duration || 1), '-i', 'anullsrc=r=48000:cl=stereo');
          filters.push(`[${extra}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
          extra++;
        }
        labels.push(`[v${i}][a${i}]`);
      });
      filters.push(`${labels.join('')}concat=n=${infos.length}:v=1:a=1[v][a]`);
      const total = infos.reduce((s, i) => s + (i.duration || 0), 0);
      const out = await ctx.output(ctx.files[0], { name: opt.name || 'merged', extension: 'mp4' });
      ctx.setStep(0, 1, 'Merging');
      await run(ctx, [...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', ...videoArgs('mp4', opt.quality), out], { duration: total });
      return { outputs: [out], summary: `${ctx.files.length} clips → ${formatDuration(total)}` };
    },
  },
  {
    id: 'video.audioTrack',
    name: 'Replace or add music',
    icon: '🎼',
    description: 'Replace the soundtrack with another audio file, or mix music under the original sound.',
    keywords: ['music', 'soundtrack', 'background music', 'dub', 'voiceover'],
    input: { kind: 'files', accept: VIDEO_IN },
    options: [
      o.file('audio', 'Audio file', [...AUDIO_IN, ...VIDEO_IN]),
      o.select('mode', 'Mode', [['replace', 'Replace audio'], ['mix', 'Mix with original']], 'replace'),
      o.range('volume', 'New audio volume (%)', 0, 200, 100),
      o.checkbox('shortest', 'Stop at the shortest input', true),
    ],
    actionLabel: 'Apply',
    async run(ctx) {
      const opt = ctx.options;
      if (!opt.audio) throw new Error('Pick an audio file');
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        const out = await ctx.output(file, { suffix: '_audio', extension: containerFor(file) === 'webm' ? 'mkv' : containerFor(file) });
        const vol = (opt.volume / 100).toFixed(2);
        const shortest = opt.shortest ? ['-shortest'] : [];
        if (opt.mode === 'mix' && info.audio) {
          await run(ctx, ['-i', file, '-i', opt.audio, '-filter_complex', `[1:a]volume=${vol}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', ...shortest, out], { duration: info.duration });
        } else {
          await run(ctx, ['-i', file, '-i', opt.audio, '-map', '0:v', '-map', '1:a:0', '-filter:a', `volume=${vol}`, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', ...shortest, out], { duration: info.duration });
        }
        return out;
      });
    },
  },
  {
    id: 'video.subtitles',
    name: 'Add subtitles track',
    icon: '💬',
    description: 'Embed an SRT, VTT or ASS subtitle file as a selectable track (no re-encoding).',
    keywords: ['srt', 'captions', 'vtt', 'ass'],
    input: { kind: 'files', accept: ['mp4', 'm4v', 'mov', 'mkv', 'webm'] },
    options: [o.file('subtitle', 'Subtitle file', ['srt', 'vtt', 'ass', 'ssa']), o.text('language', 'Language code', 'eng')],
    actionLabel: 'Embed',
    async run(ctx) {
      const opt = ctx.options;
      if (!opt.subtitle) throw new Error('Pick a subtitle file');
      return ctx.eachFile(async (file) => {
        const info = await probe(file);
        const container = ext(file);
        const subCodec = ['mkv'].includes(container) ? (ext(opt.subtitle) === 'vtt' ? 'webvtt' : ext(opt.subtitle) === 'srt' ? 'srt' : 'ass') : container === 'webm' ? 'webvtt' : 'mov_text';
        const out = await ctx.output(file, { suffix: '_subtitled' });
        await run(ctx, ['-i', file, '-i', opt.subtitle, '-map', '0', '-map', '1:0', '-c', 'copy', '-c:s', subCodec, '-metadata:s:s:0', `language=${opt.language || 'eng'}`, out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'video.info',
    name: 'Media info',
    icon: 'ℹ️',
    description: 'Codecs, resolution, frame rate, bitrate, duration, streams and tags of any media file.',
    keywords: ['codec', 'bitrate', 'fps', 'ffprobe', 'metadata'],
    input: { kind: 'files', accept: [...VIDEO_IN, ...AUDIO_IN] },
    output: 'none',
    options: [],
    actionLabel: 'Analyze',
    async run(ctx) {
      const sections = [];
      const result = await ctx.eachFile(async (file) => {
        const info = await probe(file);
        const size = (await fsp.stat(file)).size;
        sections.push({ title: path.basename(file), table: mediaTable(info, file, size) });
        return null;
      });
      result.sections = sections;
      return result;
    },
  },
];

module.exports = {
  category: { id: 'video', name: 'Video', icon: '🎬', color: ['#7b2ff7', '#f107a3'], description: 'Convert, compress, trim, GIF, frames and more' },
  tools,
  mediaTable,
};
