// German and English for the ADIF editor and the SOTA Alerts Map (#108 C3).
// Both texts sit where they are used: tx('ADIF valid', 'ADIF gültig'), with
// template literals for values. Without a choice (and in Node, where the
// tests run) the language is English. Netlog has its own keyed
// dictionaries (tools/netlog/js/i18n.js).
//
// Static page text: an element with data-de="…" shows that text in German
// and its own text in English (keep such elements free of child elements);
// data-de-title, data-de-aria-label and data-de-placeholder do the same for
// those attributes. Longer text with markup (help): one element per language,
// data-lang-only="en" / "de", the other one hidden. i18nApply() switches
// them all; the English originals are kept in data-en*.

import { prefGet, prefSet } from './prefs.js';

let i18nCurrent = 'en';

export function uiLang() {
  return i18nCurrent;
}

export function setUiLang(code) {
  i18nCurrent = code === 'de' ? 'de' : 'en';
  return i18nCurrent;
}

// The text in the page's language.
export function tx(en, de) {
  return i18nCurrent === 'de' && de !== undefined && de !== null ? de : en;
}

// The language to start with: the saved choice, else German when the
// browser's first language is German, else English.
export function i18nDetect(saved, languages) {
  if (saved === 'de' || saved === 'en') return saved;
  const first = String((languages && languages[0]) || '').toLowerCase();
  return first === 'de' || first.startsWith('de-') ? 'de' : 'en';
}

// The page's language from the saved choice (pref) or the browser.
export function i18nInit(pref) {
  const nav = globalThis.navigator;
  const langs = nav ? (nav.languages && nav.languages.length ? nav.languages : [nav.language]) : [];
  return setUiLang(i18nDetect(prefGet(pref), langs));
}

export function i18nChoose(pref, code) {
  setUiLang(code);
  prefSet(pref, i18nCurrent);
  return i18nCurrent;
}

const I18N_ATTRS = ['title', 'aria-label', 'placeholder'];

export function i18nApply(root = document) {
  document.documentElement.lang = i18nCurrent;
  for (const n of root.querySelectorAll('[data-de]')) {
    if (n.dataset.en === undefined) n.dataset.en = n.textContent;
    const s = i18nCurrent === 'de' ? n.dataset.de : n.dataset.en;
    if (n.textContent !== s) n.textContent = s;
  }
  for (const n of root.querySelectorAll('[data-lang-only]')) n.hidden = n.dataset.langOnly !== i18nCurrent;
  for (const attr of I18N_ATTRS) {
    const key = `de-${attr}`;
    for (const n of root.querySelectorAll(`[data-${key}]`)) {
      const enKey = `data-en-${attr}`;
      if (!n.hasAttribute(enKey)) n.setAttribute(enKey, n.getAttribute(attr) || '');
      n.setAttribute(attr, i18nCurrent === 'de' ? n.getAttribute(`data-${key}`) : n.getAttribute(enKey));
    }
  }
}

// The DE/EN switch (#lang-toggle, buttons with data-lang): marks the
// current language; a click saves the choice and calls onChange(code).
export function i18nToggle(pref, onChange) {
  const box = document.getElementById('lang-toggle');
  if (!box) return;
  const mark = () => { for (const b of box.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.lang === i18nCurrent)); };
  mark();
  box.addEventListener('click', e => {
    const code = e.target.closest('button')?.dataset.lang;
    if (!code || code === i18nCurrent) return;
    i18nChoose(pref, code);
    mark();
    onChange(i18nCurrent);
  });
}
