const { spawn } = require('child_process');
const { unpacked } = require('./util');

const ffmpegPath = unpacked(require('ffmpeg-static'));

function collect(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
  });
}

function parseClock(text) {
  const match = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text || '');
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function probe(file) {
  const { stderr } = await collect(['-hide_banner', '-i', file]);
  if (/Invalid data found|No such file|could not find codec/i.test(stderr) && !/Stream #/.test(stderr)) {
    throw new Error('Unsupported or corrupted media file');
  }
  const info = { duration: null, bitrate: null, format: null, video: null, audio: null, streams: [], metadata: {}, raw: stderr };
  const durationMatch = /Duration: ([\d:.]+|N\/A)/.exec(stderr);
  if (durationMatch) info.duration = parseClock(durationMatch[1]);
  const bitrateMatch = /bitrate: (\d+) kb\/s/.exec(stderr);
  if (bitrateMatch) info.bitrate = Number(bitrateMatch[1]);
  const formatMatch = /Input #0, (.+?), from/.exec(stderr);
  if (formatMatch) info.format = formatMatch[1];
  const metaBlock = /Input #0[\s\S]*?Metadata:\n([\s\S]*?)\n\s*Duration/.exec(stderr);
  if (metaBlock) {
    for (const line of metaBlock[1].split('\n')) {
      const m = /^\s+(\w[\w ]*?)\s*:\s(.*)$/.exec(line);
      if (m) info.metadata[m[1].trim()] = m[2].trim();
    }
  }
  const streamRe = /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\((\w+)\))?: (Video|Audio|Subtitle|Data|Attachment): ([^\n]+)/g;
  let m;
  while ((m = streamRe.exec(stderr))) {
    const [, lang, type, details] = m;
    const codec = details.split(/[\s,(]/)[0];
    const stream = { type: type.toLowerCase(), codec, language: lang || null, details: details.trim() };
    if (type === 'Video') {
      const res = /, (\d{2,5})x(\d{2,5})/.exec(details);
      if (res) {
        stream.width = Number(res[1]);
        stream.height = Number(res[2]);
      }
      const fps = /([\d.]+) fps/.exec(details);
      if (fps) stream.fps = Number(fps[1]);
      stream.attachedPic = /attached pic/.test(details);
      if (!info.video && !stream.attachedPic) info.video = stream;
    }
    if (type === 'Audio') {
      const hz = /(\d+) Hz/.exec(details);
      if (hz) stream.sampleRate = Number(hz[1]);
      const ch = /Hz, ([^,]+)/.exec(details);
      if (ch) stream.channels = ch[1].trim();
      const br = /(\d+) kb\/s/.exec(details);
      if (br) stream.bitrate = Number(br[1]);
      if (!info.audio) info.audio = stream;
    }
    info.streams.push(stream);
  }
  return info;
}

function run(ctx, args, { duration, onProgress, label } = {}) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
    if (ctx) ctx.log(`ffmpeg ${fullArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    const child = spawn(ffmpegPath, fullArgs, { windowsHide: true });
    if (ctx) ctx.track(child);
    let stderr = '';
    let buffer = '';
    let knownDuration = duration;
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const [key, value] = line.split('=');
        if ((key === 'out_time_us' || key === 'out_time_ms') && knownDuration) {
          const seconds = Number(value) / 1e6;
          if (Number.isFinite(seconds) && seconds >= 0) {
            const fraction = Math.min(1, seconds / knownDuration);
            if (onProgress) onProgress(fraction);
            else if (ctx) ctx.stepProgress(fraction, label);
          }
        }
      }
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
      if (!knownDuration) {
        const d = /Duration: (\d+:\d+:\d+\.\d+)/.exec(stderr);
        if (d) knownDuration = parseClock(d[1]);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (ctx && ctx.cancelled) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (code === 0) return resolve(stderr);
      const lines = stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/^(Input|Output|Stream|Duration|Metadata|\w+\s*:|frame=|size=|Press|\[)/.test(l));
      const reason = lines.slice(-3).join(' | ') || stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
      reject(new Error(`ffmpeg failed: ${reason || `exit code ${code}`}`));
    });
  });
}

async function decodeFirstFrame(file, format = 'png') {
  const { code, stdout, stderr } = await collect([
    '-hide_banner',
    '-i',
    file,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-c:v',
    format,
    'pipe:1',
  ]);
  if (code !== 0 || !stdout.length) throw new Error(`Cannot decode image: ${stderr.split('\n').filter(Boolean).pop() || 'unknown format'}`);
  return stdout;
}

async function version() {
  const { stdout, stderr } = await collect(['-version']);
  const text = stdout.toString() || stderr;
  return (/ffmpeg version (\S+)/.exec(text) || [])[1] || 'unknown';
}

function atempoChain(factor) {
  const filters = [];
  let remaining = factor;
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(5)}`);
  return filters.join(',');
}

module.exports = { ffmpegPath, probe, run, collect, decodeFirstFrame, version, atempoChain, parseClock };
