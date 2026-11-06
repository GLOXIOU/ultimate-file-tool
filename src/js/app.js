(() => {
  const api = window.api;
  const $ = (selector, root = document) => root.querySelector(selector);

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, v);
          else el.style[prop] = v;
        }
      }
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'checked' || key === 'value' || key === 'disabled' || key === 'selected') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function fill(el, ...children) {
    el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  }

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`uft.${key}`);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`uft.${key}`, JSON.stringify(value));
      } catch {}
    },
    remove(key) {
      localStorage.removeItem(`uft.${key}`);
    },
  };

  const DEFAULT_SETTINGS = { outputMode: 'source', customDir: '', openFolder: false, notify: true, animations: true };
  const STOPWORDS = new Set(['to', 'a', 'an', 'the', 'in', 'into', 'for', 'of', 'and', 'de', 'en', 'vers', 'un', 'une', 'le', 'la', 'les', 'file', 'files']);

  const state = {
    boot: null,
    categories: [],
    tools: new Map(),
    catById: new Map(),
    settings: { ...DEFAULT_SETTINGS, ...store.get('settings', {}) },
    history: store.get('history', []),
    favorites: new Set(store.get('favorites', [])),
    sessions: new Map(),
    jobs: new Map(),
    quickFiles: [],
    route: { name: 'home', arg: '' },
    toolView: null,
  };

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(unit === 0 ? 0 : value < 10 ? 2 : 1)} ${units[unit]}`;
  }

  function formatElapsed(ms) {
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
  }

  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ts).toLocaleString();
  }

  function dirname(p) {
    const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return idx > 0 ? p.slice(0, idx) : p;
  }

  function basename(p) {
    const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function tileStyle(cat) {
    return { '--c1': cat.color[0], '--c2': cat.color[1] };
  }

  function toast(message, type = 'info', action) {
    const el = h(
      'div',
      { class: `toast ${type}` },
      h('span', {}, type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️'),
      h('span', { class: 'msg' }, message),
      action ? h('button', { class: 'mini', onclick: action.run }, action.label) : null,
    );
    $('#toasts').append(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, type === 'error' ? 6000 : 3500);
  }

  function modal({ title, message, confirm = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const close = (value) => {
        back.remove();
        resolve(value);
      };
      const back = h(
        'div',
        { class: 'modal-back', onclick: (e) => e.target === back && close(false) },
        h(
          'div',
          { class: 'modal' },
          h('h3', {}, title),
          h('p', {}, message),
          h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, confirm)),
        ),
      );
      document.body.append(back);
    });
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(
      () => toast('Copied to clipboard', 'success'),
      () => toast('Could not copy', 'error'),
    );
  }

  function saveSettings() {
    store.set('settings', state.settings);
    document.body.classList.toggle('no-anim', !state.settings.animations);
  }

  function toggleFavorite(id) {
    if (state.favorites.has(id)) state.favorites.delete(id);
    else state.favorites.add(id);
    store.set('favorites', [...state.favorites]);
  }

  function go(path) {
    location.hash = `#/${path}`;
  }

  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [name, ...rest] = hash.split('/');
    return { name: name || 'home', arg: decodeURIComponent(rest.join('/')) };
  }

  function session(tool) {
    if (!state.sessions.has(tool.id)) {
      const saved = store.get(`opts.${tool.id}`, {});
      const options = {};
      for (const field of tool.options || []) {
        let value = field.default;
        if (field.type !== 'password' && field.type !== 'file' && saved[field.id] !== undefined) {
          value = saved[field.id];
          if (field.type === 'select' && !field.choices.some((c) => String(c.value) === String(value))) value = field.default;
        }
        options[field.id] = Array.isArray(value) ? [...value] : value;
      }
      state.sessions.set(tool.id, { files: [], info: new Map(), options, confirm: {}, outMode: null, outDir: null, job: null, result: null });
    }
    return state.sessions.get(tool.id);
  }

  function persistOptions(tool, sess) {
    const keep = {};
    for (const field of tool.options || []) if (field.type !== 'password' && field.type !== 'file') keep[field.id] = sess.options[field.id];
    store.set(`opts.${tool.id}`, keep);
  }

  function visible(field, options) {
    if (!field.showIf) return true;
    return Object.entries(field.showIf).every(([key, values]) => values.map(String).includes(String(options[key])));
  }

  function toolCard(tool, { showCategory = false } = {}) {
    const cat = state.catById.get(tool.category);
    const star = h('button', {
      class: `star ${state.favorites.has(tool.id) ? 'on' : ''}`,
      title: 'Favorite',
      onclick: (e) => {
        e.stopPropagation();
        toggleFavorite(tool.id);
        star.classList.toggle('on', state.favorites.has(tool.id));
        star.textContent = state.favorites.has(tool.id) ? '★' : '☆';
      },
    }, state.favorites.has(tool.id) ? '★' : '☆');
    return h(
      'div',
      { class: 'tool-card', onclick: () => go(`tool/${tool.id}`) },
      h('div', { class: 'tile small', style: tileStyle(cat) }, tool.icon),
      h('div', { style: { minWidth: '0' } }, h('h4', {}, tool.name), h('p', {}, tool.description), showCategory ? h('div', { class: 'cat-label' }, `${cat.icon} ${cat.name}`) : null),
      star,
    );
  }

  function renderNav() {
    const nav = $('#nav');
    const route = state.route;
    const activeCat = route.name === 'cat' ? route.arg : route.name === 'tool' ? state.tools.get(route.arg)?.category : null;
    const runningCats = new Set([...state.jobs.values()].map((toolId) => state.tools.get(toolId)?.category));
    const item = (icon, label, active, onclick, extra) =>
      h('button', { class: `nav-item ${active ? 'active' : ''}`, onclick }, h('span', { class: 'nav-icon' }, icon), h('span', { class: 'nav-label' }, label), extra);
    fill(
      nav,
      item('🏠', 'Home', route.name === 'home', () => go('')),
      state.favorites.size ? item('⭐', 'Favorites', route.name === 'favorites', () => go('favorites'), h('span', { class: 'count' }, state.favorites.size)) : null,
      h('div', { class: 'nav-section' }, 'Categories'),
      state.categories.map((cat) =>
        item(cat.icon, cat.name, activeCat === cat.id, () => go(`cat/${cat.id}`), runningCats.has(cat.id) ? h('span', { class: 'badge-live', title: 'Running' }) : h('span', { class: 'count' }, cat.tools.length)),
      ),
    );
    fill(
      $('#sidebar-footer'),
      item('🕘', 'History', route.name === 'history', () => go('history'), state.history.length ? h('span', { class: 'count' }, state.history.length) : null),
      item('⚙️', 'Settings', route.name === 'settings', () => go('settings')),
      item('🐙', 'GitHub', false, () => api.external('https://github.com/GLOXIOU/ultimate-file-tool')),
      h('div', { class: 'version' }, `v${state.boot.versions.app} · Electron ${state.boot.versions.electron.split('.')[0]}`),
    );
  }

  function renderCrumbs(parts) {
    const crumbs = $('#crumbs');
    crumbs.replaceChildren();
    parts.forEach((part, i) => {
      if (i) crumbs.append(h('span', { class: 'sep' }, '›'));
      crumbs.append(i === parts.length - 1 ? h('span', { class: 'current' }, part.label) : h('a', { onclick: () => go(part.path) }, part.label));
    });
    $('#back').disabled = state.route.name === 'home';
  }

  function render() {
    state.route = parseRoute();
    state.toolView = null;
    const view = $('#view');
    view.replaceChildren();
    view.style.animation = 'none';
    void view.offsetHeight;
    view.style.animation = '';
    const renderers = { home: renderHome, cat: renderCategory, tool: renderTool, search: renderSearch, history: renderHistory, settings: renderSettings, quick: renderQuick, favorites: renderFavorites };
    const crumbs = (renderers[state.route.name] || renderHome)(view, state.route.arg) || [];
    renderCrumbs([{ label: 'Home', path: '' }, ...crumbs]);
    renderNav();
    $('#view-wrap').scrollTop = 0;
    const search = $('#search');
    if (state.route.name !== 'search' && document.activeElement !== search) search.value = '';
  }

  function renderHome(view) {
    const totalTools = state.tools.size;
    const formats = new Set();
    for (const tool of state.tools.values()) for (const e of tool.input?.accept || []) formats.add(e);
    const recentIds = [];
    for (const entry of state.history) if (!recentIds.includes(entry.toolId) && state.tools.has(entry.toolId)) recentIds.push(entry.toolId);
    view.append(
      h(
        'div',
        { class: 'hero' },
        h('img', { src: 'assets/logo-w.png', alt: '' }),
        h('h1', {}, 'Every file tool you need. Offline. Free.'),
        h('p', {}, 'Convert, compress, edit, secure and organize images, videos, audio, PDFs, documents, data and archives.'),
        h('div', { class: 'stats' }, h('span', { class: 'stat' }, h('b', {}, totalTools), ' tools'), h('span', { class: 'stat' }, h('b', {}, state.categories.length), ' categories'), h('span', { class: 'stat' }, h('b', {}, `${formats.size}+`), ' file formats'), h('span', { class: 'stat' }, h('b', {}, '100%'), ' local, no upload')),
      ),
      h(
        'div',
        {
          class: 'quickdrop',
          onclick: async () => {
            const files = await api.pickFiles({ multiple: true, title: 'Pick files to see what you can do' });
            if (files.length) openQuick(files);
          },
        },
        h('div', { class: 'big' }, '📥 Drop any file here (or click) to see what you can do with it'),
        h('div', {}, 'Ctrl+K to search across all tools'),
      ),
    );
    if (state.favorites.size) {
      view.append(h('div', { class: 'section-title' }, h('h2', {}, '⭐ Favorites')), h('div', { class: 'tool-grid' }, [...state.favorites].filter((id) => state.tools.has(id)).map((id) => toolCard(state.tools.get(id), { showCategory: true }))));
    }
    if (recentIds.length) {
      view.append(h('div', { class: 'section-title' }, h('h2', {}, '🕘 Recently used')), h('div', { class: 'tool-grid' }, recentIds.slice(0, 6).map((id) => toolCard(state.tools.get(id), { showCategory: true }))));
    }
    view.append(
      h('div', { class: 'section-title' }, h('h2', {}, 'Categories'), h('span', { class: 'hint' }, 'Pick a category to browse its tools')),
      h(
        'div',
        { class: 'cat-grid' },
        state.categories.map((cat) =>
          h(
            'div',
            { class: 'cat-card', style: tileStyle(cat), onclick: () => go(`cat/${cat.id}`) },
            h('div', { class: 'cat-head' }, h('div', { class: 'tile', style: tileStyle(cat) }, cat.icon), h('div', {}, h('h3', {}, cat.name), h('div', { class: 'meta' }, `${cat.tools.length} tools`))),
            h('p', {}, cat.description),
            h('div', { class: 'chips' }, cat.tools.slice(0, 4).map((t) => h('span', { class: 'chip' }, t.name)), cat.tools.length > 4 ? h('span', { class: 'chip' }, `+${cat.tools.length - 4}`) : null),
          ),
        ),
      ),
    );
    return [];
  }

  function renderCategory(view, id) {
    const cat = state.catById.get(id);
    if (!cat) return renderHome(view);
    view.append(
      h('div', { class: 'page-head' }, h('div', { class: 'tile large', style: tileStyle(cat) }, cat.icon), h('div', {}, h('h1', {}, cat.name), h('p', {}, `${cat.description} · ${cat.tools.length} tools`))),
      h('div', { class: 'tool-grid' }, cat.tools.map((t) => toolCard(t))),
    );
    return [{ label: cat.name, path: `cat/${cat.id}` }];
  }

  function renderFavorites(view) {
    const tools = [...state.favorites].filter((id) => state.tools.has(id)).map((id) => state.tools.get(id));
    view.append(h('div', { class: 'page-head' }, h('div', { class: 'tile large', style: { '--c1': '#ffb347', '--c2': '#ffcc33' } }, '⭐'), h('div', {}, h('h1', {}, 'Favorites'), h('p', {}, 'Your starred tools.'))));
    if (!tools.length) view.append(emptyState('⭐', 'No favorites yet', 'Hover a tool card and click the star to pin it here.'));
    else view.append(h('div', { class: 'tool-grid' }, tools.map((t) => toolCard(t, { showCategory: true }))));
    return [{ label: 'Favorites', path: 'favorites' }];
  }

  function emptyState(icon, title, text) {
    return h('div', { class: 'empty-state' }, h('div', { class: 'icon' }, icon), h('h3', {}, title), h('p', {}, text));
  }

  function searchTools(query) {
    const terms = query
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((t) => t && !STOPWORDS.has(t));
    if (!terms.length) return [];
    const results = [];
    for (const tool of state.tools.values()) {
      const cat = state.catById.get(tool.category);
      const name = tool.name.toLowerCase();
      const keywords = (tool.keywords || []).join(' ').toLowerCase();
      const accept = tool.input?.accept || [];
      const desc = tool.description.toLowerCase();
      let score = 0;
      let all = true;
      for (const term of terms) {
        let s = 0;
        if (name.split(/[\s&/()]+/).some((w) => w.startsWith(term))) s += 14;
        else if (name.includes(term)) s += 10;
        if (keywords.includes(term)) s += 6;
        if (accept.includes(term)) s += 5;
        if (desc.includes(term)) s += 3;
        if (cat.name.toLowerCase().includes(term)) s += 3;
        if (!s) all = false;
        score += s;
      }
      if (all && score) results.push({ tool, score });
    }
    return results.sort((a, b) => b.score - a.score).map((r) => r.tool);
  }

  function renderSearch(view, query) {
    const results = searchTools(query);
    view.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, `Search: “${query}”`), h('p', {}, `${results.length} tool${results.length === 1 ? '' : 's'} found`))));
    if (!results.length) view.append(emptyState('🔍', 'Nothing found', 'Try a format (mp4, pdf, heic…) or an action (compress, merge, convert…).'));
    else view.append(h('div', { class: 'tool-grid' }, results.map((t) => toolCard(t, { showCategory: true }))));
    return [{ label: 'Search', path: `search/${encodeURIComponent(query)}` }];
  }

  async function openQuick(paths) {
    state.quickFiles = (await api.describe(paths)).filter((f) => !f.missing);
    if (!state.quickFiles.length) return;
    if (state.route.name === 'quick') render();
    else go('quick');
  }

  function toolsForFiles(files) {
    const exts = new Set(files.filter((f) => !f.dir).map((f) => f.ext));
    const hasDir = files.some((f) => f.dir);
    const matches = [];
    for (const tool of state.tools.values()) {
      const input = tool.input || { kind: 'none' };
      if (input.kind === 'none') continue;
      if (input.kind === 'folder') {
        if (hasDir) matches.push({ tool, generic: false });
        continue;
      }
      if (hasDir && input.kind !== 'paths' && !exts.size) continue;
      if (!input.accept || !input.accept.length) {
        matches.push({ tool, generic: true });
        continue;
      }
      if (exts.size && [...exts].every((e) => input.accept.includes(e))) matches.push({ tool, generic: false });
    }
    return matches;
  }

  function renderQuick(view) {
    const files = state.quickFiles;
    if (!files.length) return renderHome(view);
    const matches = toolsForFiles(files);
    const specific = matches.filter((m) => !m.generic);
    const generic = matches.filter((m) => m.generic);
    const exts = [...new Set(files.map((f) => (f.dir ? 'folder' : f.ext || '?')))];
    view.append(
      h('div', { class: 'page-head' }, h('div', { class: 'tile large', style: { '--c1': '#0073ff', '--c2': '#00b7ff' } }, '⚡'), h('div', {}, h('h1', {}, 'Quick actions'), h('p', {}, `${files.length} item${files.length > 1 ? 's' : ''} · ${exts.map((e) => e.toUpperCase()).join(', ')} · ${specific.length + generic.length} tools available`))),
      h('div', { class: 'card', style: { marginBottom: '18px' } }, h('div', { class: 'card-body' }, h('ul', { class: 'file-list' }, files.slice(0, 8).map((f) => fileRow(f))), files.length > 8 ? h('div', { class: 'empty-note' }, `+ ${files.length - 8} more`) : null)),
    );
    const byCat = new Map();
    for (const m of specific) {
      if (!byCat.has(m.tool.category)) byCat.set(m.tool.category, []);
      byCat.get(m.tool.category).push(m.tool);
    }
    if (!specific.length) view.append(emptyState('🤔', 'No dedicated tools for this format', 'The generic tools below work with any file.'));
    for (const [catId, tools] of byCat) {
      const cat = state.catById.get(catId);
      view.append(h('div', { class: 'section-title' }, h('h2', {}, `${cat.icon} ${cat.name}`)), h('div', { class: 'tool-grid' }, tools.map((t) => quickCard(t))));
    }
    if (generic.length) view.append(h('div', { class: 'section-title' }, h('h2', {}, '🧰 Works with any file')), h('div', { class: 'tool-grid' }, generic.map((m) => quickCard(m.tool))));
    return [{ label: 'Quick actions', path: 'quick' }];
  }

  function quickCard(tool) {
    const card = toolCard(tool);
    card.onclick = async () => {
      const sess = session(tool);
      sess.files = [];
      sess.info.clear();
      sess.result = null;
      go(`tool/${tool.id}`);
      await addPaths(tool, sess, state.quickFiles.map((f) => f.path), { silent: true });
    };
    return card;
  }

  function fileRow(info, actions) {
    const thumb = h('div', { class: 'thumb' }, info.image ? h('img', { src: `${info.url}?v=${Math.round(info.mtime || 0)}`, loading: 'lazy', onerror: (e) => e.target.remove() }) : info.dir ? '📁' : (info.ext || '?').slice(0, 4));
    return h(
      'li',
      { class: 'file-item' },
      thumb,
      h('div', { class: 'info' }, h('div', { class: 'name', title: info.path }, info.name), h('div', { class: 'detail' }, [info.dir ? 'Folder' : formatBytes(info.size), dirname(info.path)].filter(Boolean).join(' · '))),
      actions ? h('div', { class: 'tools' }, actions) : null,
    );
  }

  function acceptLabel(tool) {
    const accept = tool.input?.accept;
    if (!accept || !accept.length) return 'Any file type';
    return `${accept.length} formats supported`;
  }

  async function addPaths(tool, sess, paths, { silent = false } = {}) {
    const input = tool.input;
    const infos = await api.describe(paths);
    const accept = input.accept && input.accept.length ? input.accept : null;
    const added = [];
    let skipped = 0;
    for (const info of infos) {
      if (info.missing) continue;
      if (input.kind === 'folder') {
        if (info.dir) {
          sess.files = [info.path];
          sess.info.set(info.path, info);
          added.push(info);
          break;
        }
        skipped++;
        continue;
      }
      if (info.dir) {
        if (input.kind === 'paths') {
          added.push(info);
          continue;
        }
        const listed = await api.listFiles(info.path, accept, true);
        added.push(...(await api.describe(listed)));
        continue;
      }
      if (accept && !accept.includes(info.ext)) {
        skipped++;
        continue;
      }
      added.push(info);
    }
    if (input.kind !== 'folder') {
      if (input.kind === 'file') {
        if (added[0]) {
          sess.files = [added[0].path];
          sess.info.clear();
          sess.info.set(added[0].path, added[0]);
        }
      } else {
        for (const info of added) {
          if (!sess.files.includes(info.path)) {
            sess.files.push(info.path);
            sess.info.set(info.path, info);
          }
        }
      }
    }
    if (skipped && !silent) toast(`${skipped} item${skipped > 1 ? 's' : ''} skipped (unsupported format)`, 'error');
    if (state.toolView && state.toolView.tool.id === tool.id) state.toolView.refreshInput();
  }

  function renderInputCard(tool, sess) {
    const input = tool.input || { kind: 'none' };
    if (input.kind === 'none') return null;
    const body = h('div', { class: 'card-body' });
    const countLabel = h('span', { class: 'sub' });
    const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, input.kind === 'folder' ? '📁 Folder' : input.kind === 'file' ? '📄 File' : '📄 Files'), countLabel, h('div', { class: 'right' }, h('span', { class: 'sub' }, acceptLabel(tool)))), body);

    const browse = async () => {
      if (input.kind === 'folder') {
        const dirs = await api.pickFolder({});
        if (dirs.length) addPaths(tool, sess, dirs);
      } else {
        const files = await api.pickFiles({ accept: input.accept, multiple: input.kind !== 'file' });
        if (files.length) addPaths(tool, sess, files);
      }
    };
    const browseFolder = async () => {
      const dirs = await api.pickFolder({ multiple: input.kind === 'paths' });
      if (dirs.length) addPaths(tool, sess, dirs);
    };

    const refresh = () => {
      body.replaceChildren();
      const files = sess.files;
      countLabel.textContent = files.length > 1 ? `${files.length} items` : '';
      if (!files.length) {
        const accept = input.accept || [];
        const zone = h(
          'div',
          { class: 'dropzone', onclick: browse },
          h('div', { class: 'icon' }, input.kind === 'folder' ? '📁' : '📥'),
          h('div', { class: 'big' }, input.kind === 'folder' ? 'Choose a folder' : input.kind === 'file' ? 'Choose a file' : 'Choose files'),
          h('div', { class: 'small' }, input.kind === 'folder' ? 'or drop a folder here' : `or drop ${input.kind === 'file' ? 'it' : 'them'} here${input.kind === 'files' ? ' · folders are scanned too' : ''}`),
          accept.length ? h('div', { class: 'formats' }, accept.slice(0, 18).map((e) => h('span', { class: 'chip ext' }, e)), accept.length > 18 ? h('span', { class: 'chip' }, `+${accept.length - 18}`) : null) : null,
        );
        body.append(zone);
        if (input.kind === 'files' || input.kind === 'paths') {
          body.append(h('div', { class: 'list-footer' }, h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); browseFolder(); } }, '📁 Add a folder')));
        }
        return;
      }
      let total = 0;
      const list = h('ul', { class: 'file-list' });
      files.forEach((file, index) => {
        const info = sess.info.get(file) || { path: file, name: basename(file) };
        total += info.size || 0;
        const actions = [];
        if (input.ordered && files.length > 1) {
          actions.push(
            h('button', { class: 'mini', title: 'Move up', disabled: index === 0, onclick: () => { files.splice(index - 1, 0, files.splice(index, 1)[0]); refresh(); } }, '↑'),
            h('button', { class: 'mini', title: 'Move down', disabled: index === files.length - 1, onclick: () => { files.splice(index + 1, 0, files.splice(index, 1)[0]); refresh(); } }, '↓'),
          );
        }
        actions.push(h('button', { class: 'mini', title: 'Show in folder', onclick: () => api.show(file) }, '📂'));
        actions.push(h('button', { class: 'mini danger', title: 'Remove', onclick: () => { files.splice(index, 1); sess.info.delete(file); refresh(); } }, '✕'));
        list.append(fileRow(info, actions));
      });
      body.append(list);
      const footer = h('div', { class: 'list-footer' });
      if (input.kind === 'folder' || input.kind === 'file') footer.append(h('button', { class: 'btn', onclick: browse }, 'Change…'));
      else footer.append(h('button', { class: 'btn', onclick: browse }, '＋ Add files'), h('button', { class: 'btn', onclick: browseFolder }, '📁 Add folder'));
      footer.append(h('button', { class: 'btn ghost', onclick: () => { sess.files = []; sess.info.clear(); refresh(); } }, 'Clear'));
      if (input.ordered && files.length > 1) footer.append(h('button', { class: 'btn ghost', onclick: () => { files.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true })); refresh(); } }, 'Sort A→Z'));
      if (input.kind !== 'folder' && total) footer.append(h('span', { class: 'total' }, formatBytes(total)));
      body.append(footer);
    };
    refresh();
    return { card, refresh };
  }

  function renderField(tool, sess, field, rerender) {
    const value = sess.options[field.id];
    const dependents = new Set((tool.options || []).flatMap((f) => (f.showIf ? Object.keys(f.showIf) : [])));
    const set = (v) => {
      sess.options[field.id] = v;
      persistOptions(tool, sess);
      if (dependents.has(field.id)) rerender();
    };
    let wide = ['textarea', 'multi', 'file'].includes(field.type) || field.wide;
    let control;
    switch (field.type) {
      case 'select': {
        const short = field.choices.length <= 4 && field.choices.reduce((n, c) => n + String(c.label).length, 0) <= 34;
        const tiny = field.choices.length <= 8 && field.choices.every((c) => String(c.label).length <= 5);
        if (short || tiny) {
          if (tiny && field.choices.length > 4) wide = true;
          control = h('div', { class: 'segmented' });
          for (const choice of field.choices) {
            const btn = h('button', { class: String(choice.value) === String(value) ? 'on' : '', onclick: () => { control.querySelectorAll('button').forEach((b) => b.classList.remove('on')); btn.classList.add('on'); set(choice.value); } }, choice.label);
            control.append(btn);
          }
        } else {
          control = h('select', { class: 'input', onchange: (e) => set(field.choices[e.target.selectedIndex].value) }, field.choices.map((c) => h('option', { selected: String(c.value) === String(value) }, c.label)));
        }
        break;
      }
      case 'range': {
        const badge = h('span', { class: 'val' }, value);
        const input = h('input', { type: 'range', min: field.min, max: field.max, step: field.step || 1, value: String(value) });
        const paint = () => input.style.setProperty('--fill', `${((Number(input.value) - field.min) / (field.max - field.min)) * 100}%`);
        input.addEventListener('input', () => { badge.textContent = input.value; paint(); sess.options[field.id] = Number(input.value); });
        input.addEventListener('change', () => set(Number(input.value)));
        paint();
        return h('div', { class: 'field' }, h('label', {}, h('span', {}, field.label), badge), h('div', { class: 'range-row' }, input), field.help ? h('div', { class: 'help' }, field.help) : null);
      }
      case 'number':
        control = h('input', { class: 'input', type: 'number', value: String(value ?? ''), min: field.min, max: field.max, step: field.step || 'any', oninput: (e) => set(e.target.value === '' ? '' : Number(e.target.value)) });
        break;
      case 'textarea':
        control = h('textarea', { class: 'input', rows: field.rows || 4, placeholder: field.placeholder || '', oninput: (e) => set(e.target.value) });
        control.value = value ?? '';
        break;
      case 'checkbox':
        return h('div', { class: `field ${field.wide ? 'wide' : ''}` }, h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: Boolean(value), onchange: (e) => set(e.target.checked) }), h('span', { class: 'track' }), h('span', {}, field.label)), field.help ? h('div', { class: 'help' }, field.help) : null);
      case 'color': {
        const text = h('input', { class: 'input', value: value || '#000000', style: { fontFamily: 'var(--mono)' } });
        const picker = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000' });
        picker.addEventListener('input', () => { text.value = picker.value; set(picker.value); });
        text.addEventListener('change', () => { if (/^#[0-9a-f]{6}$/i.test(text.value)) { picker.value = text.value; set(text.value); } });
        control = h('div', { class: 'color-row' }, picker, text);
        break;
      }
      case 'password': {
        const main = h('input', { class: 'input', type: 'password', value: value || '', placeholder: field.placeholder || '••••••••', autocomplete: 'new-password', oninput: (e) => set(e.target.value) });
        if (field.confirm) {
          wide = true;
          const again = h('input', { class: 'input', type: 'password', value: sess.confirm[field.id] || '', placeholder: 'Repeat password', autocomplete: 'new-password', oninput: (e) => { sess.confirm[field.id] = e.target.value; } });
          control = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } }, main, again);
        } else control = main;
        break;
      }
      case 'file': {
        const pathEl = h('div', { class: `path ${value ? '' : 'empty'}`, title: value || '' }, value ? value : 'No file selected');
        control = h(
          'div',
          { class: 'path-row' },
          pathEl,
          h('button', { class: 'btn', onclick: async () => { const files = await api.pickFiles({ accept: field.accept, multiple: false }); if (files[0]) { set(files[0]); rerender(); } } }, 'Browse…'),
          value ? h('button', { class: 'mini danger', onclick: () => { set(''); rerender(); } }, '✕') : null,
        );
        break;
      }
      case 'folder': {
        const pathEl = h('div', { class: `path ${value ? '' : 'empty'}`, title: value || '' }, value ? value : 'No folder selected');
        wide = true;
        control = h('div', { class: 'path-row' }, pathEl, h('button', { class: 'btn', onclick: async () => { const dirs = await api.pickFolder({}); if (dirs[0]) { set(dirs[0]); rerender(); } } }, 'Browse…'));
        break;
      }
      case 'datetime':
        control = h('input', { class: 'input', type: 'datetime-local', value: value || '', oninput: (e) => set(e.target.value) });
        break;
      case 'multi': {
        const current = new Set(Array.isArray(value) ? value : []);
        control = h('div', { class: 'multi' });
        for (const choice of field.choices) {
          const btn = h('button', { class: current.has(choice.value) ? 'on' : '', onclick: () => { if (current.has(choice.value)) current.delete(choice.value); else current.add(choice.value); btn.classList.toggle('on'); set(field.choices.map((c) => c.value).filter((v) => current.has(v))); } }, choice.label);
          control.append(btn);
        }
        break;
      }
      default:
        control = h('input', { class: 'input', type: 'text', value: value ?? '', placeholder: field.placeholder || '', spellcheck: 'false', oninput: (e) => set(e.target.value) });
        if (field.wide) wide = true;
    }
    return h('div', { class: `field ${wide ? 'wide' : ''}` }, h('label', {}, h('span', {}, field.label)), control, field.help ? h('div', { class: 'help' }, field.help) : null);
  }

  function renderOptionsCard(tool, sess) {
    const body = h('div', { class: 'card-body' });
    const rerender = () => {
      body.replaceChildren();
      const fields = (tool.options || []).filter((f) => visible(f, sess.options));
      if (!fields.length) {
        body.append(h('div', { class: 'empty-note' }, 'No settings needed, just add your files and run.'));
        return;
      }
      body.append(h('div', { class: 'fields' }, fields.map((f) => renderField(tool, sess, f, rerender))));
    };
    rerender();
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, '⚙️ Options'), h('div', { class: 'right' }, (tool.options || []).length ? h('button', { class: 'mini', title: 'Reset options', onclick: () => { for (const f of tool.options) sess.options[f.id] = Array.isArray(f.default) ? [...f.default] : f.default; persistOptions(tool, sess); rerender(); } }, 'Reset') : null)), body);
  }

  function outputDirFor(sess) {
    const mode = sess.outMode || state.settings.outputMode;
    const dir = sess.outDir || state.settings.customDir;
    return mode === 'custom' && dir ? dir : null;
  }

  function fallbackDir() {
    return state.settings.outputMode === 'custom' && state.settings.customDir ? state.settings.customDir : state.boot.paths.downloads;
  }

  function renderOutputSection(tool, sess) {
    if (tool.output === 'none') return null;
    const wrap = h('div', { class: 'field wide' });
    const noInput = (tool.input?.kind || 'none') === 'none';
    const refresh = () => {
      wrap.replaceChildren();
      const mode = sess.outMode || state.settings.outputMode;
      const dir = sess.outDir || state.settings.customDir;
      const seg = h('div', { class: 'segmented' });
      for (const [value, label] of [['source', noInput ? 'Default folder' : 'Next to the original'], ['custom', 'Custom folder']]) {
        seg.append(h('button', { class: mode === value ? 'on' : '', onclick: async () => {
          if (value === 'custom' && !dir) {
            const dirs = await api.pickFolder({});
            if (!dirs[0]) return;
            sess.outDir = dirs[0];
          }
          sess.outMode = value;
          refresh();
        } }, label));
      }
      wrap.append(h('label', {}, h('span', {}, 'Save results to')), seg);
      if (mode === 'custom' && dir) {
        wrap.append(h('div', { class: 'path-row' }, h('div', { class: 'path', title: dir }, dir), h('button', { class: 'btn', onclick: async () => { const dirs = await api.pickFolder({}); if (dirs[0]) { sess.outDir = dirs[0]; refresh(); } } }, 'Change…')));
      } else if (noInput) {
        wrap.append(h('div', { class: 'help' }, fallbackDir()));
      }
    };
    refresh();
    return wrap;
  }

  function renderTool(view, id) {
    const tool = state.tools.get(id);
    if (!tool) return renderHome(view);
    const cat = state.catById.get(tool.category);
    const sess = session(tool);
    const star = h('button', { class: 'btn', onclick: () => { toggleFavorite(tool.id); star.textContent = state.favorites.has(tool.id) ? '★ Favorite' : '☆ Favorite'; renderNav(); } }, state.favorites.has(tool.id) ? '★ Favorite' : '☆ Favorite');
    view.append(h('div', { class: 'page-head' }, h('div', { class: 'tile large', style: tileStyle(cat) }, tool.icon), h('div', {}, h('h1', {}, tool.name), h('p', {}, tool.description)), h('div', { class: 'actions' }, star)));

    const inputCard = renderInputCard(tool, sess);
    const progressBox = h('div', { class: 'progress' });
    const runRow = h('div', { class: 'run-row' });
    const resultBox = h('div', {});
    const outputSection = renderOutputSection(tool, sess);
    const runCard = h('div', { class: 'card run-card' }, h('div', { class: 'card-body' }, outputSection, runRow, progressBox));

    const refreshRun = () => {
      runRow.replaceChildren();
      progressBox.replaceChildren();
      if (sess.job) {
        runRow.append(h('button', { class: 'btn big danger', onclick: () => cancelJob(tool, sess) }, '■ Cancel'));
        const fill = h('div', { class: 'fill', style: { width: `${sess.job.percent || 0}%` } });
        const bar = h('div', { class: `bar ${sess.job.percent ? '' : 'indeterminate'}` }, fill);
        const msg = h('span', { class: 'msg' }, sess.job.message || 'Working…');
        const pct = h('span', { class: 'pct' }, sess.job.percent ? `${Math.floor(sess.job.percent)}%` : '');
        progressBox.append(bar, h('div', { class: 'progress-line' }, msg, pct));
        sess.job.els = { fill, bar, msg, pct };
      } else {
        if (tool.preview) runRow.append(h('button', { class: 'btn big', onclick: () => runTool(tool, sess, { dryRun: true }) }, '👁 Preview'));
        runRow.append(h('button', { class: `btn big ${tool.danger ? 'danger' : 'primary'}`, onclick: () => runTool(tool, sess, { dryRun: false }) }, `${tool.danger ? '⚠ ' : '▶ '}${tool.actionLabel || 'Run'}`));
      }
    };
    const refreshResult = () => {
      resultBox.replaceChildren();
      if (sess.result) resultBox.append(renderResult(tool, sess, sess.result));
    };

    const left = h('div', { class: 'col' }, inputCard ? inputCard.card : null, resultBox);
    const right = h('div', { class: 'col' }, renderOptionsCard(tool, sess), runCard);
    view.append(h('div', { class: 'tool-layout' }, left, right));
    refreshRun();
    refreshResult();
    state.toolView = { tool, sess, refreshRun, refreshResult, refreshInput: () => inputCard && inputCard.refresh() };
    return [{ label: cat.name, path: `cat/${cat.id}` }, { label: tool.name, path: `tool/${tool.id}` }];
  }

  function validate(tool, sess) {
    const input = tool.input || { kind: 'none' };
    if (input.kind !== 'none') {
      const min = input.min || 1;
      if (sess.files.length < min) return input.kind === 'folder' ? 'Choose a folder first' : min > 1 ? `Add at least ${min} files` : 'Add a file first';
    }
    for (const field of tool.options || []) {
      if (!visible(field, sess.options)) continue;
      const value = sess.options[field.id];
      if (field.required && (value === '' || value === null || value === undefined || (Array.isArray(value) && !value.length))) return `"${field.label}" is required`;
      if (field.type === 'password' && field.confirm && value !== (sess.confirm[field.id] || '')) return 'Passwords do not match';
      if (field.type === 'password' && field.required && String(value).length < (field.minLength || 1)) return `Password must be at least ${field.minLength} characters`;
    }
    return null;
  }

  async function runTool(tool, sess, { dryRun }) {
    if (sess.job) return;
    const problem = validate(tool, sess);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    if (tool.danger && !dryRun) {
      const ok = await modal({ title: `${tool.name}?`, message: tool.danger, confirm: tool.actionLabel || 'Continue', danger: true });
      if (!ok) return;
    }
    const jobId = uid();
    sess.job = { id: jobId, percent: 0, message: 'Starting…', cancelled: false };
    sess.result = null;
    state.jobs.set(jobId, tool.id);
    if (state.toolView?.tool.id === tool.id) {
      state.toolView.refreshRun();
      state.toolView.refreshResult();
    }
    renderNav();
    const payload = { jobId, toolId: tool.id, files: [...sess.files], options: { ...sess.options, dryRun }, outDir: outputDirFor(sess), fallbackDir: fallbackDir() };
    let result;
    try {
      if (tool.runIn === 'renderer') {
        const started = Date.now();
        const raw = await window.RendererTools.run(tool.id, {
          ...payload,
          progress: (percent, message) => onJobEvent({ jobId, type: 'progress', percent, message }),
          isCancelled: () => sess.job?.cancelled,
        });
        result = { ok: true, elapsed: Date.now() - started, errors: [], notes: [], ...raw, outputs: raw.outputs ? (await api.describe(raw.outputs)).filter((o) => !o.missing) : [] };
      } else {
        result = await api.run(payload);
      }
    } catch (error) {
      result = { ok: false, error: String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
    }
    if (sess.job?.cancelled) result = { ok: false, cancelled: true, error: 'Cancelled' };
    state.jobs.delete(jobId);
    sess.job = null;
    sess.result = { ...result, dryRun };
    if (state.toolView?.tool.id === tool.id) {
      state.toolView.refreshRun();
      state.toolView.refreshResult();
    }
    finishJob(tool, sess.result, dryRun);
  }

  function finishJob(tool, result, dryRun) {
    if (result.ok && !dryRun) {
      state.history.unshift({
        id: uid(),
        toolId: tool.id,
        at: Date.now(),
        ok: !(result.errors || []).length,
        summary: result.summary || (result.outputs?.length ? `${result.outputs.length} file${result.outputs.length > 1 ? 's' : ''} created` : 'Completed'),
        outputs: (result.outputs || []).slice(0, 8).map((o) => ({ path: o.path, name: o.name, dir: o.dir })),
        count: (result.outputs || []).length,
      });
      state.history = state.history.slice(0, 80);
      store.set('history', state.history);
      if (state.settings.openFolder && result.outputs?.length) api.show(result.outputs[0].path);
    }
    renderNav();
    const viewing = state.toolView?.tool.id === tool.id && document.hasFocus();
    if (!viewing) {
      const message = result.ok ? `${tool.name}: done` : result.cancelled ? `${tool.name}: cancelled` : `${tool.name}: ${result.error}`;
      toast(message, result.ok ? 'success' : 'error', { label: 'Open', run: () => go(`tool/${tool.id}`) });
      if (state.settings.notify && !document.hasFocus() && 'Notification' in window) {
        try {
          new Notification('Ultimate File Tool', { body: message, silent: false });
        } catch {}
      }
    }
  }

  async function cancelJob(tool, sess) {
    if (!sess.job) return;
    sess.job.cancelled = true;
    sess.job.message = 'Cancelling…';
    if (tool.runIn !== 'renderer') await api.cancel(sess.job.id);
  }

  function onJobEvent(event) {
    const toolId = state.jobs.get(event.jobId);
    if (!toolId) return;
    const sess = state.sessions.get(toolId);
    if (!sess || !sess.job || sess.job.id !== event.jobId) return;
    if (event.type === 'progress') {
      if (typeof event.percent === 'number') sess.job.percent = event.percent;
      if (event.message) sess.job.message = event.message;
      const els = sess.job.els;
      if (els && state.toolView?.tool.id === toolId) {
        els.fill.style.width = `${sess.job.percent}%`;
        els.bar.classList.toggle('indeterminate', !sess.job.percent);
        els.msg.textContent = sess.job.message || '';
        els.pct.textContent = sess.job.percent ? `${Math.floor(sess.job.percent)}%` : '';
      }
    }
  }

  function renderTable(table, { limit = 1000 } = {}) {
    const rows = table.rows.slice(0, limit);
    const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data' },
        h('thead', {}, h('tr', {}, table.columns.map((c) => h('th', {}, c)))),
        h('tbody', {}, rows.map((row) => h('tr', {}, row.map((cell, i) => h('td', { class: table.mono && table.mono.includes(i) ? 'mono' : '' }, isColor(cell) ? h('span', { class: 'color-dot', style: { background: cell } }) : null, cell === null || cell === undefined ? '' : String(cell)))))),
      ),
      table.rows.length > limit ? h('div', { class: 'empty-note', style: { padding: '8px 10px' } }, `Showing ${limit} of ${table.rows.length} rows`) : null,
    );
  }

  async function saveText(tool, sess, text, extension) {
    const name = `${tool.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-result`;
    const target = await api.outputPath(sess.files[0] && !(sess.info.get(sess.files[0]) || {}).dir ? sess.files[0] : null, { name, extension: extension || 'txt', outDir: outputDirFor(sess), fallbackDir: fallbackDir() });
    await api.writeFile(target, text);
    toast(`Saved ${basename(target)}`, 'success', { label: 'Show', run: () => api.show(target) });
  }

  function renderResult(tool, sess, result) {
    const card = h('div', { class: 'card' });
    const errors = result.errors || [];
    const outputs = result.outputs || [];
    let cls = 'ok';
    let icon = '✅';
    let title = result.dryRun ? 'Preview ready' : 'Done';
    if (!result.ok) {
      cls = 'fail';
      icon = result.cancelled ? '⏹️' : '❌';
      title = result.cancelled ? 'Cancelled' : 'Failed';
    } else if (errors.length) {
      cls = 'warn';
      icon = '⚠️';
      title = outputs.length || result.text || result.sections?.length ? `Done with ${errors.length} error${errors.length > 1 ? 's' : ''}` : 'Failed';
      if (!(outputs.length || result.text || result.sections?.length || result.table)) cls = 'fail';
    }
    const sub = [];
    if (result.ok) {
      if (outputs.length) sub.push(`${outputs.length} item${outputs.length > 1 ? 's' : ''}`);
      if (result.elapsed !== undefined) sub.push(formatElapsed(result.elapsed));
      if (result.summary) sub.push(result.summary);
    } else if (!result.cancelled) sub.push(result.error);
    const head = h('div', { class: `result-status ${cls}` }, h('span', { class: 'icon' }, icon), h('div', { style: { flex: '1', minWidth: '0' } }, h('div', { class: 'title' }, title), sub.length ? h('div', { class: 'sub' }, sub.join(' · ')) : null));
    if (outputs.length) {
      const target = result.folder || outputs[0].path;
      head.append(h('button', { class: 'btn', onclick: () => (result.folder ? api.open(result.folder) : api.show(target)) }, '📂 Show'));
    }
    head.append(h('button', { class: 'mini', title: 'Dismiss', onclick: () => { sess.result = null; state.toolView?.refreshResult(); } }, '✕'));
    card.append(head);

    if (result.dryRun && result.ok) {
      card.append(h('div', { class: 'result-block' }, h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, h('span', { style: { flex: '1', color: 'var(--muted)' } }, 'This is a preview, nothing has been changed yet.'), h('button', { class: `btn ${tool.danger ? 'danger' : 'primary'}`, onclick: () => runTool(tool, sess, { dryRun: false }) }, `Apply · ${tool.actionLabel || 'Run'}`))));
    }
    if (errors.length) {
      card.append(h('div', { class: 'result-block' }, h('h4', {}, 'Errors'), h('ul', { class: 'errors' }, errors.slice(0, 50).map((e) => h('li', {}, e.file ? h('b', {}, `${basename(e.file)}: `) : null, e.error)))));
    }
    if (outputs.length) {
      const single = outputs.length === 1 && outputs[0].image;
      const block = h('div', { class: 'result-block' }, h('h4', {}, 'Output', h('span', { class: 'right' }, outputs.length > 1 ? h('button', { class: 'mini', onclick: () => api.show(outputs[0].path) }, 'Open folder') : null)));
      if (single) block.append(h('img', { class: 'preview-image', src: `${outputs[0].url}?v=${Math.round(outputs[0].mtime || 0)}`, style: { marginBottom: '10px' } }));
      block.append(h('ul', { class: 'file-list' }, outputs.slice(0, 300).map((o) => fileRow(o, [h('button', { class: 'mini', onclick: () => api.open(o.path) }, 'Open'), h('button', { class: 'mini', onclick: () => api.show(o.path) }, '📂')]))));
      if (outputs.length > 300) block.append(h('div', { class: 'empty-note' }, `+ ${outputs.length - 300} more`));
      card.append(block);
    }
    if (result.notes?.length) {
      card.append(h('div', { class: 'result-block' }, h('h4', {}, 'Details'), h('ul', { class: 'notes' }, result.notes.slice(0, 200).map((n) => h('li', {}, n)))));
    }
    if (result.table) card.append(h('div', { class: 'result-block' }, h('h4', {}, result.table.title || 'Result'), renderTable(result.table)));
    for (const section of result.sections || []) {
      const block = h('div', { class: 'result-block' }, h('h4', {}, section.title || ''));
      if (section.image) block.append(h('img', { class: 'section-image', src: section.image }));
      if (section.colors) {
        block.append(h('div', { class: 'swatches' }, section.colors.map((c) => {
          const n = parseInt(c.hex.slice(1), 16);
          const light = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 150;
          return h('div', { class: 'swatch', title: `Copy ${c.hex}`, style: { background: c.hex, color: light ? '#111' : '#fff', flex: String(Math.max(0.4, c.share * 10)) }, onclick: () => copy(c.hex) }, c.hex.toUpperCase());
        })));
      }
      if (section.table) block.append(renderTable(section.table));
      if (section.text) block.append(h('pre', { class: 'output' }, section.text));
      card.append(block);
    }
    if (result.text !== null && result.text !== undefined && result.text !== '') {
      const text = String(result.text);
      const shown = text.length > 400000 ? `${text.slice(0, 400000)}\n\n… (${formatBytes(text.length)} total, use Copy or Save for everything)` : text;
      card.append(
        h(
          'div',
          { class: 'result-block' },
          h('h4', {}, result.textLabel || 'Output', h('span', { class: 'right' }, h('button', { class: 'mini', onclick: () => copy(text) }, 'Copy'), h('button', { class: 'mini', onclick: () => saveText(tool, sess, text, result.textExt) }, 'Save…'))),
          h('pre', { class: 'output' }, shown),
        ),
      );
    }
    if (!result.ok && !result.cancelled && result.error && errors.length === 0) {
      card.append(h('div', { class: 'result-block' }, h('ul', { class: 'errors' }, h('li', {}, result.error))));
    }
    return card;
  }

  function renderHistory(view) {
    view.append(
      h('div', { class: 'page-head' }, h('div', { class: 'tile large', style: { '--c1': '#5b5bd6', '--c2': '#9b5de5' } }, '🕘'), h('div', {}, h('h1', {}, 'History'), h('p', {}, 'Your last 80 runs. Files are never uploaded anywhere.')), h('div', { class: 'actions' }, state.history.length ? h('button', { class: 'btn', onclick: () => { state.history = []; store.set('history', []); render(); } }, 'Clear history') : null)),
    );
    if (!state.history.length) {
      view.append(emptyState('🕘', 'Nothing here yet', 'Every tool you run will show up here with quick links to its results.'));
      return [{ label: 'History', path: 'history' }];
    }
    view.append(
      h(
        'div',
        { class: 'history-list' },
        state.history.map((entry) => {
          const tool = state.tools.get(entry.toolId);
          if (!tool) return null;
          const cat = state.catById.get(tool.category);
          return h(
            'div',
            { class: 'history-item' },
            h('div', { class: 'tile small', style: tileStyle(cat) }, tool.icon),
            h(
              'div',
              { class: 'body' },
              h('div', { style: { display: 'flex', gap: '10px', alignItems: 'baseline' } }, h('b', {}, tool.name), h('span', { class: 'when' }, timeAgo(entry.at))),
              h('div', { class: 'when' }, `${entry.ok ? '✅' : '⚠️'} ${entry.summary}`),
              entry.outputs.length ? h('div', { class: 'outs' }, entry.outputs.slice(0, 4).map((o) => h('div', { class: 'out' }, h('span', { title: o.path }, `${o.dir ? '📁' : '📄'} ${o.name}`), h('button', { class: 'mini', onclick: () => api.open(o.path).then((err) => err && toast(err, 'error')) }, 'Open'), h('button', { class: 'mini', onclick: () => api.show(o.path) }, '📂'))), entry.count > 4 ? h('div', { class: 'when' }, `+ ${entry.count - 4} more`) : null) : null,
            ),
            h('button', { class: 'btn', onclick: () => go(`tool/${tool.id}`) }, 'Open tool'),
          );
        }),
      ),
    );
    return [{ label: 'History', path: 'history' }];
  }

  function settingToggle(label, desc, key) {
    return h('div', { class: 'setting-row' }, h('div', { class: 'text' }, h('b', {}, label), h('span', {}, desc)), h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: Boolean(state.settings[key]), onchange: (e) => { state.settings[key] = e.target.checked; saveSettings(); if (key === 'notify' && e.target.checked && 'Notification' in window) Notification.requestPermission(); } }), h('span', { class: 'track' })));
  }

  function renderSettings(view) {
    view.append(h('div', { class: 'page-head' }, h('div', { class: 'tile large', style: { '--c1': '#434343', '--c2': '#7a7a8c' } }, '⚙️'), h('div', {}, h('h1', {}, 'Settings'), h('p', {}, 'Defaults used by every tool.'))));
    const outRow = h('div', {});
    const drawOut = () => {
      outRow.replaceChildren();
      const seg = h('div', { class: 'segmented' });
      for (const [value, label] of [['source', 'Next to the original'], ['custom', 'Always this folder']]) {
        seg.append(h('button', { class: state.settings.outputMode === value ? 'on' : '', onclick: async () => {
          if (value === 'custom' && !state.settings.customDir) {
            const dirs = await api.pickFolder({});
            if (!dirs[0]) return;
            state.settings.customDir = dirs[0];
          }
          state.settings.outputMode = value;
          saveSettings();
          state.sessions.forEach((s) => { s.outMode = null; s.outDir = null; });
          drawOut();
        } }, label));
      }
      outRow.append(seg);
      if (state.settings.outputMode === 'custom') {
        outRow.append(h('div', { class: 'path-row', style: { marginTop: '8px' } }, h('div', { class: 'path', title: state.settings.customDir }, state.settings.customDir), h('button', { class: 'btn', onclick: async () => { const dirs = await api.pickFolder({}); if (dirs[0]) { state.settings.customDir = dirs[0]; saveSettings(); drawOut(); } } }, 'Change…')));
      }
    };
    drawOut();

    const ytBox = h('div', { class: 'kv' }, h('div', {}, 'Status'), h('div', {}, 'Checking…'));
    const ffBox = h('div', {}, '…');
    const ytButton = h('button', { class: 'btn', onclick: async () => {
      ytButton.disabled = true;
      ytButton.textContent = 'Working…';
      try {
        const res = await api.service('web.ytdlpUpdate');
        toast(res.message || 'yt-dlp is ready', 'success');
      } catch (error) {
        toast(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
      }
      ytButton.disabled = false;
      ytButton.textContent = 'Install / update';
      refreshYt();
    } }, 'Install / update');
    const refreshYt = async () => {
      try {
        const status = await api.service('web.ytdlpStatus');
        ytBox.replaceChildren(h('div', {}, 'Status'), h('div', {}, status.installed ? `Installed (${status.version})` : 'Not installed, downloaded automatically on first use'), h('div', {}, 'Location'), h('div', {}, status.path));
      } catch {
        ytBox.replaceChildren(h('div', {}, 'Status'), h('div', {}, 'Unavailable'));
      }
    };
    refreshYt();
    api.service('core.ffmpegVersion').then((v) => (ffBox.textContent = v)).catch(() => (ffBox.textContent = '?'));

    const v = state.boot.versions;
    view.append(
      h(
        'div',
        { class: 'settings-grid' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, '📁 Output')), h('div', { class: 'card-body' }, h('div', { class: 'setting-row', style: { display: 'block' } }, h('div', { class: 'text', style: { marginBottom: '10px' } }, h('b', {}, 'Where to save results'), h('span', {}, 'Tools without an input file use this folder, or Downloads.')), outRow), settingToggle('Show the result in the file explorer', 'Opens the folder automatically when a job finishes.', 'openFolder'))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, '✨ Interface')), h('div', { class: 'card-body' }, settingToggle('Desktop notifications', 'Notify me when a long job finishes in the background.', 'notify'), settingToggle('Background animations', 'Floating gradients and particles.', 'animations'), h('div', { class: 'setting-row' }, h('div', { class: 'text' }, h('b', {}, 'Reset remembered options'), h('span', {}, 'Every tool remembers the last options you used.')), h('button', { class: 'btn', onclick: () => { Object.keys(localStorage).filter((k) => k.startsWith('uft.opts.')).forEach((k) => localStorage.removeItem(k)); state.sessions.clear(); toast('Options reset', 'success'); } }, 'Reset')))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, '⬇️ Media downloader (yt-dlp)'), h('div', { class: 'right' }, ytButton)), h('div', { class: 'card-body' }, ytBox)),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'ℹ️ About')), h('div', { class: 'card-body' }, h('div', { class: 'kv' }, h('div', {}, 'Version'), h('div', {}, v.app), h('div', {}, 'Electron'), h('div', {}, v.electron), h('div', {}, 'Chromium'), h('div', {}, v.chrome), h('div', {}, 'Node.js'), h('div', {}, v.node), h('div', {}, 'FFmpeg'), ffBox, h('div', {}, 'Tools'), h('div', {}, String(state.tools.size))), h('div', { style: { marginTop: '14px', display: 'flex', gap: '8px' } }, h('button', { class: 'btn', onclick: () => api.external('https://github.com/GLOXIOU/ultimate-file-tool') }, '🐙 GitHub')))),
      ),
    );
    return [{ label: 'Settings', path: 'settings' }];
  }

  function hasFiles(event) {
    return [...(event.dataTransfer?.types || [])].includes('Files');
  }

  function setupDragAndDrop() {
    let depth = 0;
    const overlay = $('#drop-overlay');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      const tool = state.route.name === 'tool' ? state.tools.get(state.route.arg) : null;
      if (tool && tool.input && tool.input.kind !== 'none') {
        $('#drop-title').textContent = `Add to ${tool.name}`;
        $('#drop-sub').textContent = tool.input.kind === 'folder' ? 'Drop a folder' : acceptLabel(tool);
      } else {
        $('#drop-title').textContent = 'Drop your files';
        $('#drop-sub').textContent = "We'll show you everything you can do with them";
      }
      overlay.classList.add('show');
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.classList.remove('show');
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      const tool = state.route.name === 'tool' ? state.tools.get(state.route.arg) : null;
      if (tool && tool.input && tool.input.kind !== 'none') addPaths(tool, session(tool), paths);
      else openQuick(paths);
    });
  }

  function setupSearch() {
    const input = $('#search');
    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (!q) {
        if (state.route.name === 'search') history.back();
        return;
      }
      const target = `#/search/${encodeURIComponent(q)}`;
      if (state.route.name === 'search') location.replace(target);
      else location.hash = target;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = searchTools(input.value.trim())[0];
        if (first) {
          input.value = '';
          input.blur();
          go(`tool/${first.id}`);
        }
      }
      if (e.key === 'Escape') {
        input.value = '';
        input.blur();
        if (state.route.name === 'search') history.back();
      }
    });
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'f')) {
        e.preventDefault();
        input.focus();
        input.select();
      } else if (e.key === 'Escape' && document.activeElement === document.body && !document.querySelector('.modal-back') && state.route.name !== 'home') {
        history.back();
      }
    });
  }

  async function init() {
    state.boot = await api.bootstrap();
    document.body.classList.add(`platform-${state.boot.platform}`);
    state.categories = state.boot.categories;
    for (const cat of state.categories) {
      state.catById.set(cat.id, cat);
      for (const tool of cat.tools) state.tools.set(tool.id, tool);
    }
    saveSettings();
    api.onJobEvent(onJobEvent);
    $('#back').addEventListener('click', () => history.back());
    $('#brand').addEventListener('click', () => go(''));
    setupDragAndDrop();
    setupSearch();
    window.addEventListener('hashchange', render);
    render();
  }

  init();
})();
