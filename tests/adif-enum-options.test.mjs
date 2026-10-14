// The ADIF editor's dropdowns and suggestions (tools/adif/js/enum-options.js):
// which cells get a select (strict Enumeration fields, USERDEF E with
// values, STATE/CNTY when the DXCC has a list) or suggestions (String
// fields that recommend an enumeration), what the lists offer, and that a
// stored value is never changed by showing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eoColumnKind, eoNormKey, eoOptionList, eoScopedKey, eoScopeCtx, eoCurrent, eoCellOptions, eoSuggestions, eoDependents } from '../tools/adif/js/enum-options.js';
import { ADIF_SPEC_FIELDS, ADIF_SPEC_ENUMS } from '../tools/shared/js/adif-spec-data.js';
import { validateAdif } from '../tools/shared/js/adif-validate.js';
import { serializeADIF, emptyFieldDefs } from '../tools/adif/js/export.js';

const defs = () => ({
  ...emptyFieldDefs(),
  userdefs: [
    { name: 'MY_E', type: 'E', spec: 'MY_E,{Alpha,Beta}' },
    { name: 'MY_S', type: 'S', spec: 'MY_S,{A,B}' },
    { name: 'MY_N', type: 'N', spec: 'MY_N,{1:5}' },
    { name: 'MY_E0', type: 'E', spec: 'MY_E0' },
    { name: 'BAND', type: 'E', spec: 'BAND,{X,Y}' }, // an ADIF field: the spec wins
  ],
});

const SELECT_FIELDS = Object.entries(ADIF_SPEC_FIELDS)
  .filter(([, d]) => !d.header && d.type === 'Enumeration' && d.enum && !d.enumScope && ADIF_SPEC_ENUMS[d.enum])
  .map(([n]) => n);

test('eoColumnKind: every kind of field', () => {
  const d = defs();
  for (const f of ['BAND', 'BAND_RX', 'MODE', 'DXCC', 'MY_DXCC', 'QSL_RCVD', 'QSL_SENT_VIA', 'LOTW_QSL_SENT', 'EQSL_QSL_RCVD', 'DCL_QSL_RCVD',
    'CLUBLOG_QSO_UPLOAD_STATUS', 'QRZCOM_QSO_DOWNLOAD_STATUS', 'PROP_MODE', 'ANT_PATH', 'ARRL_SECT', 'MY_ARRL_SECT', 'CONT', 'EQSL_AG',
    'QSO_COMPLETE', 'REGION', 'MORSE_KEY_TYPE', 'MY_MORSE_KEY_TYPE']) {
    assert.equal(eoColumnKind(f, d)?.kind, 'select', f);
    assert.ok(SELECT_FIELDS.includes(f), f);
  }
  for (const f of ['STATE', 'MY_STATE', 'CNTY', 'MY_CNTY']) assert.equal(eoColumnKind(f, d).kind, 'scoped', f);
  assert.equal(eoColumnKind('STATE', d).scope, 'DXCC');
  assert.equal(eoColumnKind('MY_CNTY', d).scope, 'MY_DXCC');
  assert.deepEqual(eoColumnKind('CONTEST_ID', d), { kind: 'suggest', enumName: 'Contest_ID', scope: null });
  assert.deepEqual(eoColumnKind('SUBMODE', d), { kind: 'suggest', enumName: 'Submode', scope: 'MODE' });
  for (const f of ['MY_COUNTRY', 'MY_COUNTRY_INTL', 'DARC_DOK', 'CREDIT_SUBMITTED', 'AWARD_SUBMITTED', 'CNTY_ALT', 'CALL', 'COMMENT',
    'APP_X_Y', 'ADIF_VER', 'UNKNOWN_FIELD']) {
    assert.equal(eoColumnKind(f, d), null, f);
  }
  // USERDEF: type E with values only
  assert.deepEqual(eoColumnKind('MY_E', d), { kind: 'select', key: 'userdef:MY_E,{Alpha,Beta}' });
  assert.equal(eoColumnKind('MY_S', d), null);
  assert.equal(eoColumnKind('MY_N', d), null);
  assert.equal(eoColumnKind('MY_E0', d), null);
  assert.deepEqual(eoColumnKind('BAND', d), { kind: 'select', key: 'Band' });
  assert.equal(eoColumnKind('MY_E', emptyFieldDefs()), null);
});

test('option lists: import-only values not offered, REGION KO once, DXCC labels', () => {
  const values = key => eoOptionList(key).options.map(o => o.value);
  assert.ok(!values('Mode').includes('PSK31'));
  assert.ok(values('Mode').includes('PSK'));
  assert.ok(!values('QSL_Rcvd').includes('V'));
  assert.deepEqual(values('QSL_Rcvd'), ['Y', 'N', 'R', 'I']);
  assert.ok(!values('QSL_Via').includes('M'));
  assert.equal(values('Region').filter(v => v === 'KO').length, 1);
  assert.deepEqual(values('Region'), ['NONE', 'IV', 'AI', 'SY', 'BI', 'SI', 'KO', 'ET']);
  const dxcc = eoOptionList('DXCC_Entity_Code').options;
  assert.equal(dxcc.find(o => o.value === '291').label, '291 – UNITED STATES OF AMERICA');
  assert.match(dxcc.find(o => o.value === '2').label, /^2 – .+ \(deleted\)$/);
  assert.equal(values('userdef:MY_E,{Alpha,Beta}').join(), 'Alpha,Beta');
});

test('eoNormKey compares like the validator', () => {
  assert.equal(eoNormKey('DXCC_Entity_Code', '001'), '1');
  assert.equal(eoNormKey('DXCC_Entity_Code', '1a'), '1A');
  assert.equal(eoNormKey('Band', '20m'), '20M');
});

// The stored value is always the selected option's value, exactly once.
test('invariant: every select field keeps every stored value as it is', () => {
  const d = defs();
  const raws = ['', '20M', 'ssb', 'PSK31', 'V', 'zz', '001', 'KO', '20m', '291', ' 40m', 'Alpha', 'alpha'];
  for (const f of [...SELECT_FIELDS, 'MY_E']) {
    const { key } = eoColumnKind(f, d);
    for (const raw of raws) {
      const opts = eoCellOptions(key, raw, null);
      assert.deepEqual(opts[0], { value: '', label: '' }, `${f} ${raw}`);
      assert.equal(opts.filter(o => o.value === raw).length, 1, `${f} "${raw}": one option holds it`);
      assert.equal(eoCurrent(key, raw, null).value, raw);
      const keys = opts.slice(1).map(o => eoNormKey(eoOptionList(key).enumName, o.value));
      assert.equal(new Set(keys).size, keys.length, `${f} "${raw}": no duplicate options`);
    }
  }
});

test('stored values that are not offered: their own spelling, marked', () => {
  const label = (key, raw, ctx) => eoCellOptions(key, raw, ctx).find(o => o.value === raw).label;
  assert.equal(label('Band', '20M'), '20M');
  assert.equal(eoCellOptions('Band', '20M').filter(o => o.value.toUpperCase() === '20M').length, 1); // replaces 20m
  assert.equal(label('Mode', 'PSK31'), 'PSK31 (import-only)');
  assert.equal(label('QSL_Rcvd', 'v'), 'v (import-only)');
  assert.equal(label('QSL_Via', 'M'), 'M (import-only)');
  assert.equal(label('Band', 'zz'), 'zz (not in ADIF 3.1.8)');
  assert.equal(label('DXCC_Entity_Code', '001'), '001 – CANADA');
  assert.equal(label('Region', 'KO'), 'KO');
  assert.equal(label('userdef:MY_E,{Alpha,Beta}', 'Gamma'), 'Gamma (not declared in USERDEF)');
  assert.equal(label('userdef:MY_E,{Alpha,Beta}', 'ALPHA'), 'ALPHA');
  // an unlisted value comes right after the empty option
  assert.equal(eoCellOptions('Band', 'zz')[1].value, 'zz');
});

test('scoped lists: STATE/CNTY by the row\'s DXCC', () => {
  const state = eoColumnKind('STATE', emptyFieldDefs());
  const myState = eoColumnKind('MY_STATE', emptyFieldDefs());
  assert.equal(eoScopedKey(state, { DXCC: '291' }), 'Primary_Administrative_Subdivision@291');
  assert.equal(eoScopedKey(state, { DXCC: '0291' }), 'Primary_Administrative_Subdivision@291');
  assert.equal(eoScopedKey(myState, { MY_DXCC: '1', DXCC: '291' }), 'Primary_Administrative_Subdivision@1');
  assert.equal(eoScopedKey(state, { DXCC: '230' }), 'Primary_Administrative_Subdivision@230');
  assert.equal(eoScopedKey(state, { DXCC: '206' }), 'Primary_Administrative_Subdivision@206');
  assert.equal(eoScopedKey(state, { DXCC: '9999' }), null);
  assert.equal(eoScopedKey(state, { DXCC: '3' }), null); // AFGHANISTAN: no list
  assert.equal(eoScopedKey(state, {}), null);
  assert.equal(eoScopedKey(state, { DXCC: '' }), null);
  const key = eoScopedKey(state, { DXCC: '291' });
  assert.ok(eoOptionList(key).options.some(o => o.value === 'CA'));
  const ctx = eoScopeCtx(state, { DXCC: '0291' });
  assert.deepEqual(ctx, { scopeField: 'DXCC', scopeValue: '0291' });
  assert.equal(eoCurrent(key, 'ZZ', ctx).label, 'ZZ (not listed for DXCC=0291)');
  assert.equal(eoCurrent(key, 'ca', ctx).label, 'ca');
  // the spec's import-only list of these values doesn't say for which
  // entity it holds: nothing is marked import-only in a scoped list
  const mexico = eoScopedKey(state, { DXCC: '50' });
  assert.ok(eoOptionList(mexico).importOnly.size === 0);
  assert.ok(eoOptionList(eoScopedKey(state, { DXCC: '1' })).options.some(o => o.value === 'BC'));
  const cnty = eoColumnKind('CNTY', emptyFieldDefs());
  assert.ok(eoScopedKey(cnty, { DXCC: '6' }));
  assert.equal(eoScopedKey(cnty, { DXCC: '291' }), null); // no county list for 291 in the spec data
});

test('suggestions: SUBMODE by MODE, CONTEST_ID filter, limit and total', () => {
  const sub = eoColumnKind('SUBMODE', emptyFieldDefs());
  assert.deepEqual(eoSuggestions(sub, { MODE: 'ssb' }, ''), { items: ['LSB', 'USB'], total: 2 });
  assert.deepEqual(eoSuggestions(sub, { MODE: 'SSB' }, 'u'), { items: ['USB'], total: 1 });
  const all = eoSuggestions(sub, {}, '', 1000);
  assert.ok(all.total > 50);
  assert.equal(new Set(all.items.map(v => v.toUpperCase())).size, all.items.length, 'no duplicates');
  assert.equal(eoSuggestions(sub, { MODE: 'NOSUCH' }, '', 1000).total, all.total); // unknown MODE: all submodes
  const contest = eoColumnKind('CONTEST_ID', emptyFieldDefs());
  assert.deepEqual(eoSuggestions(contest, {}, 'arrl-1'), { items: ['ARRL-10', 'ARRL-10-GHZ', 'ARRL-160'], total: 3 });
  const r = eoSuggestions(contest, {}, 'ARRL', 5);
  assert.equal(r.items.length, 5);
  assert.ok(r.total > 5);
  assert.ok(r.items.every(v => v.startsWith('ARRL')));
  // starts-with first, then contains
  const cw = eoSuggestions(contest, {}, 'cw', 1000).items;
  const firstContains = cw.findIndex(v => !v.toUpperCase().startsWith('CW'));
  assert.ok(firstContains > 0, 'some start with CW');
  assert.ok(firstContains < cw.length, 'some contain CW');
  assert.ok(cw.slice(firstContains).every(v => !v.toUpperCase().startsWith('CW') && v.toUpperCase().includes('CW')));
  // import-only contest IDs are not suggested
  assert.deepEqual(eoSuggestions(contest, {}, 'VIRGINIA QSO PARTY').items, []);
});

test('eoDependents', () => {
  assert.deepEqual([...eoDependents('DXCC')].sort(), ['CNTY', 'STATE']);
  assert.deepEqual([...eoDependents('MY_DXCC')].sort(), ['MY_CNTY', 'MY_STATE']);
  assert.deepEqual(eoDependents('MODE'), []);
  assert.deepEqual(eoDependents('CALL'), []);
});

// What the dropdowns offer is what the validator accepts.
test('cross-check: no offered option is INVALID_ENUM or IMPORT_ONLY_VALUE for the validator', () => {
  const bad = issue => issue.code === 'INVALID_ENUM' || issue.code === 'IMPORT_ONLY_VALUE';
  const base = { CALL: 'OE1ABC', QSO_DATE: '20260901', TIME_ON: '1200', MODE: 'CW', BAND: '20m' };
  for (const f of SELECT_FIELDS) {
    const { key } = eoColumnKind(f, emptyFieldDefs());
    const recs = eoOptionList(key).options.map(o => ({ ...base, [f]: o.value }));
    const r = validateAdif(serializeADIF(recs, [...new Set(['CALL', 'QSO_DATE', 'TIME_ON', 'MODE', 'BAND', f])], '2026-10-01T00:00:00Z'), { today: '20991231' });
    assert.deepEqual(r.issues.filter(bad).map(i => i.message), [], f);
  }
  const state = eoColumnKind('STATE', emptyFieldDefs());
  for (const dxcc of Object.keys(ADIF_SPEC_ENUMS.Primary_Administrative_Subdivision.byScope)) {
    const recs = eoOptionList(eoScopedKey(state, { DXCC: dxcc })).options.map(o => ({ ...base, DXCC: dxcc, STATE: o.value }));
    const r = validateAdif(serializeADIF(recs, ['CALL', 'QSO_DATE', 'TIME_ON', 'MODE', 'BAND', 'DXCC', 'STATE'], '2026-10-01T00:00:00Z'), { today: '20991231' });
    assert.deepEqual(r.issues.filter(bad).map(i => i.message), [], `STATE for DXCC ${dxcc}`);
  }
  const cnty = eoColumnKind('CNTY', emptyFieldDefs());
  for (const dxcc of Object.keys(ADIF_SPEC_ENUMS.Secondary_Administrative_Subdivision.byScope)) {
    const recs = eoOptionList(eoScopedKey(cnty, { DXCC: dxcc })).options.map(o => ({ ...base, DXCC: dxcc, CNTY: o.value }));
    const r = validateAdif(serializeADIF(recs, ['CALL', 'QSO_DATE', 'TIME_ON', 'MODE', 'BAND', 'DXCC', 'CNTY'], '2026-10-01T00:00:00Z'), { today: '20991231' });
    assert.deepEqual(r.issues.filter(bad).map(i => i.message), [], `CNTY for DXCC ${dxcc}`);
  }
  // a USERDEF's values
  const d = defs();
  const recs = eoOptionList(eoColumnKind('MY_E', d).key).options.map(o => ({ ...base, MY_E: o.value }));
  const r = validateAdif(serializeADIF(recs, ['CALL', 'QSO_DATE', 'TIME_ON', 'MODE', 'BAND', 'MY_E'], '2026-10-01T00:00:00Z', { ...d, userdefs: [d.userdefs[0]] }), { today: '20991231' });
  assert.deepEqual(r.issues.filter(bad).map(i => i.message), []);
});
