// Netlog's two UI languages (de, en): translation keys, bundled
// dictionaries, the user's choice in a pref. Users' text (notes,
// callsigns, names) is never translated. Pure except applyI18n().
//
// t(key, vars): the text in the current language. Placeholders are
// `{name}`; a key with `_one`/`_other` variants picks by vars.n. A key
// missing in a language falls back to English, then to the key itself
// (the node tests check both dictionaries have the same keys).

import { LANG_DE } from './lang-de.js';
import { LANG_EN } from './lang-en.js';
import { prefGet, prefSet } from '../../shared/js/prefs.js';

export const LANGS = { de: LANG_DE, en: LANG_EN };
export const LANG_PREF = 'oe1ebg-netlog-lang';

let current = 'en';

// The language to start with: the saved choice, else German when the
// browser's first language is German, else English.
export function detectLang(saved, languages) {
  if (saved === 'de' || saved === 'en') return saved;
  const first = String((languages && languages[0]) || '').toLowerCase();
  return first === 'de' || first.startsWith('de-') ? 'de' : 'en';
}

export function initLang() {
  const nav = globalThis.navigator;
  current = detectLang(prefGet(LANG_PREF), nav ? (nav.languages && nav.languages.length ? nav.languages : [nav.language]) : []);
  return current;
}

export function lang() {
  return current;
}

export function setLang(code) {
  if (!LANGS[code]) return current;
  current = code;
  prefSet(LANG_PREF, code);
  return current;
}

// Only for the node tests.
export function useLang(code) {
  if (LANGS[code]) current = code;
}

function lookup(key) {
  const d = LANGS[current];
  if (Object.prototype.hasOwnProperty.call(d, key)) return d[key];
  if (Object.prototype.hasOwnProperty.call(LANG_EN, key)) return LANG_EN[key];
  return null;
}

export function t(key, vars) {
  let s = null;
  if (vars && typeof vars.n === 'number') s = lookup(`${key}_${vars.n === 1 ? 'one' : 'other'}`);
  if (s === null) s = lookup(key);
  if (s === null) return key;
  if (typeof s === 'function') return s(vars || {});
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Static page text: data-i18n="key" sets textContent, data-i18n-attr=
// "aria-label:key; title:key2" sets attributes.
export function applyI18n(root) {
  document.documentElement.lang = current;
  for (const n of root.querySelectorAll('[data-i18n]')) {
    const s = t(n.dataset.i18n);
    if (n.textContent !== s) n.textContent = s;
  }
  for (const n of root.querySelectorAll('[data-i18n-attr]')) {
    for (const part of n.dataset.i18nAttr.split(';')) {
      const [attr, key] = part.split(':').map(x => x.trim());
      if (attr && key) n.setAttribute(attr, t(key));
    }
  }
}
