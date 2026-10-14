// ADIF editor date and time cells (tools/adif/js/datetime.js): shown and
// typed as ISO 8601, stored as ADIF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT_DATE, DT_TIME, dtColumnKind, dtShow, dtParse, dtAdifDate, dtIsoDate } from '../tools/adif/js/datetime.js';
import { ADIF_SPEC_FIELDS } from '../tools/shared/js/adif-spec-data.js';

test('every ADIF Date and Time field, and USERDEF/APP fields of type D and T, are date/time columns', () => {
  const dates = Object.keys(ADIF_SPEC_FIELDS).filter(k => !ADIF_SPEC_FIELDS[k].header && ADIF_SPEC_FIELDS[k].type === 'Date');
  const times = Object.keys(ADIF_SPEC_FIELDS).filter(k => !ADIF_SPEC_FIELDS[k].header && ADIF_SPEC_FIELDS[k].type === 'Time');
  for (const f of ['QSO_DATE', 'QSO_DATE_OFF', 'QSLRDATE', 'QSLSDATE', 'LOTW_QSLRDATE', 'EQSL_QSLSDATE', 'DCL_QSLRDATE', 'CLUBLOG_QSO_UPLOAD_DATE', 'QRZCOM_QSO_DOWNLOAD_DATE']) assert.ok(dates.includes(f), f);
  assert.deepEqual(times.sort(), ['TIME_OFF', 'TIME_ON']);
  for (const f of dates) assert.equal(dtColumnKind(f), DT_DATE, f);
  for (const f of times) assert.equal(dtColumnKind(f), DT_TIME, f);
  for (const f of ['CALL', 'FREQ', 'BAND', 'CREATED_TIMESTAMP', 'ADIF_VER']) assert.equal(dtColumnKind(f), null, f);
  const defs = { userdefs: [{ name: 'SKED', type: 'D', spec: 'SKED' }, { name: 'SLOT', type: 'T', spec: 'SLOT' }, { name: 'NOTE', type: 'S', spec: 'NOTE' }], types: { APP_X_DAY: 'D', APP_X_AT: 't', APP_X_N: 'N' } };
  assert.equal(dtColumnKind('SKED', defs), DT_DATE);
  assert.equal(dtColumnKind('SLOT', defs), DT_TIME);
  assert.equal(dtColumnKind('APP_X_DAY', defs), DT_DATE);
  assert.equal(dtColumnKind('APP_X_AT', defs), DT_TIME);
  for (const f of ['NOTE', 'APP_X_N', 'APP_Y']) assert.equal(dtColumnKind(f, defs), null, f);
});

test('stored ADIF dates and times are shown as ISO; other values as they are', () => {
  assert.equal(dtShow(DT_DATE, '20260901'), '2026-09-01');
  assert.equal(dtShow(DT_DATE, '20260230'), '2026-02-30'); // shown; the validator reports it
  for (const v of ['', '2026091', '2026-09-01', '202609011', 'x']) assert.equal(dtShow(DT_DATE, v), v);
  assert.equal(dtShow(DT_TIME, '1200'), '12:00');
  assert.equal(dtShow(DT_TIME, '120030'), '12:00:30');
  for (const v of ['', '120', '12000', '12:00', '1200300']) assert.equal(dtShow(DT_TIME, v), v);
});

test('typed ISO or ADIF values are stored as ADIF; anything else as typed', () => {
  for (const [typed, stored] of [['2026-09-01', '20260901'], [' 2026-9-1 ', '20260901'], ['2026.09.01', '20260901'], ['2026/9/01', '20260901'], ['20260901', '20260901'], ['', ''], ['  ', ''], ['01.09.2026', '01.09.2026'], ['2026-09', '2026-09'], ['09/01/2026', '09/01/2026']]) {
    assert.equal(dtParse(DT_DATE, typed), stored, typed);
  }
  for (const [typed, stored] of [['12:00', '1200'], ['9:05', '0905'], ['12:00:30', '120030'], ['1200', '1200'], ['120030', '120030'], [' 23:59 ', '2359'], ['12', '12'], ['12:0', '12:0'], ['12h', '12h']]) {
    assert.equal(dtParse(DT_TIME, typed), stored, typed);
  }
  // round trip: what is shown parses back to what is stored
  for (const v of ['20260901', '19300101']) assert.equal(dtParse(DT_DATE, dtShow(DT_DATE, v)), v);
  for (const v of ['0000', '2359', '235959', '0905']) assert.equal(dtParse(DT_TIME, dtShow(DT_TIME, v)), v);
});

test('filter dates and picker values', () => {
  assert.equal(dtAdifDate('2026-09-01'), '20260901');
  assert.equal(dtAdifDate('2026-9-1'), '20260901');
  assert.equal(dtAdifDate('20260901'), '20260901');
  for (const v of ['', '2026-1', '01.09.2026', 'x']) assert.equal(dtAdifDate(v), '', v);
  assert.equal(dtIsoDate('20260901'), '2026-09-01');
  assert.equal(dtIsoDate('2026-9-1'), '2026-09-01');
  assert.equal(dtIsoDate('20240229'), '2024-02-29');
  for (const v of ['20260230', '20261301', '2026091', '']) assert.equal(dtIsoDate(v), '', v);
});
