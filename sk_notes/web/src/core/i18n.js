// UI strings come from sk_notes/locales/<lang>.json (merged with English by Python).
// Never write user-visible text directly in the code: always go through t() with a key.

let strings = {};
let language = 'en';

export function setStrings(lang, dict) {
  language = lang || 'en';
  strings = dict || {};
  document.documentElement.lang = language;
}

export function getLanguage() {
  return language;
}

export function t(key, vars) {
  let s = strings[key];
  if (s === undefined) {
    if (window.__sknDev) console.warn('missing string', key);
    s = key;
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}

/** Plural helper: keys "<key>.one" and "<key>.other" (count in {n}). */
export function tn(key, n, vars = {}) {
  const rule = new Intl.PluralRules(language).select(n);
  const k = strings[`${key}.${rule}`] !== undefined ? `${key}.${rule}` : `${key}.other`;
  return t(k, { n: n.toLocaleString(language), ...vars });
}
