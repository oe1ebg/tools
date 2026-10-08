// The official ADIF test QSOs (tests/fixtures/adif-spec/test-qsos.adi, from
// the ADIF resources archive via scripts/build_adif_spec.py): every field and
// enumeration value of the spec, one QSO each. The validator must find no
// issue, and the ADIF editor's export (parse → serializeADIF) must keep every
// value and stay free of errors. Checked once for the whole file, and per
// group of QSOs (adif-official.mjs) so a failure names the part of the spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADIF_SPEC_VERSION } from '../tools/shared/js/adif-spec-data.js';
import { SOURCE, check, whole, USERDEFS, groups, groupText, roundTrip } from './adif-official.mjs';

const summary = r => JSON.stringify(r.issues.slice(0, 10).map(i => `${i.severity} ${i.code} QSO ${i.recordIndex} ${i.field}=${i.value}`));

// Known gaps of the editor (README, "Known gaps"): it writes no USERDEF
// header, so user-defined fields come back unknown and are exported as
// String (their line breaks become blanks), and it drops the data type
// indicator of application-defined fields. Anything else fails.
const KNOWN_EXPORT_GAPS = new Set(['warning UNKNOWN_FIELD', 'info APP_FIELD_WITHOUT_TYPE']);
const typeLost = name => USERDEFS.has(name);
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
    assertValidAndRoundTrips(groupText(idx), idx.length, name);
  });
}
