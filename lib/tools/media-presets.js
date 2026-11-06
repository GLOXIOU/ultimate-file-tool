const CRF = { high: 18, balanced: 23, small: 28, tiny: 33 };
const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

function videoArgs(format, quality = 'balanced') {
  const crf = String(CRF[quality] ?? 23);
  const qscale = String({ high: 2, balanced: 4, small: 7, tiny: 10 }[quality] ?? 4);
  const h264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p'];
  switch (format) {
    case 'mp4':
    case 'm4v':
    case 'mov':
      return [...h264, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-sn'];
    case 'mkv':
      return [...h264, '-c:a', 'aac', '-b:a', '192k', '-c:s', 'copy'];
    case 'flv':
      return [...h264, '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-sn'];
    case 'webm':
      return ['-c:v', 'libvpx-vp9', '-crf', String(Number(crf) + 9), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k', '-sn'];
    case 'avi':
      return ['-c:v', 'libxvid', '-q:v', qscale, '-c:a', 'libmp3lame', '-b:a', '192k', '-sn'];
    case 'wmv':
      return ['-c:v', 'wmv2', '-q:v', qscale, '-c:a', 'wmav2', '-b:a', '192k', '-sn'];
    case 'mpeg':
    case 'mpg':
      return ['-c:v', 'mpeg2video', '-q:v', qscale, '-c:a', 'mp2', '-b:a', '192k', '-sn'];
    case 'ogv':
      return ['-c:v', 'libtheora', '-q:v', String({ high: 9, balanced: 7, small: 5, tiny: 3 }[quality] ?? 7), '-c:a', 'libvorbis', '-q:a', '5', '-sn'];
    case '3gp':
      return ['-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-crf', crf, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '2', '-sn'];
    case 'ts':
      return [...h264, '-c:a', 'aac', '-b:a', '192k', '-sn'];
    default:
      return null;
  }
}

const AUDIO = {
  mp3: { ext: 'mp3', args: (br) => ['-c:a', 'libmp3lame', '-b:a', br] },
  m4a: { ext: 'm4a', args: (br) => ['-c:a', 'aac', '-b:a', br] },
  aac: { ext: 'aac', args: (br) => ['-c:a', 'aac', '-b:a', br] },
  m4r: { ext: 'm4r', args: (br) => ['-c:a', 'aac', '-b:a', br, '-f', 'ipod'] },
  ogg: { ext: 'ogg', args: (br) => ['-c:a', 'libvorbis', '-b:a', br] },
  oga: { ext: 'oga', args: (br) => ['-c:a', 'libvorbis', '-b:a', br] },
  opus: { ext: 'opus', args: (br) => ['-c:a', 'libopus', '-b:a', br] },
  wav: { ext: 'wav', lossless: true, args: () => ['-c:a', 'pcm_s16le'] },
  flac: { ext: 'flac', lossless: true, args: () => ['-c:a', 'flac', '-compression_level', '8'] },
  alac: { ext: 'm4a', lossless: true, args: () => ['-c:a', 'alac'] },
  aiff: { ext: 'aiff', lossless: true, args: () => ['-c:a', 'pcm_s16be'] },
  aif: { ext: 'aif', lossless: true, args: () => ['-c:a', 'pcm_s16be'] },
  wma: { ext: 'wma', args: (br) => ['-c:a', 'wmav2', '-b:a', br] },
  ac3: { ext: 'ac3', args: (br) => ['-c:a', 'ac3', '-b:a', br] },
  mp2: { ext: 'mp2', args: (br) => ['-c:a', 'mp2', '-b:a', br] },
};

function audioArgs(format, bitrate = '192k') {
  const preset = AUDIO[format] || AUDIO.mp3;
  return { ext: preset.ext, args: ['-vn', ...preset.args(bitrate)] };
}

module.exports = { CRF, EVEN, videoArgs, audioArgs, AUDIO };
