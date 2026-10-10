// Spreadsheet-safe CSV (tools/shared/js/csv.js, issue #12) and every CSV
// writer that uses it: the confirmation log, the Notfunk Geschäftsbuch and
// the ADIF editor; plus the SOTA V2 CSV, which flattens instead.
process.env.TZ = 'Europe/Vienna';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvIsFormula, csvGuard, csvSafeCell, csvSafeRows } from '../tools/shared/js/csv.js';
import { toCSV } from '../tools/confirm/js/export.js';
import { headerSnapshot } from '../tools/confirm/js/model.js';
import { toGeschaeftsbuchCSV } from '../tools/notfunk/js/export.js';
import { newMessage } from '../tools/notfunk/js/model.js';
import { formatNumber } from '../tools/notfunk/js/numbering.js';
import { serializeCSV, serializeSotaCsv, serializeADIF } from '../tools/adif/js/export.js';

const FORMULAS = ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '\tfoo', '\rfoo', ' =1+1', '\u0000=1', '  @x', '-', '+', '=', '- defekt', '+43 1 234'];
const PLAIN = ['-10', '+5', '-3.5', '-3,5', '+0.5', '10', 'OE1ABC', 'a=b', 'x-1', '', '145.500', 'Notiz', ' 5', "'=1"];

test('csvIsFormula / csvGuard: formula starts guarded, plain numbers and text unchanged', () => {
  for (const v of FORMULAS) {
    assert.ok(csvIsFormula(v), JSON.stringify(v));
    assert.equal(csvGuard(v), "'" + v);
  }
  for (const v of PLAIN) {
    assert.ok(!csvIsFormula(v), JSON.stringify(v));
    assert.equal(csvGuard(v), v);
  }
  assert.equal(csvGuard(null), '');
  assert.equal(csvGuard(-10), '-10', 'numbers as numbers');
});

test('csvSafeCell: guard first, then quoting; stats count the guarded cells', () => {
  const stats = { guarded: 0 };
  assert.equal(csvSafeCell('=1+1', ';', stats), "'=1+1");
  assert.equal(csvSafeCell('=1;2', ';', stats), `"'=1;2"`);
  assert.equal(csvSafeCell('=A1,"x"', ',', stats), `"'=A1,""x"""`);
  assert.equal(csvSafeCell('\r=1', ',', stats), `"'\r=1"`);
  assert.equal(csvSafeCell('-10', ';', stats), '-10');
  assert.equal(csvSafeCell('a;b', ';', stats), '"a;b"');
  assert.equal(csvSafeCell(undefined, ';', stats), '');
  assert.equal(stats.guarded, 4);
  assert.equal(csvSafeRows([['=h', 'x'], ['-1', '@y']], ','), "'=h,x\r\n-1,'@y");
});

test('confirmation log CSV: formula cells guarded, numbers unchanged, stats', () => {
  const header = { operator: 'OE1EBG', station: 'OE1XKS', freq: '145.500', mode: 'FM', myGrid: 'JN88ef', myQth: '=HYPERLINK("x")' };
  const ev = { id: 'ev', title: '@Übung', template: 'standard', header };
  const snap = headerSnapshot(header);
  const es = [
    { id: 'a', seq: 1, call: 'OE1AAA', ts: '2026-10-04T10:00:05Z', viaRepeater: false, snap, fields: {}, note: '=1+1' },
    { id: 'b', seq: 2, call: 'OE1BBB', ts: '2026-10-04T10:01:00Z', viaRepeater: false, snap, fields: {}, note: '-10' },
    { id: 'c', seq: 3, call: 'OE1CCC', ts: '2026-10-04T10:02:00Z', viaRepeater: false, snap, fields: {}, note: '- Akku leer;' },
  ];
  const stats = { guarded: 0 };
  const lines = toCSV(ev, es, ';', { stats }).slice(1).trimEnd().split('\r\n');
  const cols = lines[0].split(';');
  const cell = (i, c) => lines[i].split(';')[cols.indexOf(c)];
  assert.equal(cell(1, 'notiz'), "'=1+1");
  assert.equal(cell(2, 'notiz'), '-10', 'a plain number stays a number');
  assert.ok(lines[3].includes(`"'- Akku leer;"`), 'guarded, then quoted for the separator');
  assert.equal(cell(1, 'log'), "'@Übung");
  // 3 notes + log title per row (3) = 1 + 1 + 3
  assert.equal(stats.guarded, 5);
  assert.ok(!lines.some(l => /(^|;)[=+@]/.test(l)), 'no cell starts like a formula');
});

test('Geschäftsbuch CSV: formula cells guarded, header unchanged', () => {
  const m = newMessage({
    direction: 'in', ts: '2026-10-05T12:07:00.000Z', channel: 'funk', radio: { freq: '145.500', via: '' },
    from: { name: '=cmd|"/c calc"!A1' }, to: { name: 'ELS' }, subject: '+Strom', text: '-5 Grad\nkalt', remarks: '-10',
  }, { prefix: 'W1', seq: 1, number: formatNumber('W1', 1) }, { id: 'm1', opId: 'op1', operator: 'oe1xyz', stationCall: 'oe1xks', now: '2026-10-05T12:07:00.000Z' });
  const stats = { guarded: 0 };
  const csv = toGeschaeftsbuchCSV([m], ';', stats);
  assert.ok(csv.startsWith('﻿Notfunk-Nr.;Referenz Meldesammelstelle;'));
  assert.ok(csv.includes(`;"'=cmd|""/c calc""!A1";'+Strom;"'-5 Grad\nkalt";`), csv);
  assert.ok(csv.trimEnd().endsWith(';-10'), 'Anmerkungen -10: a number, unchanged');
  assert.ok(stats.guarded >= 3);
});

test('ADIF editor CSV: values and imported field names guarded, ADI stays raw', () => {
  const recs = [{ CALL: 'OE1AB', COMMENT: '=1+1', APP_X_N: '-10', NOTES: '@x' }];
  const stats = { guarded: 0 };
  const csv = serializeCSV(recs, ['CALL', 'COMMENT', 'APP_X_N', 'NOTES', '=BAD'], stats);
  assert.equal(csv, "﻿CALL,COMMENT,APP_X_N,NOTES,'=BAD\r\nOE1AB,'=1+1,-10,'@x,");
  assert.equal(stats.guarded, 3);
  assert.ok(serializeADIF(recs, ['CALL', 'COMMENT'], '2026-10-06T00:00:00Z').includes('<COMMENT:4>=1+1 '), 'raw interchange path');
});

test('SOTA CSV: one QSO per line, line breaks and commas flattened and counted', () => {
  const recs = [
    { CALL: 'OE1AB', QSO_DATE: '20261004', TIME_ON: '1830', BAND: '2m', MODE: 'FM', MY_SOTA_REF: 'OE/WI-001', NOTES: 'line one\r\nline two, more\nthree' },
    { CALL: 'OE3XY', QSO_DATE: '20261004', TIME_ON: '1840', BAND: '2m', MODE: 'FM', MY_SOTA_REF: 'OE/WI-001', COMMENT: 'tnx\tfb' },
    { CALL: 'OE5ZZ', QSO_DATE: '20261004', TIME_ON: '1850', BAND: '2m', MODE: 'FM', MY_SOTA_REF: 'OE/WI-001', COMMENT: '=1+1' },
  ];
  const stats = { flattened: 0 };
  const out = serializeSotaCsv(recs, 'activator', stats);
  const lines = out.split('\r\n');
  assert.equal(lines.length, 4, 'three lines and the final line break');
  assert.ok(!/[\n\r]/.test(lines.slice(0, 3).join('')));
  assert.equal(lines[0], 'V2,,OE/WI-001,04/10/2026,1830,2m,FM,OE1AB,,line one line two; more three');
  assert.equal(lines[1], 'V2,,OE/WI-001,04/10/2026,1840,2m,FM,OE3XY,,tnx fb');
  assert.equal(lines[2], 'V2,,OE/WI-001,04/10/2026,1850,2m,FM,OE5ZZ,,=1+1', "for SOTA's importer, not a spreadsheet: no '");
  assert.equal(stats.flattened, 2);
});
