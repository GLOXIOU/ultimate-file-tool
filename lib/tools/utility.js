const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { sanitizeName, uniquePath, ext } = require('../core/util');
const { IMAGE_IN, EXT_BY_MIME } = require('../core/formats');
const { oriented } = require('./image');
const o = require('../core/opts');

function wifiString(ssid, password, security, hidden) {
  const esc = (v) => String(v || '').replace(/([\\;,:"])/g, '\\$1');
  return `WIFI:T:${security === 'none' ? 'nopass' : security};S:${esc(ssid)};${security === 'none' ? '' : `P:${esc(password)};`}${hidden ? 'H:true;' : ''};`;
}

function entropyBits(length, poolSize) {
  return Math.round(length * Math.log2(Math.max(2, poolSize)));
}

const tools = [
  {
    id: 'util.qr',
    name: 'QR code generator',
    icon: '🔳',
    description: 'Create QR codes for links, text, Wi-Fi access, emails or phone numbers as PNG or SVG.',
    keywords: ['qr', 'qrcode', 'wifi qr', 'barcode', 'link'],
    input: { kind: 'none' },
    options: [
      o.select('type', 'Content', [['text', 'Text / link'], ['wifi', 'Wi-Fi'], ['email', 'Email'], ['phone', 'Phone']], 'text'),
      o.textarea('text', 'Text or URL', 'https://github.com/GLOXIOU/ultimate-file-tool', { rows: 3, ...o.when('type', 'text') }),
      o.text('ssid', 'Network name (SSID)', '', o.when('type', 'wifi')),
      o.text('wifiPassword', 'Wi-Fi password', '', o.when('type', 'wifi')),
      o.select('security', 'Security', [['WPA', 'WPA/WPA2/WPA3'], ['WEP', 'WEP'], ['none', 'Open']], 'WPA', o.when('type', 'wifi')),
      o.checkbox('hidden', 'Hidden network', false, o.when('type', 'wifi')),
      o.text('email', 'Email address', '', o.when('type', 'email')),
      o.text('subject', 'Subject', '', o.when('type', 'email')),
      o.text('phone', 'Phone number', '', o.when('type', 'phone')),
      o.select('format', 'Format', [['png', 'PNG'], ['svg', 'SVG']], 'png'),
      o.select('size', 'Size', [['256', '256 px'], ['512', '512 px'], ['1024', '1024 px'], ['2048', '2048 px']], '1024', o.when('format', 'png')),
      o.select('ecl', 'Error correction', [['L', 'Low'], ['M', 'Medium'], ['Q', 'High'], ['H', 'Max']], 'M'),
      o.color('dark', 'Color', '#000000'),
      o.color('light', 'Background', '#ffffff'),
      o.text('name', 'File name', 'qr-code'),
    ],
    actionLabel: 'Generate',
    async run(ctx) {
      const QRCode = require('qrcode');
      const opt = ctx.options;
      let content;
      if (opt.type === 'wifi') {
        if (!opt.ssid) throw new Error('Enter the network name');
        content = wifiString(opt.ssid, opt.wifiPassword, opt.security, opt.hidden);
      } else if (opt.type === 'email') {
        if (!opt.email) throw new Error('Enter an email address');
        content = `mailto:${opt.email}${opt.subject ? `?subject=${encodeURIComponent(opt.subject)}` : ''}`;
      } else if (opt.type === 'phone') {
        if (!opt.phone) throw new Error('Enter a phone number');
        content = `tel:${opt.phone.replace(/[^\d+]/g, '')}`;
      } else {
        content = String(opt.text || '').trim();
        if (!content) throw new Error('Enter some text or a link');
      }
      const dir = ctx.dirFor(null);
      await fsp.mkdir(dir, { recursive: true });
      const target = await uniquePath(path.join(dir, `${sanitizeName(opt.name || 'qr-code')}.${opt.format}`));
      const common = { errorCorrectionLevel: opt.ecl, margin: 2, color: { dark: opt.dark, light: opt.light } };
      if (opt.format === 'svg') await fsp.writeFile(target, await QRCode.toString(content, { ...common, type: 'svg' }));
      else await QRCode.toFile(target, content, { ...common, type: 'png', width: Number(opt.size) });
      return { outputs: [target], summary: `${content.length} characters encoded` };
    },
  },
  {
    id: 'util.qrRead',
    name: 'QR code reader',
    icon: '📷',
    description: 'Decode QR codes from screenshots, photos or images.',
    keywords: ['scan', 'decode', 'qr', 'read qr'],
    input: { kind: 'files', accept: IMAGE_IN },
    output: 'none',
    options: [],
    actionLabel: 'Scan',
    async run(ctx) {
      const jsqrModule = require('jsqr');
      const jsQR = jsqrModule.default || jsqrModule;
      const texts = [];
      const rows = [];
      const result = await ctx.eachFile(async (file) => {
        const img = await oriented(file);
        const meta = await img.metadata();
        const scales = [1, 0.5, 2].map((s) => Math.round(Math.min(2000, (meta.width || 1000) * s)));
        let found = null;
        for (const width of scales) {
          const { data, info } = await img.clone().resize({ width }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height, { inversionAttempts: 'attemptBoth' });
          if (found) break;
        }
        if (!found) throw new Error('No QR code found');
        texts.push(found.data);
        rows.push([path.basename(file), found.data]);
        return null;
      });
      result.table = { title: 'Decoded', columns: ['Image', 'Content'], rows };
      result.text = texts.join('\n');
      return result;
    },
  },
  {
    id: 'util.base64',
    name: 'Base64 encode / decode',
    icon: '🔡',
    description: 'Encode any file to Base64 text, or turn Base64 / data URIs back into files.',
    keywords: ['base64', 'encode', 'decode', 'data uri', 'b64'],
    input: { kind: 'files', accept: null },
    options: [o.select('mode', 'Mode', [['encode', 'File → Base64'], ['decode', 'Base64 → file']], 'encode'), o.checkbox('wrap', 'Wrap lines at 76 characters', false, o.when('mode', 'encode'))],
    actionLabel: 'Run',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        if (opt.mode === 'encode') {
          let b64 = (await fsp.readFile(file)).toString('base64');
          if (opt.wrap) b64 = b64.replace(/(.{76})/g, '$1\n');
          const target = await uniquePath(path.join(ctx.dirFor(file), `${path.basename(file)}.b64.txt`));
          await fsp.writeFile(target, b64);
          return target;
        }
        const raw = (await fsp.readFile(file, 'utf8')).trim();
        const uri = /^data:([^;,]+)?(?:;[^,]*)?,/.exec(raw);
        const payload = uri ? raw.slice(uri[0].length) : raw;
        const clean = payload.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('This file does not contain valid Base64');
        const bytes = Buffer.from(clean, 'base64');
        let name = path.basename(file).replace(/\.b64\.txt$|\.b64$|\.txt$|\.base64$/i, '');
        if (uri && uri[1] && EXT_BY_MIME[uri[1]] && ext(name) !== EXT_BY_MIME[uri[1]]) name = `${name}.${EXT_BY_MIME[uri[1]]}`;
        if (!path.extname(name)) name += '.bin';
        const target = await uniquePath(path.join(ctx.dirFor(file), name));
        await fsp.writeFile(target, bytes);
        return target;
      });
    },
  },
  {
    id: 'util.password',
    name: 'Password generator',
    icon: '🔑',
    description: 'Generate strong random passwords or memorable passphrases, with entropy estimate.',
    keywords: ['password', 'random', 'passphrase', 'secure', 'generator'],
    input: { kind: 'none' },
    output: 'none',
    options: [
      o.select('kind', 'Type', [['random', 'Random characters'], ['passphrase', 'Passphrase'], ['pin', 'PIN']], 'random'),
      o.range('length', 'Length', 4, 128, 20, o.when('kind', ['random', 'pin'])),
      o.range('words', 'Words', 3, 12, 5, o.when('kind', 'passphrase')),
      o.checkbox('upper', 'Uppercase A-Z', true, o.when('kind', 'random')),
      o.checkbox('lower', 'Lowercase a-z', true, o.when('kind', 'random')),
      o.checkbox('digits', 'Digits 0-9', true, o.when('kind', 'random')),
      o.checkbox('symbols', 'Symbols !@#…', true, o.when('kind', 'random')),
      o.checkbox('ambiguous', 'Avoid look-alikes (0 O l 1 I)', false, o.when('kind', 'random')),
      o.number('count', 'How many', 10, { min: 1, max: 500 }),
    ],
    actionLabel: 'Generate',
    async run(ctx) {
      const opt = ctx.options;
      const count = Math.min(500, Math.max(1, Number(opt.count) || 1));
      const list = [];
      let bits;
      if (opt.kind === 'passphrase') {
        const words = WORDS;
        for (let i = 0; i < count; i++) {
          const picked = Array.from({ length: opt.words }, () => words[crypto.randomInt(words.length)]);
          list.push(`${picked.map((w, k) => (k === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join('-')}-${crypto.randomInt(10, 100)}`);
        }
        bits = entropyBits(opt.words, words.length) + 6;
      } else {
        let pool = '';
        if (opt.kind === 'pin') pool = '0123456789';
        else {
          if (opt.upper) pool += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
          if (opt.lower) pool += 'abcdefghijklmnopqrstuvwxyz';
          if (opt.digits) pool += '0123456789';
          if (opt.symbols) pool += '!@#$%^&*()-_=+[]{};:,.?/~';
          if (opt.ambiguous) pool = pool.replace(/[0Ol1I|]/g, '');
        }
        if (!pool) throw new Error('Select at least one character set');
        for (let i = 0; i < count; i++) list.push(Array.from({ length: opt.length }, () => pool[crypto.randomInt(pool.length)]).join(''));
        bits = entropyBits(opt.length, pool.length);
      }
      const strength = bits >= 100 ? 'Excellent' : bits >= 75 ? 'Strong' : bits >= 50 ? 'Fair' : 'Weak';
      return { text: list.join('\n'), textLabel: 'Passwords', summary: `≈ ${bits} bits of entropy · ${strength}` };
    },
  },
  {
    id: 'util.uuid',
    name: 'UUID & random IDs',
    icon: '🆔',
    description: 'Generate UUID v4, UUID v7, NanoID-style IDs or random hex tokens.',
    keywords: ['uuid', 'guid', 'id', 'token', 'nanoid', 'random'],
    input: { kind: 'none' },
    output: 'none',
    options: [
      o.select('kind', 'Type', [['v4', 'UUID v4'], ['v7', 'UUID v7 (sortable)'], ['nano', 'NanoID (21)'], ['hex', 'Hex token']], 'v4'),
      o.range('bytes', 'Token bytes', 8, 64, 32, o.when('kind', 'hex')),
      o.checkbox('upper', 'Uppercase', false),
      o.number('count', 'How many', 10, { min: 1, max: 1000 }),
    ],
    actionLabel: 'Generate',
    async run(ctx) {
      const opt = ctx.options;
      const alphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
      const v7 = () => {
        const b = crypto.randomBytes(16);
        const ts = BigInt(Date.now());
        for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
        b[6] = (b[6] & 0x0f) | 0x70;
        b[8] = (b[8] & 0x3f) | 0x80;
        const h = b.toString('hex');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      };
      const make = {
        v4: () => crypto.randomUUID(),
        v7,
        nano: () => Array.from(crypto.randomBytes(21), (b) => alphabet[b & 63]).join(''),
        hex: () => crypto.randomBytes(Number(opt.bytes)).toString('hex'),
      }[opt.kind];
      const list = Array.from({ length: Math.min(1000, Math.max(1, Number(opt.count) || 1)) }, make);
      return { text: (opt.upper ? list.map((x) => x.toUpperCase()) : list).join('\n'), textLabel: 'IDs' };
    },
  },
  {
    id: 'util.textHash',
    name: 'Hash & encode text',
    icon: '🧮',
    description: 'Hash text (MD5, SHA-1, SHA-256, SHA-512) or encode it as Base64, URL, hex or HTML entities.',
    keywords: ['hash text', 'md5 string', 'sha256 string', 'url encode', 'base64 text', 'hmac'],
    input: { kind: 'none' },
    output: 'none',
    options: [o.textarea('text', 'Text', '', { rows: 4, required: true }), o.text('hmacKey', 'HMAC key (optional)', '')],
    actionLabel: 'Compute',
    async run(ctx) {
      const text = String(ctx.options.text);
      const key = ctx.options.hmacKey;
      const h = (alg) => (key ? crypto.createHmac(alg, key) : crypto.createHash(alg)).update(text, 'utf8').digest('hex');
      const rows = [
        [key ? 'HMAC-MD5' : 'MD5', h('md5')],
        [key ? 'HMAC-SHA1' : 'SHA-1', h('sha1')],
        [key ? 'HMAC-SHA256' : 'SHA-256', h('sha256')],
        [key ? 'HMAC-SHA512' : 'SHA-512', h('sha512')],
        ['Base64', Buffer.from(text, 'utf8').toString('base64')],
        ['Base64 URL', Buffer.from(text, 'utf8').toString('base64url')],
        ['URL encoded', encodeURIComponent(text)],
        ['Hex', Buffer.from(text, 'utf8').toString('hex')],
        ['HTML entities', text.replace(/[ -香<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)],
        ['Length', `${[...text].length} characters · ${Buffer.byteLength(text, 'utf8')} bytes`],
      ];
      return { table: { title: 'Results', columns: ['Encoding', 'Value'], rows, mono: [1] } };
    },
  },
];

const WORDS = 'able acid aged also area army away baby back ball band bank base bath bear beat bell belt best bird blow blue boat body bone book boot born boss both bowl bulk burn bush busy cake calm camp card care cart case cash cast cell chat chef chin city clay club coal coat code cold cook cool cope copy core corn cost crew crop cube cult cure dark data date dawn deal dear deck deep deer desk dial diet dish disk dock dome door dose down draw drop drum duck dust duty each earn ease east echo edge else even exit face fact fair fall farm fast fate fear feed feel fern file film find fine fire firm fish flag flat flow folk food foot fork form fort four free frog fuel full fund gain game gate gear gift girl glad glow goal gold golf good gray grid grow gulf hair half hall hand hang hard harm hawk head heat herb hero hill hint hive hold hole home hood hook hope horn host hour huge hunt idea inch iron item jazz join joke jump jury keen keep kelp kick kind king kite knee knot lake lamp land lane last lava lawn lead leaf lean left lens life lift lime line link lion list load loan lock loft long loop lord loud love luck lung made mail main make mall many mark mask mass mate maze meal meat melt menu mild milk mind mine mint mist mode mood moon more moss most move much nail name navy near neat neck nest news next nice node noon nose note oath obey odds once only open oval oven pace pack page pain pair palm park part past path peak pear pine pink pipe plan play plot plum poem poet pole pond pool port pose post pour pull pure push quiz race rain ramp rank rare rate read real reef rent rest rice rich ride ring rise risk road rock role roof room root rope rose ruby rule safe sail salt sand save seal seat seed self send ship shoe shop show sign silk sing sink site size skin sky slow snow soap sock soft soil song soon sort soul soup spin spot star stay step stem stop such suit sure swan swim tail tale tall tank tape task team tent term test text then tide tile time tiny tone tool tour town tree trip true tube tune turn twin type unit vast verb very vest view vine void vote wage wait wake walk wall want warm wash wave weak wear week well west what wide wild will wind wine wing wire wise wish wolf wood wool word work yard yarn year yoga zero zone'.split(' ');

module.exports = {
  category: { id: 'utility', name: 'Utilities', icon: '🧰', color: ['#fc466b', '#3f5efb'], description: 'QR codes, Base64, passwords, IDs and text hashing' },
  tools,
};
