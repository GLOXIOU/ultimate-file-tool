const path = require('path');
const fsp = require('fs').promises;
const { probe, run, atempoChain } = require('../core/ffmpeg');
const { ext, baseName, parseTime, formatBytes, formatDuration } = require('../core/util');
const { AUDIO_IN, VIDEO_IN, MEDIA_IN, IMAGE_IN } = require('../core/formats');
const { audioArgs, AUDIO } = require('./media-presets');
const o = require('../core/opts');

const AUDIO_OUT = [['mp3', 'MP3'], ['m4a', 'M4A (AAC)'], ['wav', 'WAV'], ['flac', 'FLAC'], ['ogg', 'OGG'], ['opus', 'Opus'], ['aac', 'AAC'], ['alac', 'ALAC'], ['aiff', 'AIFF'], ['wma', 'WMA'], ['ac3', 'AC3'], ['m4r', 'M4R ringtone']];
const BITRATES = [['320k', '320 kbps'], ['256k', '256 kbps'], ['192k', '192 kbps'], ['160k', '160 kbps'], ['128k', '128 kbps'], ['96k', '96 kbps'], ['64k', '64 kbps']];
const LOSSY = ['mp3', 'm4a', 'ogg', 'opus', 'aac', 'wma', 'ac3', 'm4r'];

function sameAudio(file, bitrate = '192k') {
  const e = ext(file);
  if (AUDIO[e]) return audioArgs(e, bitrate);
  return audioArgs('mp3', bitrate);
}

function shapeArgs(opt) {
  const args = [];
  if (opt.sampleRate && opt.sampleRate !== 'keep') args.push('-ar', opt.sampleRate);
  if (opt.channels && opt.channels !== 'keep') args.push('-ac', opt.channels);
  return args;
}

async function requireAudio(file) {
  const info = await probe(file);
  if (!info.audio) throw new Error('No audio stream found');
  return info;
}

const tools = [
  {
    id: 'audio.convert',
    name: 'Convert audio',
    icon: '🔄',
    description: 'Convert between MP3, M4A, WAV, FLAC, OGG, Opus, AAC, ALAC, AIFF, WMA, AC3 and iPhone ringtones.',
    keywords: ['wav to mp3', 'flac to mp3', 'm4a to mp3', 'ringtone', 'transcode'],
    input: { kind: 'files', accept: MEDIA_IN },
    options: [
      o.select('format', 'Output format', AUDIO_OUT, 'mp3'),
      o.select('bitrate', 'Bitrate', BITRATES, '192k', o.when('format', LOSSY)),
      o.select('sampleRate', 'Sample rate', [['keep', 'Keep'], ['48000', '48 kHz'], ['44100', '44.1 kHz'], ['32000', '32 kHz'], ['22050', '22 kHz']], 'keep'),
      o.select('channels', 'Channels', [['keep', 'Keep'], ['2', 'Stereo'], ['1', 'Mono']], 'keep'),
    ],
    actionLabel: 'Convert',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const { ext: outExt, args } = audioArgs(opt.format, opt.bitrate);
        const out = await ctx.output(file, { extension: outExt });
        await run(ctx, ['-i', file, ...args, ...shapeArgs(opt), '-map_metadata', '0', out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'audio.compress',
    name: 'Compress audio',
    icon: '🗜️',
    description: 'Make audio files smaller with a lower bitrate, mono downmix or a modern codec.',
    keywords: ['reduce size', 'smaller', 'podcast', 'voice'],
    input: { kind: 'files', accept: MEDIA_IN },
    options: [
      o.select('format', 'Format', [['mp3', 'MP3'], ['opus', 'Opus (best)'], ['m4a', 'M4A']], 'mp3'),
      o.select('bitrate', 'Bitrate', BITRATES.slice(3), '96k'),
      o.checkbox('mono', 'Convert to mono (great for voice)', false),
    ],
    actionLabel: 'Compress',
    async run(ctx) {
      const opt = ctx.options;
      let before = 0;
      let after = 0;
      const result = await ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const { ext: outExt, args } = audioArgs(opt.format, opt.bitrate);
        const out = await ctx.output(file, { suffix: '_compressed', extension: outExt });
        await run(ctx, ['-i', file, ...args, ...(opt.mono ? ['-ac', '1'] : []), out], { duration: info.duration });
        const a = (await fsp.stat(file)).size;
        const b = (await fsp.stat(out)).size;
        before += a;
        after += b;
        return { outputs: out, note: `${path.basename(file)}: ${formatBytes(a)} → ${formatBytes(b)}` };
      });
      if (before) result.summary = `Saved ${formatBytes(before - after)} (${Math.round(((before - after) / before) * 100)}%)`;
      return result;
    },
  },
  {
    id: 'audio.trim',
    name: 'Trim audio',
    icon: '✂️',
    description: 'Cut a section of a song or recording, with optional fade in and fade out.',
    keywords: ['cut', 'clip', 'ringtone', 'shorten'],
    input: { kind: 'files', accept: MEDIA_IN },
    options: [
      o.text('start', 'Start (hh:mm:ss)', '00:00:00'),
      o.text('end', 'End (empty = until the end)', ''),
      o.number('fadeIn', 'Fade in (s)', 0, { min: 0, step: 0.5 }),
      o.number('fadeOut', 'Fade out (s)', 0, { min: 0, step: 0.5 }),
    ],
    actionLabel: 'Trim',
    async run(ctx) {
      const opt = ctx.options;
      const start = parseTime(opt.start) || 0;
      const end = parseTime(opt.end);
      if (end !== null && end <= start) throw new Error('End must be after start');
      return ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const length = (end ?? info.duration) - start;
        const filters = [];
        if (opt.fadeIn > 0) filters.push(`afade=t=in:st=0:d=${opt.fadeIn}`);
        if (opt.fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, length - opt.fadeOut).toFixed(3)}:d=${opt.fadeOut}`);
        const { ext: outExt, args } = sameAudio(file);
        const out = await ctx.output(file, { suffix: '_trimmed', extension: outExt });
        await run(ctx, ['-ss', String(start), ...(end !== null ? ['-t', String(end - start)] : []), '-i', file, ...(filters.length ? ['-af', filters.join(',')] : []), ...args, out], { duration: length });
        return out;
      });
    },
  },
  {
    id: 'audio.volume',
    name: 'Volume & normalize',
    icon: '🔊',
    description: 'Normalize loudness to broadcast standards (EBU R128) or boost/reduce volume in dB.',
    keywords: ['louder', 'quieter', 'loudness', 'gain', 'normalize', 'boost'],
    input: { kind: 'files', accept: MEDIA_IN },
    options: [
      o.select('mode', 'Mode', [['normalize', 'Normalize loudness'], ['gain', 'Change volume']], 'normalize'),
      o.select('target', 'Target', [['-14', 'Streaming (-14 LUFS)'], ['-16', 'Podcast (-16 LUFS)'], ['-23', 'Broadcast (-23 LUFS)'], ['-9', 'Loud (-9 LUFS)']], '-14', o.when('mode', 'normalize')),
      o.range('gain', 'Gain (dB)', -30, 30, 6, o.when('mode', 'gain')),
    ],
    actionLabel: 'Apply',
    async run(ctx) {
      const opt = ctx.options;
      const filter = opt.mode === 'normalize' ? `loudnorm=I=${opt.target}:TP=-1.5:LRA=11` : `volume=${opt.gain}dB`;
      return ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const { ext: outExt, args } = sameAudio(file, '256k');
        const out = await ctx.output(file, { suffix: opt.mode === 'normalize' ? '_normalized' : `_${opt.gain > 0 ? '+' : ''}${opt.gain}dB`, extension: outExt });
        await run(ctx, ['-i', file, '-af', filter, ...args, ...(info.audio.sampleRate ? ['-ar', String(info.audio.sampleRate)] : []), out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'audio.speed',
    name: 'Speed & pitch',
    icon: '🎚️',
    description: 'Change tempo without changing pitch, or shift pitch by semitones (nightcore, slowed…).',
    keywords: ['tempo', 'pitch', 'nightcore', 'slowed', 'reverb', 'chipmunk'],
    input: { kind: 'files', accept: MEDIA_IN },
    options: [
      o.number('speed', 'Tempo factor', 1, { min: 0.25, max: 4, step: 0.05 }),
      o.range('pitch', 'Pitch (semitones)', -12, 12, 0),
    ],
    actionLabel: 'Apply',
    async run(ctx) {
      const opt = ctx.options;
      const speed = Number(opt.speed) || 1;
      const semis = Number(opt.pitch) || 0;
      if (speed === 1 && semis === 0) throw new Error('Change the tempo or the pitch first');
      return ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const sr = info.audio.sampleRate || 44100;
        const filters = [];
        if (semis) {
          const ratio = Math.pow(2, semis / 12);
          filters.push(`asetrate=${Math.round(sr * ratio)}`, `aresample=${sr}`, atempoChain(speed / ratio));
        } else {
          filters.push(atempoChain(speed));
        }
        const { ext: outExt, args } = sameAudio(file, '256k');
        const out = await ctx.output(file, { suffix: `_x${speed}${semis ? `_${semis > 0 ? '+' : ''}${semis}st` : ''}`, extension: outExt });
        await run(ctx, ['-i', file, '-af', filters.join(','), ...args, out], { duration: info.duration ? info.duration / speed : null });
        return out;
      });
    },
  },
  {
    id: 'audio.merge',
    name: 'Merge audio files',
    icon: '🔗',
    description: 'Join several tracks into one file, with optional crossfade.',
    keywords: ['join', 'concat', 'combine', 'mix tape', 'crossfade'],
    input: { kind: 'files', accept: MEDIA_IN, min: 2, ordered: true },
    options: [
      o.select('format', 'Output format', AUDIO_OUT.slice(0, 6), 'mp3'),
      o.select('bitrate', 'Bitrate', BITRATES, '192k', o.when('format', LOSSY)),
      o.number('crossfade', 'Crossfade (s)', 0, { min: 0, max: 20, step: 0.5 }),
      o.text('name', 'Output name', 'merged'),
    ],
    actionLabel: 'Merge',
    async run(ctx) {
      const opt = ctx.options;
      const infos = [];
      for (const f of ctx.files) infos.push(await requireAudio(f));
      const inputs = ctx.files.flatMap((f) => ['-i', f]);
      const prep = ctx.files.map((_, i) => `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      let graph;
      const cf = Number(opt.crossfade) || 0;
      if (cf > 0) {
        const chain = [];
        let prev = 'a0';
        for (let i = 1; i < ctx.files.length; i++) {
          const label = i === ctx.files.length - 1 ? 'out' : `x${i}`;
          chain.push(`[${prev}][a${i}]acrossfade=d=${cf}[${label}]`);
          prev = label;
        }
        graph = [...prep, ...chain].join(';');
      } else {
        graph = [...prep, `${ctx.files.map((_, i) => `[a${i}]`).join('')}concat=n=${ctx.files.length}:v=0:a=1[out]`].join(';');
      }
      const total = infos.reduce((s, i) => s + (i.duration || 0), 0) - cf * (ctx.files.length - 1);
      const { ext: outExt, args } = audioArgs(opt.format, opt.bitrate);
      const out = await ctx.output(ctx.files[0], { name: opt.name || 'merged', extension: outExt });
      ctx.setStep(0, 1, 'Merging');
      await run(ctx, [...inputs, '-filter_complex', graph, '-map', '[out]', ...args.filter((a) => a !== '-vn'), out], { duration: total });
      return { outputs: [out], summary: `${ctx.files.length} tracks → ${formatDuration(total)}` };
    },
  },
  {
    id: 'audio.effects',
    name: 'Audio effects',
    icon: '✨',
    description: 'Reverse, echo, bass boost, 8D rotation, mono/stereo swap, remove vocals and more.',
    keywords: ['reverse', 'echo', 'bass boost', '8d audio', 'karaoke', 'remove vocals', 'telephone'],
    input: { kind: 'files', accept: MEDIA_IN },
    options: [
      o.select('effect', 'Effect', [
        ['reverse', 'Reverse'],
        ['bass', 'Bass boost'],
        ['treble', 'Treble boost'],
        ['echo', 'Echo'],
        ['reverb', 'Reverb / hall'],
        ['8d', '8D rotating audio'],
        ['karaoke', 'Remove vocals (karaoke)'],
        ['telephone', 'Telephone'],
        ['swap', 'Swap left/right'],
        ['mono', 'Downmix to mono'],
        ['denoise', 'Reduce background noise'],
      ], 'bass'),
      o.range('amount', 'Intensity', 1, 10, 5),
    ],
    actionLabel: 'Apply',
    async run(ctx) {
      const opt = ctx.options;
      const a = Number(opt.amount) || 5;
      const filters = {
        reverse: 'areverse',
        bass: `bass=g=${a * 2}:f=110:w=0.6`,
        treble: `treble=g=${a * 1.5}:f=3000`,
        echo: `aecho=0.8:0.88:${60 + a * 40}:${(0.2 + a * 0.05).toFixed(2)}`,
        reverb: `aecho=0.8:0.9:${[40, 80, 120, 160].map((d) => d + a * 10).join('|')}:${[0.4, 0.3, 0.2, 0.1].map((d) => (d * (0.5 + a / 10)).toFixed(2)).join('|')}`,
        '8d': `apulsator=hz=${(0.05 + a * 0.02).toFixed(3)}:amount=0.85`,
        karaoke: 'pan=stereo|c0=c0-c1|c1=c1-c0',
        telephone: 'highpass=f=400,lowpass=f=3400,acompressor',
        swap: 'pan=stereo|c0=c1|c1=c0',
        mono: 'pan=mono|c0=0.5*c0+0.5*c1',
        denoise: `afftdn=nr=${6 + a * 3}:nf=-30`,
      };
      return ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const { ext: outExt, args } = sameAudio(file, '256k');
        const out = await ctx.output(file, { suffix: `_${opt.effect}`, extension: outExt });
        await run(ctx, ['-i', file, '-af', filters[opt.effect], ...args, out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'audio.silence',
    name: 'Remove silence',
    icon: '🤫',
    description: 'Trim silence at the start and end, or remove every silent gap from recordings.',
    keywords: ['silence', 'gaps', 'podcast', 'dead air'],
    input: { kind: 'files', accept: MEDIA_IN },
    options: [
      o.select('mode', 'Mode', [['edges', 'Start & end only'], ['all', 'All silent gaps']], 'edges'),
      o.range('threshold', 'Silence threshold (dB)', -80, -20, -45),
      o.number('minimum', 'Minimum gap (s)', 0.6, { min: 0.1, step: 0.1, ...o.when('mode', 'all') }),
    ],
    actionLabel: 'Remove silence',
    async run(ctx) {
      const opt = ctx.options;
      const t = `${opt.threshold}dB`;
      const filter =
        opt.mode === 'edges'
          ? `silenceremove=start_periods=1:start_threshold=${t},areverse,silenceremove=start_periods=1:start_threshold=${t},areverse`
          : `silenceremove=start_periods=1:start_threshold=${t}:stop_periods=-1:stop_duration=${opt.minimum}:stop_threshold=${t}`;
      return ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const { ext: outExt, args } = sameAudio(file, '256k');
        const out = await ctx.output(file, { suffix: '_nosilence', extension: outExt });
        await run(ctx, ['-i', file, '-af', filter, ...args, out], { duration: info.duration });
        const after = await probe(out).catch(() => null);
        return { outputs: out, note: after && info.duration ? `${path.basename(file)}: ${formatDuration(info.duration)} → ${formatDuration(after.duration)}` : null };
      });
    },
  },
  {
    id: 'audio.split',
    name: 'Split audio',
    icon: '🪓',
    description: 'Cut long recordings into equal parts of N minutes, losslessly.',
    keywords: ['segments', 'chapters', 'parts', 'chunk'],
    input: { kind: 'files', accept: MEDIA_IN },
    options: [o.number('minutes', 'Part length (minutes)', 10, { min: 0.1, step: 0.5 })],
    actionLabel: 'Split',
    async run(ctx) {
      const seconds = Math.max(1, Number(ctx.options.minutes) * 60);
      return ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const dir = await ctx.outputFolder(file, '_parts');
        const outExt = AUDIO[ext(file)] ? ext(file) : 'mka';
        await run(ctx, ['-i', file, '-vn', '-f', 'segment', '-segment_time', String(seconds), '-reset_timestamps', '1', '-c', 'copy', path.join(dir, `${baseName(file)}_%03d.${outExt}`)], { duration: info.duration });
        return (await fsp.readdir(dir)).sort().map((f) => path.join(dir, f));
      });
    },
  },
  {
    id: 'audio.waveform',
    name: 'Waveform & spectrogram',
    icon: '📈',
    description: 'Render a waveform or a frequency spectrogram image of any audio.',
    keywords: ['visualize', 'spectrum', 'soundwave', 'image'],
    input: { kind: 'files', accept: MEDIA_IN },
    options: [
      o.select('type', 'Type', [['waveform', 'Waveform'], ['spectrogram', 'Spectrogram']], 'waveform'),
      o.select('size', 'Size', [['1200x300', '1200×300'], ['1920x480', '1920×480'], ['3000x600', '3000×600'], ['1080x1080', '1080×1080']], '1920x480'),
      o.color('color', 'Color', '#0073ff', o.when('type', 'waveform')),
      o.checkbox('split', 'Separate channels', false, o.when('type', 'waveform')),
    ],
    actionLabel: 'Render',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const out = await ctx.output(file, { suffix: `_${opt.type}`, extension: 'png' });
        const filter =
          opt.type === 'waveform'
            ? `showwavespic=s=${opt.size}:colors=0x${opt.color.replace('#', '')}:split_channels=${opt.split ? 1 : 0}`
            : `showspectrumpic=s=${opt.size}:legend=1:color=intensity`;
        await run(ctx, ['-i', file, '-filter_complex', filter, '-frames:v', '1', out], { duration: info.duration });
        return out;
      });
    },
  },
  {
    id: 'audio.toVideo',
    name: 'Audio to video',
    icon: '📺',
    description: 'Turn audio into an MP4 with a cover image or an animated waveform, ready for YouTube.',
    keywords: ['youtube', 'podcast video', 'visualizer', 'cover', 'mp3 to mp4'],
    input: { kind: 'files', accept: MEDIA_IN },
    options: [
      o.select('visual', 'Visual', [['image', 'Static image'], ['wave', 'Animated waveform'], ['bars', 'Animated spectrum']], 'image'),
      o.file('image', 'Cover image', IMAGE_IN, o.when('visual', 'image')),
      o.select('size', 'Size', [['1920x1080', '1920×1080'], ['1280x720', '1280×720'], ['1080x1080', '1080×1080'], ['1080x1920', '1080×1920']], '1280x720'),
      o.color('color', 'Wave color', '#00b7ff', o.when('visual', ['wave', 'bars'])),
    ],
    actionLabel: 'Create video',
    async run(ctx) {
      const opt = ctx.options;
      if (opt.visual === 'image' && !opt.image) throw new Error('Pick a cover image');
      const [W, H] = opt.size.split('x').map(Number);
      return ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const out = await ctx.output(file, { extension: 'mp4' });
        const color = `0x${opt.color.replace('#', '')}`;
        if (opt.visual === 'image') {
          await run(ctx, ['-loop', '1', '-framerate', '2', '-i', opt.image, '-i', file, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`, '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryfast', '-crf', '20', '-r', '2', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], { duration: info.duration });
        } else {
          const vis = opt.visual === 'wave' ? `showwaves=s=${W}x${H}:mode=cline:rate=30:colors=${color}` : `showfreqs=s=${W}x${H}:mode=bar:colors=${color}:fscale=log,fps=30`;
          await run(ctx, ['-i', file, '-filter_complex', `[0:a]${vis},format=yuv420p[v]`, '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { duration: info.duration });
        }
        return out;
      });
    },
  },
  {
    id: 'audio.metadata',
    name: 'Edit tags',
    icon: '🏷️',
    description: 'Edit title, artist, album, year, genre and cover art of MP3, M4A, FLAC and OGG files.',
    keywords: ['id3', 'tags', 'artist', 'album', 'cover art', 'metadata'],
    input: { kind: 'files', accept: ['mp3', 'm4a', 'flac', 'ogg', 'opus', 'wma', 'aac', 'm4r'] },
    options: [
      o.text('title', 'Title', '', { placeholder: 'unchanged' }),
      o.text('artist', 'Artist', '', { placeholder: 'unchanged' }),
      o.text('album', 'Album', '', { placeholder: 'unchanged' }),
      o.text('year', 'Year', '', { placeholder: 'unchanged' }),
      o.text('genre', 'Genre', '', { placeholder: 'unchanged' }),
      o.text('track', 'Track number', '', { placeholder: 'unchanged' }),
      o.file('cover', 'Cover image', ['jpg', 'jpeg', 'png']),
      o.checkbox('clear', 'Remove all other tags first', false),
    ],
    actionLabel: 'Save tags',
    async run(ctx) {
      const opt = ctx.options;
      const fields = { title: opt.title, artist: opt.artist, album: opt.album, date: opt.year, genre: opt.genre, track: opt.track };
      return ctx.eachFile(async (file) => {
        const info = await requireAudio(file);
        const out = await ctx.output(file, { suffix: '_tagged' });
        const args = ['-i', file];
        const supportsCover = ['mp3', 'm4a', 'm4r', 'flac'].includes(ext(file));
        if (opt.cover && supportsCover) args.push('-i', opt.cover);
        args.push('-map', '0:a');
        if (opt.cover && supportsCover) args.push('-map', '1:0', '-c:v', ext(file) === 'flac' ? 'copy' : 'mjpeg', '-disposition:v:0', 'attached_pic');
        else if (!opt.clear) args.push('-map', '0:v?');
        args.push('-c:a', 'copy');
        if (!(opt.cover && supportsCover)) args.push('-c:v', 'copy');
        args.push('-map_metadata', opt.clear ? '-1' : '0');
        for (const [k, v] of Object.entries(fields)) if (String(v || '').trim()) args.push('-metadata', `${k}=${String(v).trim()}`);
        if (ext(file) === 'mp3') args.push('-id3v2_version', '3');
        await run(ctx, [...args, out], { duration: info.duration });
        return out;
      });
    },
  },
];

module.exports = {
  category: { id: 'audio', name: 'Audio', icon: '🎵', color: ['#00c6ff', '#0072ff'], description: 'Convert, trim, normalize, merge and apply effects' },
  tools,
};
