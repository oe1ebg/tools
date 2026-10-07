// The ADIF validator (tools/shared/js/adif-validate.js): fixtures in
// tests/fixtures/adif/, the result invariants, recovery after errors,
// positions, and the exports of both tools. Assertions use the stable
// issue codes, never the wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdif } from '../tools/shared/js/adif-validate.js';
import { ADIF_SPEC_VERSION, ADIF_SPEC_FIELDS, ADIF_SPEC_ENUMS } from '../tools/shared/js/adif-spec-data.js';
import { serializeADIF } from '../tools/adif/js/export.js';
import { toADIF } from '../tools/confirm/js/export.js';
import { TEMPLATES, exampleValues } from '../tools/confirm/js/templates.js';
import { headerSnapshot } from '../tools/confirm/js/model.js';
import { readADI } from './adif-spec.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'adif');
const TODAY = '20261007';
const fixture = name => readFileSync(join(FIXTURES, name), 'utf8');
const check = (text, opts = {}) => validateAdif(text, { today: TODAY, ...opts });
const codes = r => r.issues.map(i => i.code);
const bySeverity = (r, s) => r.issues.filter(i => i.severity === s).map(i => i.code);

function assertInvariants(r, label = '') {
  assert.equal(r.valid, !r.issues.some(i => i.severity === 'error'), `${label} valid`);
  for (const [key, sev] of [['errors', 'error'], ['warnings', 'warning'], ['infos', 'info']]) {
    assert.equal(r[key], r.issues.filter(i => i.severity === sev).length, `${label} ${key}`);
  }
  for (const i of r.issues) {
    assert.ok(['error', 'warning', 'info'].includes(i.severity), `${label} severity ${i.severity}`);
    assert.match(i.code, /^[A-Z][A-Z_]+$/, label);
    assert.ok(i.message, `${label} message`);
    assert.ok(['file', 'header', 'qso'].includes(i.recordType), label);
    if (i.recordType === 'qso') assert.ok(r.records[i.recordIndex], `${label} ${i.code}: recordIndex ${i.recordIndex}`);
    if (i.offset !== undefined) assert.ok(i.line >= 1 && i.column >= 1, label);
  }
}

// Expected codes per fixture: errors and warnings exactly, infos at least.
const EXPECTED = {
  'valid-minimal.adi': { valid: true, errors: [], warnings: [] },
  'valid-repeater.adi': { valid: true, errors: [], warnings: [] },
  'invalid-length.adi': { valid: false, errors: ['FIELD_LENGTH_MISMATCH'], warnings: [] },
  'invalid-date.adi': { valid: false, errors: ['INVALID_DATE'], warnings: [] },
  'invalid-time.adi': { valid: false, errors: ['INVALID_TIME'], warnings: [] },
  'invalid-mode.adi': { valid: false, errors: ['INVALID_ENUM'], warnings: [] },
  'band-frequency-mismatch.adi': { valid: true, errors: [], warnings: ['BAND_FREQUENCY_MISMATCH'] },
  'application-fields.adi': { valid: true, errors: [], warnings: [], infos: ['APP_FIELD_WITHOUT_TYPE'] },
  'malformed-record.adi': { valid: false, errors: ['FIELD_LENGTH_MISMATCH', 'MALFORMED_FIELD', 'MALFORMED_FIELD'], warnings: ['MISSING_QSO_FIELD'] },
  'future-version.adi': { valid: true, errors: [], warnings: ['UNSUPPORTED_ADIF_VERSION'] },
  'suspicious-city.adi': { valid: true, errors: [], warnings: ['SUSPICIOUS_CITY_VALUE'] },
  'mode-submode-mismatch.adi': { valid: true, errors: [], warnings: ['MODE_SUBMODE_MISMATCH'] },
  'invalid-grid.adi': { valid: false, errors: ['INVALID_GRIDSQUARE', 'INVALID_GRIDSQUARE'], warnings: [] },
  'userdef.adi': { valid: false, errors: ['INVALID_NUMBER', 'INVALID_ENUM', 'NUMBER_OUT_OF_RANGE'], warnings: [] },
  'truncated.adi': { valid: false, errors: ['MISSING_EOR', 'TRUNCATED_FIELD'], warnings: ['MISSING_QSO_FIELD'] },
  'headerless.adi': { valid: true, errors: [], warnings: [], infos: ['NO_HEADER'] },
};

test('every fixture has an expectation', () => {
  assert.deepEqual(readdirSync(FIXTURES).filter(n => n.endsWith('.adi')).sort(), Object.keys(EXPECTED).sort());
});

for (const [name, exp] of Object.entries(EXPECTED)) {
  test(`fixture ${name}`, () => {
    const r = check(fixture(name));
    assertInvariants(r, name);
    assert.equal(r.valid, exp.valid);
    assert.deepEqual(bySeverity(r, 'error').sort(), [...exp.errors].sort());
    assert.deepEqual(bySeverity(r, 'warning').sort(), [...exp.warnings].sort());
    for (const c of exp.infos || []) assert.ok(bySeverity(r, 'info').includes(c), `${name}: info ${c}`);
  });
}

test('the issue examples map to QSO and field', () => {
  const len = check(fixture('invalid-length.adi')).issues[0];
  assert.deepEqual([len.recordType, len.recordIndex, len.field, len.value], ['qso', 0, 'CALL', 'OE1AB']);
  const bf = check(fixture('band-frequency-mismatch.adi')).issues.find(i => i.code === 'BAND_FREQUENCY_MISMATCH');
  assert.equal(bf.recordIndex, 0);
  assert.equal(bf.field, 'BAND/FREQ');
  const city = check(fixture('suspicious-city.adi')).issues.find(i => i.code === 'SUSPICIOUS_CITY_VALUE');
  assert.deepEqual([city.severity, city.field, city.value], ['warning', 'MY_CITY', 'JN88ee']);
  assert.match(city.message, /MY_GRIDSQUARE/);
});

test('validation continues after a malformed record: QSO 1 and 3 survive', () => {
  const r = check(fixture('malformed-record.adi'));
  assert.equal(r.records.length, 3);
  assert.equal(r.records[0].fields.CALL, 'OE1ABC');
  assert.equal(r.records[2].fields.CALL, 'OE3DEF');
  assert.ok(r.issues.filter(i => i.severity === 'error').every(i => i.recordIndex === 1), 'errors belong to QSO 2');
  // the too-long CALL is cut at the next tag, the scan resyncs there
  assert.equal(r.records[1].fields.CALL, 'OE1XYZ');
  assert.equal(r.records[1].fields.QSO_DATE, '20261004');
});

test('line and column are 1-based positions of the tag', () => {
  const r = check('x\n<ADIF_VER:5>3.1.7 <EOH>\n<CALL:6>OE1ABC <QSO_DATE:8>20260230 <TIME_ON:4>1200 <BAND:2>2m <MODE:2>FM <EOR>\n');
  const i = r.issues.find(x => x.code === 'INVALID_DATE');
  assert.deepEqual([i.line, i.column, i.offset], [3, 16, 41]);
  assert.equal(r.records[0].line, 3);
});

test('unrecoverable input returns a result instead of throwing', () => {
  for (const input of ['', '   \n', 'hello world', 'no tags < here', null, undefined, 42]) {
    const r = check(input);
    assertInvariants(r, String(input));
    assert.equal(r.valid, false);
    assert.deepEqual(codes(r), ['UNRECOVERABLE_PARSE_ERROR']);
  }
});

test('garbage never throws and keeps the invariants', () => {
  const pieces = ['<', '>', ':', '<CALL:3>', '<EOR>', '<EOH>', 'abc', '\n', '<MODE:2:E>', '<X:99999>', '<:1>', '<APP_:2>', 'é', ' '];
  let seed = 7;
  const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let k = 0; k < 300; k++) {
    let s = '';
    for (let j = rnd(30); j > 0; j--) s += pieces[rnd(pieces.length)];
    assertInvariants(check(s), JSON.stringify(s));
  }
});

test('structure: header, EOH, EOR, duplicates', () => {
  assert.ok(codes(check('header text\n<CALL:3>OE1 <EOR>')).includes('MISSING_EOH'));
  assert.ok(codes(check('<ADIF_VER:5>3.1.7<EOH><CALL:3>OE1<EOR>')).includes('HEADER_STARTS_WITH_TAG'));
  assert.ok(codes(check('h\n<EOH><CALL:3>OE1<CALL:3>OE2<EOR>')).includes('DUPLICATE_FIELD'));
  assert.ok(codes(check('h\n<EOH><CALL:3>OE1<EOR><EOR>')).includes('EMPTY_RECORD'));
  assert.ok(codes(check('h\n<EOH><CALL:3>OE1<EOR><EOH>')).includes('DUPLICATE_EOH'));
  assert.ok(codes(check('h\n<ADIF_VER:3>3.1<EOH><CALL:3>OE1<EOR>')).includes('INVALID_ADIF_VERSION'));
  assert.ok(codes(check('h\n<PROGRAMID:1>x<EOH><CALL:3>OE1<EOR>')).includes('MISSING_ADIF_VERSION'));
  assert.ok(codes(check('h\n<CREATED_TIMESTAMP:8>20261004<EOH><CALL:3>OE1<EOR>')).includes('INVALID_DATATYPE'));
  assert.ok(codes(check('h\n<EOH><CALL:7>OE1ABC\n<EOR>')).includes('FIELD_LENGTH_MISMATCH'), 'length includes the line break');
  assert.ok(codes(check('h\n<EOH><CALL:3:X>OE1<EOR>')).includes('INVALID_DATATYPE_INDICATOR'));
  assert.ok(codes(check('h\n<EOH><FREQ:3:D>145<EOR>')).includes('TYPE_INDICATOR_MISMATCH'));
});

test('field names: unknown, application-defined, header fields in a record', () => {
  const r = check('h\n<ADIF_VER:5>3.1.7<EOH><FOO:1>x<APP_X:1>y<APP_A_B:1:Q>z<ADIF_VER:5>3.1.7<EOR><FOO:1>x<EOR>');
  const foo = r.issues.filter(i => i.code === 'UNKNOWN_FIELD');
  assert.equal(foo.length, 1, 'reported once per field name');
  assert.equal(foo[0].severity, 'warning');
  assert.ok(codes(r).includes('INVALID_APPLICATION_FIELD'));
  assert.ok(codes(r).includes('INVALID_DATATYPE_INDICATOR'));
  assert.ok(codes(r).includes('HEADER_FIELD_IN_RECORD'));
  const app = check('h\n<ADIF_VER:5>3.1.7<EOH><APP_OE1EBG_N:3:N>abc<EOR><APP_OE1EBG_N:1:S>1<EOR>');
  assert.ok(codes(app).includes('INVALID_NUMBER'), 'typed APP fields are checked');
  assert.ok(codes(app).includes('APP_FIELD_TYPE_INCONSISTENT'));
});

test('datatypes and enumerations from the spec data', () => {
  const rec = fields => 'h\n<ADIF_VER:5>3.1.7<EOH>' + Object.entries(fields).map(([k, v]) => `<${k}:${v.length}>${v}`).join('') + '<EOR>';
  const has = (fields, code) => codes(check(rec(fields))).includes(code);
  assert.ok(has({ QSO_RANDOM: 'X' }, 'INVALID_BOOLEAN'));
  assert.ok(has({ TX_PWR: '5W' }, 'INVALID_NUMBER'));
  assert.ok(has({ CQZ: '41' }, 'NUMBER_OUT_OF_RANGE'));
  assert.ok(has({ AGE: '-1' }, 'NUMBER_OUT_OF_RANGE'));
  assert.equal(check(rec({ ANT_AZ: '370' })).issues.find(i => i.code === 'NUMBER_OUT_OF_RANGE').severity, 'info', 'import-only range');
  assert.ok(has({ QSO_DATE: '19291231' }, 'INVALID_DATE'));
  assert.ok(has({ QSO_DATE: '20240229' }, 'MISSING_QSO_FIELD') && !has({ QSO_DATE: '20240229' }, 'INVALID_DATE'), 'leap day');
  assert.ok(has({ QSO_DATE: '20271231' }, 'DATE_IN_FUTURE'));
  assert.ok(has({ TIME_ON: '12345' }, 'INVALID_TIME'));
  assert.ok(has({ BAND: '11m' }, 'INVALID_ENUM'));
  assert.ok(!has({ BAND: '70CM' }, 'INVALID_ENUM'), 'enumerations are case-insensitive');
  assert.ok(has({ PROP_MODE: 'REPEATER' }, 'INVALID_ENUM'));
  assert.ok(has({ MODE: 'C4FM' }, 'IMPORT_ONLY_VALUE'));
  assert.ok(has({ CONTEST_ID: 'MY-OWN-CONTEST' }, 'NONSTANDARD_ENUM_VALUE'));
  assert.ok(has({ DXCC: '206', STATE: 'XX' }, 'INVALID_ENUM'), 'STATE depends on DXCC');
  assert.ok(!has({ DXCC: '206', STATE: 'WC' }, 'INVALID_ENUM'));
  assert.ok(has({ LAT: 'N48 12.345' }, 'INVALID_LOCATION'));
  assert.ok(has({ LAT: 'E048 12.345', LON: 'E016 22.000' }, 'INVALID_LOCATION'));
  assert.ok(has({ LAT: 'N048 12.345' }, 'INCOMPLETE_LOCATION'));
  assert.ok(has({ SOTA_REF: 'OE-WI-001' }, 'INVALID_DATATYPE'));
  assert.ok(!has({ SOTA_REF: 'OE/WI-001', MY_POTA_REF: 'OE-0001,OE-0002', WWFF_REF: 'OEFF-0001', IOTA: 'EU-005' }, 'INVALID_DATATYPE'));
  assert.ok(has({ CREDIT_SUBMITTED: 'DXCC:CARD&FAX' }, 'INVALID_ENUM'));
  assert.ok(!has({ CREDIT_SUBMITTED: 'DXCC:CARD&LOTW,IOTA' }, 'INVALID_ENUM'));
  assert.ok(has({ COMMENT: 'Grüße' }, 'INVALID_CHARACTER'));
  assert.ok(has({ COMMENT: 'a\r\nb' }, 'INVALID_CHARACTER'));
  assert.ok(!has({ NOTES: 'a\r\nb' }, 'INVALID_CHARACTER'), 'MultilineString may break lines');
  assert.ok(has({ NAME_INTL: 'Jörg' }, 'INTL_FIELD_IN_ADI'));
  assert.ok(has({ GRIDSQUARE: 'JN88', GRIDSQUARE_EXT: 'ab' }, 'GRIDSQUARE_EXT_MISMATCH'));
  assert.ok(!has({ GRIDSQUARE: 'JN88ee12', GRIDSQUARE_EXT: 'ab' }, 'GRIDSQUARE_EXT_MISMATCH'));
  assert.ok(has({ VUCC_GRIDS: 'JN88,JN8' }, 'INVALID_GRIDSQUARE'));
  assert.ok(has({ FREQ_RX: '438.475', BAND_RX: '2m' }, 'BAND_FREQUENCY_MISMATCH'));
  assert.ok(has({ FREQ: '27.205' }, 'FREQUENCY_OUTSIDE_BANDS'));
  assert.ok(has({ SUBMODE: 'USB' }, 'MODE_SUBMODE_MISMATCH'), 'SUBMODE without MODE');
  assert.ok(has({ QTH: 'JN88df' }, 'SUSPICIOUS_CITY_VALUE'));
  assert.ok(!has({ QTH: 'Wien' }, 'SUSPICIOUS_CITY_VALUE'));
});

test('the spec version is explicit and the data comes from the spec export', () => {
  assert.equal(ADIF_SPEC_VERSION, '3.1.7');
  assert.equal(check(fixture('valid-minimal.adi')).specVersion, '3.1.7');
  assert.ok(Object.keys(ADIF_SPEC_FIELDS).length > 180);
  assert.deepEqual(ADIF_SPEC_ENUMS.Band.ranges['70cm'], [420, 450]);
  assert.ok(ADIF_SPEC_ENUMS.Submode.byScope.DIGITALVOICE.includes('C4FM'));
});

test('cross-check: the ADIF editor export validates without errors', () => {
  const records = [
    { CALL: 'OE1ABC', QSO_DATE: '20261004', TIME_ON: '1902', BAND: '70cm', FREQ: '430.875', MODE: 'FM', COMMENT: 'Grüße <3' },
    { CALL: 'DL1XYZ', QSO_DATE: '20261003', TIME_ON: '090000', BAND: '20m', MODE: 'SSB', SUBMODE: 'USB', MY_SOTA_REF: 'OE/WI-001' },
  ];
  const adi = serializeADIF(records, ['CALL', 'QSO_DATE', 'TIME_ON', 'BAND', 'FREQ', 'MODE', 'SUBMODE', 'COMMENT', 'MY_SOTA_REF'], '2026-10-06T12:00:00Z');
  const r = check(adi);
  assertInvariants(r);
  assert.equal(r.errors, 0, JSON.stringify(r.issues));
  assert.equal(r.warnings, 0, JSON.stringify(r.issues));
  readADI(adi); // and the independent strict reader agrees
});

test('cross-check: every confirmation-log template exports without errors or warnings', () => {
  const header = {
    operator: 'OE1EBG', station: 'OE1XKS', freq: '145,500', mode: 'FM', myGrid: 'jn88ef12ab', myQth: 'Wien Döbling',
    viaRepeater: false, repeaterCall: 'OE1XUU', repeaterFreq: '438,950', repeaterShift: '-7,6', repeaterTone: '88.5',
  };
  const loc = { lat: 48.2, lon: 16.37, maidenhead: 'JN88ee12', label: 'Straße <½>', confidence: 'high', input: 'x', origin: 'search' };
  for (const tpl of TEMPLATES) {
    const base = { fields: exampleValues(tpl), note: 'Notiz\nmit <Zeilenumbruch>' };
    const entries = [
      { id: 'a', seq: 1, call: 'oe1aaa', ts: '2026-10-04T23:59:59.999Z', viaRepeater: true, snap: headerSnapshot(header), ...base, loc },
      { id: 'b', seq: 2, call: 'OE3XYZ/P', ts: '2026-10-05T00:00:00Z', viaRepeater: false, snap: headerSnapshot(header), ...base },
    ];
    const r = check(toADIF({ id: tpl.key, title: 'T <x>', template: tpl.key, header }, entries, '2026-10-06T12:34:56.789Z'));
    assertInvariants(r, tpl.key);
    assert.equal(r.errors, 0, `${tpl.key}: ${JSON.stringify(r.issues.filter(i => i.severity === 'error'))}`);
    assert.equal(r.warnings, 0, `${tpl.key}: ${JSON.stringify(r.issues.filter(i => i.severity === 'warning'))}`);
  }
});

// Differential test against ADIF Multitool (github.com/flwyd/adif-multitool),
// only where `adifmt` is installed (not in CI). adifmt exits 1 when it finds
// errors; this validator should agree on "has errors" except where the
// README documents a deliberate difference.
const ADIFMT_DIFFERS = {
  // adifmt reads the declared 5 characters and ignores the rest silently
  'invalid-length.adi': { adifmtErrors: false },
};
const adifmt = spawnSync('adifmt', ['version'], { encoding: 'utf8' });
test('differential: adifmt validate agrees on which fixtures have errors', { skip: adifmt.error || adifmt.status !== 0 ? 'adifmt not on PATH' : false }, () => {
  for (const name of Object.keys(EXPECTED)) {
    const res = spawnSync('adifmt', ['validate', join(FIXTURES, name)], { encoding: 'utf8' });
    const theirs = res.status !== 0;
    const ours = check(fixture(name)).errors > 0;
    const expectedTheirs = ADIFMT_DIFFERS[name]?.adifmtErrors ?? ours;
    assert.equal(theirs, expectedTheirs, `${name}: adifmt exit ${res.status}: ${res.stderr}`);
  }
});
