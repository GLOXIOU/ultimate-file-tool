const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { formatBytes, uniquePath } = require('../core/util');
const { encryptFile, decryptFile } = require('../crypter-manager/cryptor-AES');
const o = require('../core/opts');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Hasher() {
  let crc = 0xffffffff;
  return {
    update(buf) {
      for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    },
    digest() {
      return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
    },
  };
}

const ALGORITHMS = [
  ['md5', 'MD5'],
  ['sha1', 'SHA-1'],
  ['sha256', 'SHA-256'],
  ['sha384', 'SHA-384'],
  ['sha512', 'SHA-512'],
  ['sha512-256', 'SHA-512/256'],
  ['ripemd160', 'RIPEMD-160'],
  ['crc32', 'CRC32'],
];
const LABEL = Object.fromEntries(ALGORITHMS);
const BY_LENGTH = { 8: 'crc32', 32: 'md5', 40: 'sha1', 64: 'sha256', 96: 'sha384', 128: 'sha512' };

async function hashFile(file, algorithms, onProgress, signal) {
  const hashers = algorithms.map((a) => [a, a === 'crc32' ? crc32Hasher() : crypto.createHash(a)]);
  const { size } = await fsp.stat(file);
  let done = 0;
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20, signal });
  for await (const chunk of stream) {
    for (const [, h] of hashers) h.update(chunk);
    done += chunk.length;
    if (onProgress && size) onProgress(done / size);
  }
  return Object.fromEntries(hashers.map(([a, h]) => [a, typeof h.digest === 'function' && a !== 'crc32' ? h.digest('hex') : h.digest()]));
}

async function moveToTrash(file) {
  const electron = require('electron');
  if (electron && electron.shell && electron.shell.trashItem) return electron.shell.trashItem(file);
  throw new Error('Recycle bin not available');
}

const tools = [
  {
    id: 'security.encrypt',
    name: 'Encrypt files',
    icon: '🔒',
    description: 'Protect any file with a password using AES-256-GCM and scrypt key derivation.',
    keywords: ['password', 'aes', 'protect', 'lock', 'secure', 'cipher'],
    input: { kind: 'files', accept: null },
    options: [
      o.password('password', 'Password', { confirm: true, required: true, minLength: 6 }),
      o.checkbox('trashOriginal', 'Move originals to the recycle bin afterwards', false),
    ],
    actionLabel: 'Encrypt',
    async run(ctx) {
      const opt = ctx.options;
      return ctx.eachFile(async (file) => {
        const target = await uniquePath(path.join(ctx.dirFor(file), `${path.basename(file)}.enc`));
        await encryptFile(file, target, opt.password, { onProgress: (f) => ctx.stepProgress(f), signal: ctx.signal });
        if (opt.trashOriginal) await moveToTrash(file);
        return target;
      });
    },
  },
  {
    id: 'security.decrypt',
    name: 'Decrypt files',
    icon: '🔓',
    description: 'Restore files encrypted with this app (.enc) using the original password.',
    keywords: ['unlock', 'password', 'aes', 'enc'],
    input: { kind: 'files', accept: ['enc'] },
    options: [o.password('password', 'Password', { required: true })],
    actionLabel: 'Decrypt',
    async run(ctx) {
      return ctx.eachFile(async (file) => {
        const name = path.basename(file).replace(/\.enc$/i, '') || 'decrypted';
        const target = await uniquePath(path.join(ctx.dirFor(file), name));
        await decryptFile(file, target, ctx.options.password, { onProgress: (f) => ctx.stepProgress(f), signal: ctx.signal });
        return target;
      });
    },
  },
  {
    id: 'security.hash',
    name: 'Checksums & hashes',
    icon: '#️⃣',
    description: 'Compute MD5, SHA-1, SHA-256, SHA-384, SHA-512, RIPEMD-160 and CRC32 of any file.',
    keywords: ['md5', 'sha256', 'sha1', 'crc32', 'checksum', 'hash', 'integrity'],
    input: { kind: 'files', accept: null },
    options: [
      o.multi('algorithms', 'Algorithms', ALGORITHMS, ['md5', 'sha1', 'sha256']),
      o.checkbox('save', 'Save a checksum file (.sha256 style) next to each file', false),
      o.checkbox('uppercase', 'Uppercase', false),
    ],
    actionLabel: 'Compute',
    async run(ctx) {
      const algos = ctx.options.algorithms && ctx.options.algorithms.length ? ctx.options.algorithms : ['sha256'];
      const rows = [];
      const lines = [];
      const result = await ctx.eachFile(async (file) => {
        const digests = await hashFile(file, algos, (f) => ctx.stepProgress(f), ctx.signal);
        const fmt = (v) => (ctx.options.uppercase ? v.toUpperCase() : v);
        for (const a of algos) {
          rows.push([path.basename(file), LABEL[a], fmt(digests[a])]);
          lines.push(`${fmt(digests[a])}  ${path.basename(file)}${algos.length > 1 ? `  (${LABEL[a]})` : ''}`);
        }
        if (ctx.options.save) {
          const main = algos.includes('sha256') ? 'sha256' : algos[0];
          const target = await uniquePath(path.join(ctx.dirFor(file), `${path.basename(file)}.${main.replace(/[^a-z0-9]/g, '')}`));
          await fsp.writeFile(target, `${fmt(digests[main])} *${path.basename(file)}\n`);
          return target;
        }
        return null;
      });
      result.table = { title: 'Hashes', columns: ['File', 'Algorithm', 'Hash'], rows, mono: [2] };
      result.text = lines.join('\n');
      result.textLabel = 'Plain text';
      return result;
    },
  },
  {
    id: 'security.verify',
    name: 'Verify checksum',
    icon: '✔️',
    description: 'Check that a download is intact by comparing it with the published hash.',
    keywords: ['verify', 'integrity', 'download', 'sha256', 'md5', 'match'],
    input: { kind: 'file', accept: null },
    output: 'none',
    options: [o.text('expected', 'Expected hash', '', { required: true, wide: true, placeholder: 'Paste the MD5 / SHA-1 / SHA-256 / SHA-512 / CRC32 here' })],
    actionLabel: 'Verify',
    async run(ctx) {
      const expected = String(ctx.options.expected).trim().toLowerCase().replace(/^.*?([a-f0-9]{8,128}).*$/s, '$1');
      const algo = BY_LENGTH[expected.length];
      if (!algo || !/^[a-f0-9]+$/.test(expected)) throw new Error('Unrecognized hash. Paste a hex MD5, SHA-1, SHA-256, SHA-384, SHA-512 or CRC32 value.');
      ctx.setStep(0, 1, `Computing ${LABEL[algo]}`);
      const digest = (await hashFile(ctx.file, [algo], (f) => ctx.stepProgress(f), ctx.signal))[algo];
      const ok = digest === expected;
      return {
        summary: ok ? `✅ Match (${LABEL[algo]})` : `❌ MISMATCH (${LABEL[algo]})`,
        table: { title: ok ? 'The file is intact' : 'The file does not match', columns: ['', 'Value'], rows: [['Algorithm', LABEL[algo]], ['Expected', expected], ['Actual', digest], ['Result', ok ? '✅ Match' : '❌ Different']], mono: [1] },
        errors: ok ? [] : [{ file: ctx.file, error: 'Checksum mismatch: the file is corrupted or not the expected one' }],
      };
    },
  },
  {
    id: 'security.compare',
    name: 'Compare two files',
    icon: '⚖️',
    description: 'Check byte by byte whether two files are identical and find the first difference.',
    keywords: ['diff', 'identical', 'same', 'binary compare'],
    input: { kind: 'file', accept: null },
    output: 'none',
    options: [o.file('other', 'Second file', null, { required: true })],
    actionLabel: 'Compare',
    async run(ctx) {
      const a = ctx.file;
      const b = ctx.options.other;
      const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
      const ha = await fsp.open(a, 'r');
      const hb = await fsp.open(b, 'r');
      let offset = 0;
      let diff = -1;
      try {
        const size = 1 << 20;
        const ba = Buffer.alloc(size);
        const bb = Buffer.alloc(size);
        const max = Math.min(sa.size, sb.size);
        while (offset < max && diff < 0) {
          ctx.check();
          const [{ bytesRead: ra }, { bytesRead: rb }] = await Promise.all([ha.read(ba, 0, size, offset), hb.read(bb, 0, size, offset)]);
          const n = Math.min(ra, rb);
          if (!ba.subarray(0, n).equals(bb.subarray(0, n))) {
            for (let i = 0; i < n; i++)
              if (ba[i] !== bb[i]) {
                diff = offset + i;
                break;
              }
          }
          offset += n;
          ctx.progress((offset / max) * 100);
          if (!n) break;
        }
      } finally {
        await ha.close();
        await hb.close();
      }
      const identical = diff < 0 && sa.size === sb.size;
      const rows = [
        ['File A', `${path.basename(a)} (${formatBytes(sa.size)})`],
        ['File B', `${path.basename(b)} (${formatBytes(sb.size)})`],
        ['Result', identical ? '✅ Identical' : '❌ Different'],
      ];
      if (!identical) rows.push(['First difference', diff >= 0 ? `byte ${diff.toLocaleString()} (0x${diff.toString(16)})` : `files differ in size after byte ${Math.min(sa.size, sb.size).toLocaleString()}`]);
      return { summary: identical ? 'Files are identical' : 'Files are different', table: { title: 'Comparison', columns: ['', ''], rows } };
    },
  },
  {
    id: 'security.shred',
    name: 'Secure delete (shred)',
    icon: '🔥',
    description: 'Overwrite files with random data several times before deleting them, so they cannot be recovered.',
    keywords: ['wipe', 'shred', 'erase', 'permanent delete', 'destroy'],
    input: { kind: 'files', accept: null },
    output: 'none',
    danger: 'The selected files will be overwritten and permanently deleted. This cannot be undone. Note: on SSDs the drive may keep old copies internally.',
    options: [o.select('passes', 'Overwrite passes', [['1', '1 pass'], ['3', '3 passes'], ['7', '7 passes']], '3')],
    actionLabel: 'Shred',
    async run(ctx) {
      const passes = Number(ctx.options.passes) || 3;
      return ctx.eachFile(async (file) => {
        const { size } = await fsp.stat(file);
        const handle = await fsp.open(file, 'r+');
        try {
          const chunk = Buffer.alloc(Math.min(1 << 20, Math.max(1, size)));
          for (let p = 0; p < passes; p++) {
            let written = 0;
            while (written < size) {
              ctx.check();
              const n = Math.min(chunk.length, size - written);
              if (p === passes - 1 && passes > 1) chunk.fill(0, 0, n);
              else crypto.randomFillSync(chunk, 0, n);
              await handle.write(chunk, 0, n, written);
              written += n;
              ctx.stepProgress((p + written / size) / passes, `Pass ${p + 1}/${passes}`);
            }
            await handle.sync();
          }
        } finally {
          await handle.close();
        }
        const random = path.join(path.dirname(file), crypto.randomBytes(12).toString('hex'));
        await fsp.rename(file, random);
        await fsp.truncate(random, 0);
        await fsp.unlink(random);
        return { note: `🔥 ${path.basename(file)} destroyed (${formatBytes(size)}, ${passes} pass${passes > 1 ? 'es' : ''})` };
      });
    },
  },
];

module.exports = {
  category: { id: 'security', name: 'Security', icon: '🔐', color: ['#ee0979', '#ff6a00'], description: 'Encrypt, hash, verify, compare and shred' },
  tools,
  hashFile,
  moveToTrash,
};
