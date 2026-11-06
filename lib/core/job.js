const path = require('path');
const fsp = require('fs').promises;
const { uniquePath, baseName, ext, uniqueDir } = require('./util');

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

class JobContext {
  constructor({ id, files = [], options = {}, outDir = null, emit = () => {}, settings = {} }) {
    this.id = id;
    this.files = files;
    this.options = options;
    this.outDir = outDir;
    this.settings = settings;
    this.emit = emit;
    this.cancelled = false;
    this.children = new Set();
    this.cleanups = [];
    this.step = { index: 0, total: 1 };
    this.lastEmit = 0;
    this.abortController = new AbortController();
  }

  get signal() {
    return this.abortController.signal;
  }

  get file() {
    return this.files[0];
  }

  progress(percent, message) {
    const now = Date.now();
    if (percent < 100 && now - this.lastEmit < 80 && !message) return;
    this.lastEmit = now;
    this.emit('progress', { percent: Math.max(0, Math.min(100, percent)), message });
  }

  message(message) {
    this.emit('progress', { message });
  }

  setStep(index, total, label) {
    this.step = { index, total };
    const prefix = total > 1 ? `[${index + 1}/${total}] ` : '';
    this.emit('progress', { percent: (index / total) * 100, message: `${prefix}${label || ''}` });
  }

  stepProgress(fraction, message) {
    const { index, total } = this.step;
    const clamped = Math.max(0, Math.min(1, fraction || 0));
    this.progress(((index + clamped) / total) * 100, message);
  }

  log(line) {
    this.emit('log', { line: String(line) });
  }

  track(child) {
    this.children.add(child);
    child.once('exit', () => this.children.delete(child));
    if (this.cancelled) child.kill();
    return child;
  }

  onCleanup(fn) {
    this.cleanups.push(fn);
  }

  async cleanup() {
    for (const fn of this.cleanups.splice(0)) {
      try {
        await fn();
      } catch {}
    }
  }

  cancel() {
    this.cancelled = true;
    this.abortController.abort();
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }

  check() {
    if (this.cancelled) throw new CancelledError();
  }

  dirFor(input) {
    if (this.outDir) return this.outDir;
    if (input) return path.dirname(input);
    return this.settings.fallbackDir;
  }

  async output(input, { suffix = '', extension, name, dir } = {}) {
    const targetDir = dir || this.dirFor(input);
    await fsp.mkdir(targetDir, { recursive: true });
    const stem = name || `${baseName(input)}${suffix}`;
    const finalExt = extension === undefined ? ext(input) : extension;
    return uniquePath(path.join(targetDir, finalExt ? `${stem}.${finalExt}` : stem));
  }

  async outputFolder(input, suffix, { name } = {}) {
    const targetDir = this.dirFor(input);
    return uniqueDir(path.join(targetDir, name || `${baseName(input)}${suffix}`));
  }

  async eachFile(fn, files = this.files) {
    const outputs = [];
    const errors = [];
    const notes = [];
    for (let i = 0; i < files.length; i++) {
      this.check();
      const file = files[i];
      this.setStep(i, files.length, path.basename(file));
      try {
        const result = await fn(file, i);
        if (result && typeof result === 'object' && !Array.isArray(result) && (result.outputs || result.note)) {
          if (result.outputs) outputs.push(...[].concat(result.outputs));
          if (result.note) notes.push(result.note);
        } else if (result) {
          outputs.push(...[].concat(result));
        }
      } catch (error) {
        if (error.cancelled || this.cancelled) throw new CancelledError();
        errors.push({ file, error: error.message });
      }
    }
    this.progress(100);
    return { outputs, errors, notes };
  }
}

module.exports = { JobContext, CancelledError };
