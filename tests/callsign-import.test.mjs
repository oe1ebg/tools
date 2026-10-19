// Parsers for imported callsign lists (tools/shared/js/callsign-import.js):
// PoLo callsign notes and CSV. Synthetic callsigns and names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePoloNotes, parseCallsignCsv, parseCallsignFile, callsignTokenOk,
  CALLSIGN_IMPORT_MAX_BYTES, CALLSIGN_IMPORT_MAX_ROWS,
} from '../tools/shared/js/callsign-import.js';

test('PoLo notes: title, comments, blank lines, note kept verbatim', () => {
  const r = parsePoloNotes([
    '# TITLE: Hams of Note', '', '#== Ham2K ====', 'OE0QXA 🤩 Anna - Elmer',
    '  oe0qxb   🌳 Bernd - [Club](https://example.org/a)  ', 'OE0QXC',
  ].join('\n'));
  assert.equal(r.title, 'Hams of Note');
  assert.deepEqual(r.rows, [
    { call: 'OE0QXA', base: 'OE0QXA', note: '🤩 Anna - Elmer' },
    { call: 'OE0QXB', base: 'OE0QXB', note: '🌳 Bernd - [Club](https://example.org/a)' },
    { call: 'OE0QXC', base: 'OE0QXC', note: '' },
  ]);
});

test('PoLo notes: CRLF, BOM, prefixed and special-event calls, repeated calls kept', () => {
  const r = parsePoloNotes('﻿PA/DL0QX one\r\nNKQ4 special\r\nOE0QXA first\r\nOE0QXA second\r\n');
  assert.deepEqual(r.rows.map(x => [x.call, x.base, x.note]), [
    ['PA/DL0QX', 'DL0QX', 'one'], ['NKQ4', 'NKQ4', 'special'], ['OE0QXA', 'OE0QXA', 'first'], ['OE0QXA', 'OE0QXA', 'second'],
  ]);
});

test('PoLo notes: expansion shorthand and non-callsigns are skipped and counted', () => {
  const r = parsePoloNotes('..QXA 1 2\nhello world\n12345 x\nOE0QXA ok');
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.skipped, { invalid: 2, expansion: 1 });
});

test('callsignTokenOk', () => {
  for (const c of ['OE0QXA', 'OE0QXA/P', 'PA/DL0QX', 'NKQ4', 'W1AW']) assert.ok(callsignTokenOk(c), c);
  for (const c of ['', 'ABC', '1234', 'OE 0QXA', 'A'.repeat(20) + '1']) assert.ok(!callsignTokenOk(c), c);
});

test('CSV: call only, call+name, call+name+qth; separators ; , tab; quotes', () => {
  assert.deepEqual(parseCallsignCsv('OE0QXA\nOE0QXB').rows.map(r => [r.call, r.name, r.qth]), [['OE0QXA', '', ''], ['OE0QXB', '', '']]);
  assert.deepEqual(parseCallsignCsv('OE0QXA;Anna;1010 Wien').rows[0], { call: 'OE0QXA', base: 'OE0QXA', name: 'Anna', qth: '1010 Wien' });
  assert.deepEqual(parseCallsignCsv('oe0qxa,"Berger, Anna","Graz ""Mitte"""').rows[0].qth, 'Graz "Mitte"');
  assert.equal(parseCallsignCsv('OE0QXA\tAnna\tWien').rows[0].name, 'Anna');
});

test('CSV: header in any column order; unknown columns ignored', () => {
  const r = parseCallsignCsv('Ort;Notiz;Rufzeichen;Name\nWien;x;OE0QXA;Anna');
  assert.deepEqual(r.rows, [{ call: 'OE0QXA', base: 'OE0QXA', name: 'Anna', qth: 'Wien' }]);
  assert.ok(r.header);
  assert.equal(parseCallsignCsv('call\nOE0QXA').rows[0].name, '');
});

test('CSV: invalid rows are counted, blank lines ignored, quoted line breaks', () => {
  const r = parseCallsignCsv('call;name\n\nOE0QXA;"Anna\nBerger"\nnot a call;x\r\n');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].name, 'Anna\nBerger');
  assert.equal(r.skipped.invalid, 1);
});

test('parseCallsignFile: .csv or ; / tab means CSV, otherwise PoLo notes', () => {
  assert.equal(parseCallsignFile('a.csv', 'OE0QXA').kind, 'csv');
  assert.equal(parseCallsignFile('a.txt', 'OE0QXA;Anna').kind, 'csv');
  assert.equal(parseCallsignFile('a.txt', '# x\nOE0QXA 🤩 Anna, Wien').kind, 'polo');
});

test('limits: too large and too many rows are refused, at the limit accepted', () => {
  assert.equal(parsePoloNotes('x'.repeat(CALLSIGN_IMPORT_MAX_BYTES + 1)).error, 'too-large');
  assert.equal(parseCallsignCsv('x'.repeat(CALLSIGN_IMPORT_MAX_BYTES + 1)).error, 'too-large');
  const lines = n => Array.from({ length: n }, (_, i) => `OE0Q${i.toString(36).toUpperCase().padStart(4, 'A')}`).join('\n');
  assert.equal(parseCallsignCsv(lines(CALLSIGN_IMPORT_MAX_ROWS)).rows.length, CALLSIGN_IMPORT_MAX_ROWS);
  assert.equal(parseCallsignCsv(lines(CALLSIGN_IMPORT_MAX_ROWS + 1)).error, 'too-many');
  assert.equal(parsePoloNotes(lines(CALLSIGN_IMPORT_MAX_ROWS + 1)).error, 'too-many');
});
