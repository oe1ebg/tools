// Netlog's two languages (tools/netlog/js/i18n.js): both dictionaries have
// the same keys and placeholders, every key the code and the page use
// exists, the first-use language follows the browser, ISO formats stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG_DE } from '../tools/netlog/js/lang-de.js';
import { LANG_EN } from '../tools/netlog/js/lang-en.js';
import { t, useLang, detectLang } from '../tools/netlog/js/i18n.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'netlog');
const placeholders = s => (typeof s === 'string' ? [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort() : []);

test('German and English have the same keys and placeholders', () => {
  assert.deepEqual(Object.keys(LANG_DE).sort(), Object.keys(LANG_EN).sort());
  for (const k of Object.keys(LANG_EN)) {
    assert.deepEqual(placeholders(LANG_DE[k]), placeholders(LANG_EN[k]), k);
    assert.ok(String(LANG_DE[k]).trim() && String(LANG_EN[k]).trim(), `${k} is not empty`);
  }
});

test('every literal key in the code and the page exists', () => {
  const missing = [];
  const known = new Set(Object.keys(LANG_EN));
  const has = k => known.has(k) || known.has(`${k}_one`);
  for (const f of readdirSync(join(DIR, 'js')).filter(f => f.endsWith('.js') && !f.startsWith('lang-'))) {
    const src = readFileSync(join(DIR, 'js', f), 'utf8');
    // t('key') and keys handed around as 'area.name' literals of known areas
    for (const m of src.matchAll(/\bt\('([\w.]+)'/g)) if (!has(m[1])) missing.push(`${f}: ${m[1]}`);
    for (const m of src.matchAll(/'((?:undo|save|keys|storage|mode|keysLine|help|lock|status|flag|note|turn|round|station|control|checkin|session|series|views|common|header|footer|roster|update|live|offline)\.[\w.]+)'/g)) if (!has(m[1])) missing.push(`${f}: ${m[1]}`);
  }
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n="([\w.]+)"/g)) if (!has(m[1])) missing.push(`index.html: ${m[1]}`);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const part of m[1].split(';')) {
      const k = part.split(':')[1]?.trim();
      if (k && !has(k)) missing.push(`index.html: ${k}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('t(): placeholders, plurals, fallback to English and the key', () => {
  useLang('de');
  assert.equal(t('roster.stats', { n: 1, active: 1 }), '1 Station · 1 aktiv');
  assert.equal(t('roster.stats', { n: 3, active: 2 }), '3 Stationen · 2 aktiv');
  assert.equal(t('no.such.key'), 'no.such.key');
  useLang('en');
  assert.equal(t('round.indicator', { n: 4 }), 'Round 4');
  assert.equal(t('views.live'), 'Live Notes');
  useLang('de');
  assert.equal(t('views.live'), 'Live-Notizen');
  useLang('en');
});

test('terminology from the specification', () => {
  assert.equal(LANG_EN['views.live'], 'Live Notes');
  assert.equal(LANG_DE['views.live'], 'Live-Notizen');
});

test('first use: German browser -> German, anything else -> English; a saved choice wins', () => {
  assert.equal(detectLang(null, ['de-AT', 'en']), 'de');
  assert.equal(detectLang(null, ['de']), 'de');
  assert.equal(detectLang(null, ['en-GB', 'de']), 'en');
  assert.equal(detectLang(null, ['fr-FR']), 'en');
  assert.equal(detectLang(null, []), 'en');
  assert.equal(detectLang('en', ['de-AT']), 'en');
  assert.equal(detectLang('de', ['en-US']), 'de');
  assert.equal(detectLang('xx', ['en-US']), 'en');
});

test('no locale-dependent date/time formatting and no visible native date/time fields', () => {
  const offenders = [];
  for (const f of readdirSync(join(DIR, 'js')).filter(f => f.endsWith('.js'))) {
    const src = readFileSync(join(DIR, 'js', f), 'utf8');
    if (/toLocale(Date|Time)?String|Intl\.DateTimeFormat/.test(src)) offenders.push(f);
  }
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');
  if (/type="(date|time|datetime-local)"/.test(html)) offenders.push('index.html');
  assert.deepEqual(offenders, []);
});
