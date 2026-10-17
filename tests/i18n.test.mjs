// German and English for the ADIF editor and the SOTA map (#108 C3):
// tools/shared/js/i18n.js and the messages built with it.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tx, uiLang, setUiLang, i18nDetect } from '../tools/shared/js/i18n.js';
import { validateAdif } from '../tools/shared/js/adif-validate.js';
import { adifLimitMessage, adifFormatCount } from '../tools/adif/js/load.js';

afterEach(() => setUiLang('en'));

test('English unless German is chosen; unknown codes are English', () => {
  assert.equal(uiLang(), 'en');
  assert.equal(tx('valid', 'gültig'), 'valid');
  setUiLang('de');
  assert.equal(tx('valid', 'gültig'), 'gültig');
  assert.equal(tx('only English'), 'only English');
  setUiLang('fr');
  assert.equal(uiLang(), 'en');
});

test('the start language: the saved choice, else the browser', () => {
  assert.equal(i18nDetect('en', ['de-AT']), 'en');
  assert.equal(i18nDetect('de', ['en-US']), 'de');
  assert.equal(i18nDetect(null, ['de-AT', 'en']), 'de');
  assert.equal(i18nDetect(null, ['de']), 'de');
  assert.equal(i18nDetect(null, ['en-GB', 'de']), 'en');
  assert.equal(i18nDetect('xx', []), 'en');
});

test('validator messages follow the language; codes do not', () => {
  const text = '<ADIF_VER:5>3.1.8<EOH><CALL:5>OE1AB<QSO_DATE:8>20261301<TIME_ON:4>1200<BAND:3>20m<MODE:3>SSB<EOR>';
  const en = validateAdif(text, { today: '' }).issues.find(i => i.code === 'INVALID_DATE');
  setUiLang('de');
  const de = validateAdif(text, { today: '' }).issues.find(i => i.code === 'INVALID_DATE');
  assert.equal(en.code, de.code);
  assert.match(en.message, /has no valid month/);
  assert.match(de.message, /hat keinen gültigen Monat/);
  assert.match(de.message, /QSO_DATE „20261301“/);
});

test('numbers and limit messages in German', () => {
  assert.equal(adifFormatCount(6202), '6,202');
  setUiLang('de');
  assert.equal(adifFormatCount(6202), '6.202');
  const m = adifLimitMessage('log.adi', { code: 'FILE', size: 30 * 1024 * 1024, limit: 25 * 1024 * 1024 });
  assert.match(m, /^log\.adi: nicht geladen, die Datei hat 30 MB, der Editor nimmt bis zu 25 MB pro Datei\. Das Log ist unverändert;/);
});
