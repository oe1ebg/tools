// ADIF editor search & filter (tools/adif/js/filter.js): the view the
// table shows; exports are not affected (they never see the view).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeView, emptyFilter, isFilterActive, invalidateRecord, invalidateAllRecords, revealRecordFilter,
} from '../tools/adif/js/filter.js';

const recs = () => [
  { CALL: 'OE1ABC', QSO_DATE: '20260901', BAND: '2m', MODE: 'FM', COMMENT: 'Thanks Hans' },
  { CALL: 'OE3XYZ', QSO_DATE: '20260901', BAND: '40m', MODE: 'FT8' },
  { CALL: 'DL1AA', QSO_DATE: '20260902', BAND: '20m', MODE: 'CW', MY_SOTA_REF: 'OE/WI-001' },
  { CALL: 'oe1xyz', QSO_DATE: '20261231', BAND: '2m', MODE: 'fm', COMMENT: ' ' },
  { CALL: 'G4ABC' }, // no QSO_DATE
];
const f = over => ({ ...emptyFilter(), ...over });

test('no active filter: null (show all)', () => {
  assert.equal(computeView(recs(), emptyFilter()), null);
  assert.equal(computeView(recs(), undefined), null);
  assert.equal(isFilterActive(emptyFilter()), false);
  // half-typed parts don't filter
  assert.equal(computeView(recs(), f({ text: '   ', conditions: [{ field: 'CALL', op: 'eq', value: '' }, { field: '', op: 'empty' }] })), null);
  assert.equal(computeView(recs(), f({ status: 'any', dateFrom: '2026-1' })), null);
});

test('free-text search: case-insensitive, any field or one field', () => {
  assert.deepEqual(computeView(recs(), f({ text: 'oe1' })), [0, 3]);
  assert.deepEqual(computeView(recs(), f({ text: 'XYZ' })), [1, 3]);
  assert.deepEqual(computeView(recs(), f({ text: 'hans' })), [0]);
  assert.deepEqual(computeView(recs(), f({ text: 'oe' })), [0, 1, 2, 3]); // OE/WI-001 in DL1AA's MY_SOTA_REF
  assert.deepEqual(computeView(recs(), f({ text: 'oe', textField: 'CALL' })), [0, 1, 3]);
  assert.deepEqual(computeView(recs(), f({ text: 'nothing' })), []);
  // no match across two values
  assert.deepEqual(computeView(recs(), f({ text: 'oe1abc20260901' })), []);
});

test('haystack cache: stale until the record is invalidated', () => {
  const r = recs();
  assert.deepEqual(computeView(r, f({ text: 'oe9new' })), []);
  r[4].CALL = 'OE9NEW';
  assert.deepEqual(computeView(r, f({ text: 'oe9new' })), [], 'cached');
  invalidateRecord(r[4]);
  assert.deepEqual(computeView(r, f({ text: 'oe9new' })), [4]);
  r[0].CALL = 'OE9NEW';
  invalidateAllRecords();
  assert.deepEqual(computeView(r, f({ text: 'oe9new' })), [0, 4]);
  // a single-field search reads the value directly
  r[1].CALL = 'OE9NEW';
  assert.deepEqual(computeView(r, f({ text: 'oe9new', textField: 'CALL' })), [0, 1, 4]);
});

test('validation status: per record index, arrays or Map(field -> issues)', () => {
  const issuesByIndex = new Map([
    [0, [{ severity: 'error' }, { severity: 'info' }]],
    [2, new Map([['BAND', [{ severity: 'warning' }]], ['', [{ severity: 'info' }]]])],
    [3, []],
  ]);
  const ctx = { issuesByIndex };
  assert.deepEqual(computeView(recs(), f({ status: 'errors' }), ctx), [0]);
  assert.deepEqual(computeView(recs(), f({ status: 'warnings' }), ctx), [2]);
  assert.deepEqual(computeView(recs(), f({ status: 'info' }), ctx), [0, 2]);
  assert.deepEqual(computeView(recs(), f({ status: 'clean' }), ctx), [1, 3, 4]);
  // no validation result yet: everything counts as issue-free
  assert.deepEqual(computeView(recs(), f({ status: 'errors' })), []);
  assert.equal(computeView(recs(), f({ status: 'bogus' })), null);
});

test('validation status: the editor\'s { worst, issues, byField } entries (state.js)', () => {
  const entry = (...sev) => ({ worst: sev[0], issues: sev.map(severity => ({ severity })), byField: new Map() });
  const issuesByIndex = new Map([[1, entry('warning', 'info')], [4, entry('error')]]);
  assert.deepEqual(computeView(recs(), f({ status: 'errors' }), { issuesByIndex }), [4]);
  assert.deepEqual(computeView(recs(), f({ status: 'info' }), { issuesByIndex }), [1]);
  assert.deepEqual(computeView(recs(), f({ status: 'clean' }), { issuesByIndex }), [0, 2, 3]);
});

test('field conditions: equals, starts with, contains, empty, not empty; ANDed', () => {
  const v = c => computeView(recs(), f({ conditions: [].concat(c) }));
  assert.deepEqual(v({ field: 'MODE', op: 'eq', value: 'fm' }), [0, 3]);
  assert.deepEqual(v({ field: 'mode', op: 'eq', value: ' FM ' }), [0, 3], 'field name and value normalized');
  assert.deepEqual(v({ field: 'CALL', op: 'starts', value: 'OE' }), [0, 1, 3]);
  assert.deepEqual(v({ field: 'CALL', op: 'contains', value: 'abc' }), [0, 4]);
  assert.deepEqual(v({ field: 'COMMENT', op: 'empty' }), [1, 2, 3, 4], 'whitespace-only counts as empty');
  assert.deepEqual(v({ field: 'COMMENT', op: 'notempty' }), [0]);
  assert.deepEqual(v([{ field: 'BAND', op: 'eq', value: '2m' }, { field: 'CALL', op: 'starts', value: 'OE1A' }]), [0]);
  assert.deepEqual(v({ field: 'NOPE', op: 'notempty' }), []);
});

test('source file and QSO_DATE range', () => {
  const recordFile = ['a.adi', 'a.adi', 'b.adi', 'b.adi', ''];
  assert.deepEqual(computeView(recs(), f({ file: 'b.adi' }), { recordFile }), [2, 3]);
  assert.deepEqual(computeView(recs(), f({ dateFrom: '2026-09-02' })), [2, 3]);
  assert.deepEqual(computeView(recs(), f({ dateTo: '20260901' })), [0, 1]);
  assert.deepEqual(computeView(recs(), f({ dateFrom: '2026-09-01', dateTo: '2026-09-02' })), [0, 1, 2]);
  assert.deepEqual(computeView(recs(), f({ dateFrom: '2026-09-01', dateTo: '2026-09-02', file: 'a.adi', text: 'xyz' }), { recordFile }), [1]);
});

test('display order and kept rows', () => {
  assert.deepEqual(computeView(recs(), f({ text: 'oe' }), { order: [3, 2, 1, 0, 4] }), [3, 2, 1, 0]);
  assert.deepEqual(computeView(recs(), f({ text: 'oe1' }), { keep: [4] }), [0, 3, 4]);
});

test('revealRecordFilter clears only what hides the record', () => {
  const issuesByIndex = new Map([[2, [{ severity: 'error' }]]]);
  const recordFile = ['a.adi', 'a.adi', 'b.adi', 'b.adi', ''];
  const ctx = { issuesByIndex, recordFile };
  const state = f({
    text: 'oe', status: 'errors', file: 'b.adi', dateFrom: '2026-09-02',
    conditions: [{ field: 'BAND', op: 'eq', value: '2m' }, { field: 'MODE', op: 'eq', value: 'CW' }, { field: 'X', op: 'eq', value: '' }],
  });
  assert.deepEqual(computeView(recs(), state, ctx), []);
  const next = revealRecordFilter(recs(), state, 2, ctx);
  assert.equal(next.text, 'oe');
  assert.equal(next.status, 'errors');
  assert.equal(next.file, 'b.adi');
  assert.equal(next.dateFrom, '2026-09-02');
  assert.deepEqual(next.conditions, [{ field: 'MODE', op: 'eq', value: 'CW' }, { field: 'X', op: 'eq', value: '' }]);
  assert.deepEqual(computeView(recs(), next, ctx), [2]);
  // record 0: fails status, file and date
  const n0 = revealRecordFilter(recs(), state, 0, ctx);
  assert.deepEqual([n0.status, n0.file, n0.dateFrom, n0.dateTo], ['any', '', '', '']);
  assert.ok(computeView(recs(), n0, ctx).includes(0));
  assert.equal(state.status, 'errors', 'input state not mutated');
});
