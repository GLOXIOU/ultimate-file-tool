const IMAGE_NATIVE = ['jpg', 'jpeg', 'jfif', 'jpe', 'png', 'webp', 'avif', 'tif', 'tiff', 'gif', 'svg'];
const IMAGE_EXTRA = ['heic', 'heif', 'bmp', 'ico', 'tga', 'dds', 'pcx', 'ppm', 'pgm', 'pbm', 'psd', 'exr', 'hdr', 'qoi', 'jp2', 'j2k', 'sgi', 'xwd', 'xbm'];
const IMAGE_IN = [...IMAGE_NATIVE, ...IMAGE_EXTRA];
const IMAGE_OUT = ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico'];

const VIDEO_IN = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpeg', 'mpg', 'm2ts', 'mts', 'ts', '3gp', '3g2', 'ogv', 'vob', 'asf', 'f4v', 'divx', 'rm', 'rmvb', 'mxf', 'dv', 'gif'];
const AUDIO_IN = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'm4r', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'amr', 'ac3', 'eac3', 'dts', 'ape', 'mka', 'caf', 'au', 'wv', 'spx', 'mp2', 'mpga', 'weba'];
const MEDIA_IN = [...AUDIO_IN, ...VIDEO_IN.filter((e) => e !== 'gif')];

const DOC_IN = ['md', 'markdown', 'txt', 'html', 'htm', 'xhtml', 'docx'];
const TEXT_IN = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'sql', 'srt', 'vtt', 'svg', 'tex', 'properties', 'env', 'lua', 'kt', 'swift', 'dart', 'vue', 'scss', 'less'];
const SHEET_IN = ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'fods', 'csv', 'tsv', 'numbers', 'dbf', 'slk', 'dif', 'json'];
const DATA_IN = ['json', 'jsonl', 'ndjson', 'yaml', 'yml', 'xml', 'toml', 'csv', 'tsv', 'ini'];
const ARCHIVE_IN = ['zip', '7z', 'tar', 'tgz', 'gz', 'bz2', 'tbz2', 'tbz', 'xz', 'txz', 'lzma', 'cab', 'br', 'zst', 'jar', 'war', 'apk', 'epub', 'xpi', 'cbz', 'cb7', 'cbt', 'vsix', 'nupkg', 'whl'];
const ZIP_FAMILY = ['zip', 'jar', 'war', 'apk', 'epub', 'xpi', 'cbz', 'vsix', 'nupkg', 'whl', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];

const CATEGORY_BY_EXT = {};
const CATEGORY_GROUPS = {
  Images: IMAGE_IN.concat(['raw', 'cr2', 'nef', 'arw', 'dng']),
  Videos: VIDEO_IN.filter((e) => e !== 'gif'),
  Audio: AUDIO_IN,
  Documents: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages', 'epub', 'tex'],
  Spreadsheets: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'numbers'],
  Presentations: ['ppt', 'pptx', 'odp', 'key'],
  Archives: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'iso', 'zst'],
  Code: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php', 'rb', 'html', 'css', 'scss', 'json', 'xml', 'yaml', 'yml', 'sh', 'bat', 'ps1', 'sql', 'kt', 'swift', 'lua', 'vue'],
  Executables: ['exe', 'msi', 'dmg', 'app', 'apk', 'deb', 'rpm', 'appimage'],
  Fonts: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
};
for (const [group, list] of Object.entries(CATEGORY_GROUPS)) {
  for (const e of list) if (!CATEGORY_BY_EXT[e]) CATEGORY_BY_EXT[e] = group;
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4', aac: 'audio/aac',
  pdf: 'application/pdf', zip: 'application/zip', '7z': 'application/x-7z-compressed', gz: 'application/gzip', tar: 'application/x-tar',
  json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
};

const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e]).reverse());

module.exports = {
  IMAGE_NATIVE,
  IMAGE_EXTRA,
  IMAGE_IN,
  IMAGE_OUT,
  VIDEO_IN,
  AUDIO_IN,
  MEDIA_IN,
  DOC_IN,
  TEXT_IN,
  SHEET_IN,
  DATA_IN,
  ARCHIVE_IN,
  ZIP_FAMILY,
  CATEGORY_BY_EXT,
  CATEGORY_GROUPS,
  MIME,
  EXT_BY_MIME,
};
