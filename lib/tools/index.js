const ffmpeg = require('../core/ffmpeg');

const modules = [
  require('./image'),
  require('./video'),
  require('./audio'),
  require('./pdf'),
  require('./document'),
  require('./data'),
  require('./archive'),
  require('./security'),
  require('./web'),
  require('./files'),
  require('./utility'),
];

const categories = [];
const handlers = new Map();
const services = new Map([['core.ffmpegVersion', () => ffmpeg.version()]]);

for (const mod of modules) {
  const tools = mod.tools.map(({ run, ...meta }) => {
    if (run) handlers.set(meta.id, run);
    return { output: 'dir', runIn: run ? 'main' : 'renderer', ...meta, category: mod.category.id };
  });
  categories.push({ ...mod.category, tools });
  for (const [name, fn] of Object.entries(mod.services || {})) services.set(name, fn);
}

module.exports = { categories, handlers, services };
