// The official ADIF test QSOs (tests/fixtures/adif-spec/test-qsos.adi, from
// the ADIF resources archive via scripts/build_adif_spec.py): every field and
// enumeration value of the spec, one QSO each. The validator must find no
// issue, and the ADIF editor's export (parse → serializeADIF) must keep every
// value and stay free of errors. Checked once for the whole file, and per
// group of QSOs so a failure names the part of the spec it is in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdif } from '../tools/shared/js/adif-validate.js';
import { ADIF_SPEC_VERSION } from '../tools/shared/js/adif-spec-data.js';
import { parseADIF } from '../tools/shared/js/adif.js';
import { serializeADIF } from '../tools/adif/js/export.js';

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'adif-spec', 'test-qsos.adi'), 'utf8');
// The QSOs are dated around the archive's release; no DATE_IN_FUTURE.
const TODAY = '20991231';
const check = text => validateAdif(text, { today: TODAY });
const summary = r => JSON.stringify(r.issues.slice(0, 10).map(i => `${i.severity} ${i.code} QSO ${i.recordIndex} ${i.field}=${i.value}`));

const whole = check(SOURCE);
const HEADER = SOURCE.slice(0, whole.records[0].offset);
const USERDEFS = new Set(Object.entries(whole.header.fields)
  .filter(([k]) => /^USERDEF\d+$/.test(k)).map(([, v]) => v.split(',')[0].toUpperCase()));

// Groups in order of precedence: a QSO belongs to the first that matches.
// The generator puts the subdivisions and DXCC entities into thousands of
// QSOs, the scalar fields into a handful each.
const GROUPS = [
  ['user-defined fields', n => USERDEFS.has(n)],
  ['application-defined fields', n => n.startsWith('APP_')],
  ['primary subdivisions (STATE, MY_STATE)', n => n === 'STATE' || n === 'MY_STATE'],
  ['secondary subdivisions (CNTY, MY_CNTY, *_ALT)', n => /^(MY_)?CNTY(_ALT)?$/.test(n)],
  ['DXCC entities (DXCC, MY_DXCC)', n => n === 'DXCC' || n === 'MY_DXCC'],
  ['contests, credits, awards', n => /^(CONTEST_ID|CREDIT_|AWARD_)/.test(n)],
  ['QSL and upload status', n => /QSL|_QSO_(UP|DOWN)LOAD_/.test(n)],
  ['bands, frequencies, modes', n => /^(BAND|FREQ)_RX$|^SUBMODE$/.test(n)],
];
const QSO_FIELDS = new Set(['QSO_DATE', 'TIME_ON', 'TIME_OFF', 'CALL', 'BAND', 'FREQ', 'MODE']);
function groupOf(fields) {
  const names = Object.keys(fields);
  for (const [name, match] of GROUPS) if (names.some(match)) return name;
  // only the fields every QSO has: the BAND, FREQ and MODE enumerations
  return names.every(n => QSO_FIELDS.has(n)) ? 'bands, frequencies, modes' : 'other fields';
}

// Source text per QSO, up to the next one (the generator's "====" comments
// between QSOs come along; text outside tags is ignored).
const recordText = i => SOURCE.slice(whole.records[i].offset, whole.records[i + 1]?.offset ?? SOURCE.length);
const groups = new Map([...GROUPS.map(([name]) => name), 'other fields'].map(name => [name, []]));
whole.records.forEach((r, i) => groups.get(groupOf(r.fields)).push(i));

// The ADIF editor's round trip: load, export every column, as the editor does.
function roundTrip(text) {
  const records = parseADIF(text, [], 'test-qsos.adi');
  const columns = [...new Set(records.flatMap(r => Object.keys(r)))];
  return { records, adi: serializeADIF(records, columns, '2026-10-08T00:00:00Z') };
}

// Known gaps of the editor (README, "Known gaps"): it writes no USERDEF
// header, so user-defined fields come back unknown, and it drops the data
// type indicator of application-defined fields. Both are then exported as
// String, so their line breaks become blanks. Anything else fails.
const KNOWN_EXPORT_GAPS = new Set(['warning UNKNOWN_FIELD', 'info APP_FIELD_WITHOUT_TYPE']);
const typeLost = name => USERDEFS.has(name) || name.startsWith('APP_');
const asExported = fields => Object.fromEntries(Object.entries(fields)
  .map(([k, v]) => [k, typeLost(k) ? v.replace(/[\r\n\t]+/g, ' ').trim() : v]));

function assertValidAndRoundTrips(text, count, label) {
  const r = check(text);
  assert.equal(r.records.length, count, `${label}: QSOs read`);
  assert.equal(r.issues.length, 0, `${label}: ${r.issues.length} issues ${summary(r)}`);

  const { records, adi } = roundTrip(text);
  assert.equal(records.length, count, `${label}: QSOs read by the editor`);
  const back = check(adi);
  assert.equal(back.records.length, count, `${label}: QSOs exported`);
  const unexpected = back.issues.filter(i => !KNOWN_EXPORT_GAPS.has(`${i.severity} ${i.code}`));
  assert.equal(unexpected.length, 0, `${label}: export ${summary({ issues: unexpected })}`);
  back.records.forEach((b, i) => {
    assert.deepEqual(b.fields, asExported(r.records[i].fields), `${label}: export changed QSO ${i} (line ${r.records[i].line})`);
  });
}

test(`official ADIF ${ADIF_SPEC_VERSION} test QSOs: the file matches the spec version`, () => {
  assert.equal(whole.header.fields.ADIF_VER, ADIF_SPEC_VERSION, 'rerun `just oe1ebg build-adif-spec`');
  assert.equal(whole.records.length, (SOURCE.match(/<eor>/gi) || []).length);
});

test('official ADIF test QSOs: the groups split the whole file', () => {
  const counts = Object.fromEntries([...groups].map(([name, idx]) => [name, idx.length]));
  for (const [name, n] of Object.entries(counts)) assert.ok(n > 0, `group "${name}" is empty: ${JSON.stringify(counts)}`);
  const all = [...groups.values()].flat().sort((a, b) => a - b);
  assert.deepEqual(all, whole.records.map((_, i) => i), 'every QSO in exactly one group');
});

test(`official ADIF test QSOs: whole file (${whole.records.length} QSOs)`, () => {
  assertValidAndRoundTrips(SOURCE, whole.records.length, 'whole file');
});

for (const [name, idx] of groups) {
  test(`official ADIF test QSOs: ${name} (${idx.length} QSOs)`, () => {
    assertValidAndRoundTrips(HEADER + idx.map(recordText).join(''), idx.length, name);
  });
}
