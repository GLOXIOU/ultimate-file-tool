const { spawn } = require('child_process');
const { unpacked } = require('./util');

const sevenZipPath = unpacked(require('7zip-bin').path7za);

function run7z(ctx, args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipPath, [...args, '-bsp1', '-bso1', '-bse1', '-y'], { windowsHide: true });
    if (ctx) ctx.track(child);
    let output = '';
    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      if (output.length > 400000) output = output.slice(-200000);
      const matches = text.match(/(\d{1,3})%/g);
      if (matches && onProgress) onProgress(Number(matches[matches.length - 1].replace('%', '')) / 100);
    });
    child.stderr.on('data', (data) => {
      output += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (ctx && ctx.cancelled) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (code === 0 || code === 1) return resolve(output);
      if (/Wrong password/i.test(output)) return reject(new Error('Wrong password'));
      const errorLine = output
        .split(/\r?\n/)
        .filter((l) => /ERROR|Error|Can not|Cannot/i.test(l))
        .slice(-2)
        .join(' | ');
      reject(new Error(`7-Zip failed: ${errorLine || `exit code ${code}`}`));
    });
  });
}

function parseList(output) {
  const entries = [];
  const blocks = output.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(' = ');
      if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 3).trim();
    }
    if (fields.Path && (fields.Size !== undefined || fields.Folder !== undefined) && !fields.Type) {
      entries.push({
        name: fields.Path,
        size: Number(fields.Size || 0),
        packed: Number(fields['Packed Size'] || 0),
        date: fields.Modified || '',
        dir: fields.Folder === '+',
        encrypted: fields.Encrypted === '+',
      });
    }
  }
  return entries;
}

module.exports = { sevenZipPath, run7z, parseList };
