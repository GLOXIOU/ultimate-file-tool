function normalizeChoices(choices) {
  return choices.map((c) => {
    if (Array.isArray(c)) return { value: c[0], label: c[1] };
    if (typeof c === 'object') return c;
    return { value: c, label: String(c).toUpperCase() };
  });
}

const select = (id, label, choices, def, extra = {}) => ({
  id,
  label,
  type: 'select',
  choices: normalizeChoices(choices),
  default: def === undefined ? normalizeChoices(choices)[0].value : def,
  ...extra,
});

const range = (id, label, min, max, def, extra = {}) => ({ id, label, type: 'range', min, max, step: 1, default: def, ...extra });
const number = (id, label, def, extra = {}) => ({ id, label, type: 'number', default: def, ...extra });
const text = (id, label, def = '', extra = {}) => ({ id, label, type: 'text', default: def, ...extra });
const textarea = (id, label, def = '', extra = {}) => ({ id, label, type: 'textarea', default: def, ...extra });
const checkbox = (id, label, def = false, extra = {}) => ({ id, label, type: 'checkbox', default: def, ...extra });
const color = (id, label, def = '#ffffff', extra = {}) => ({ id, label, type: 'color', default: def, ...extra });
const password = (id, label, extra = {}) => ({ id, label, type: 'password', default: '', ...extra });
const file = (id, label, accept, extra = {}) => ({ id, label, type: 'file', accept, default: '', ...extra });
const datetime = (id, label, extra = {}) => ({ id, label, type: 'datetime', default: '', ...extra });
const multi = (id, label, choices, def = [], extra = {}) => ({
  id,
  label,
  type: 'multi',
  choices: normalizeChoices(choices),
  default: def,
  ...extra,
});

const when = (key, values) => ({ showIf: { [key]: [].concat(values) } });

module.exports = { select, range, number, text, textarea, checkbox, color, password, file, datetime, multi, when };
