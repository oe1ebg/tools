// tools/shared/js/adif.js (used by the ADIF editor and the confirmation log)
// and the ADIF editor's export formats + single-file bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseADIF, parseADIFAuto, adifField, adifAsciiField, adifAscii } from '../tools/shared/js/adif.js';
import { serializeADIF, serializeCSV, serializeSotaCsv, adifChangedValues } from '../tools/adif/js/export.js';
import { readADI } from './adif-spec.mjs';

const OE1EBG = join(dirname(fileURLToPath(import.meta.url)), '..');

const SAMPLE = `Exported by some logger
<ADIF_VER:5>3.1.4 <PROGRAMID:6>Logger <EOH>
<CALL:5>OE1AB <QSO_DATE:8>20261004 <TIME_ON:4>1830 <BAND:3>20m <MODE:2>CW <EOR>
<call:6>DL1XYZ <qso_date:8>20261003 <time_on:6>090000 <MY_SOTA_REF:9>OE/WI-001 <comment:8>a, b "c" <eor>
`;

test('parseADIF: header info, records, case-insensitive tags', () => {
  const warnings = [], header = {};
  const recs = parseADIF(SAMPLE, warnings, 'x.adi', header);
  assert.deepEqual(warnings, []);
  assert.deepEqual(header, { ADIF_VER: '3.1.4', PROGRAMID: 'Logger' });
  assert.equal(recs.length, 2);
  assert.deepEqual(recs[0], { CALL: 'OE1AB', QSO_DATE: '20261004', TIME_ON: '1830', BAND: '20m', MODE: 'CW' });
  assert.equal(recs[1].CALL, 'DL1XYZ');
  assert.equal(recs[1].COMMENT, 'a, b "c"');
});

test('parseADIF: length-delimited values may contain "<"; problems are warnings', () => {
  const warnings = [];
  const recs = parseADIF('<CALL:4>OE1A<COMMENT:5>a<b>c<EOR><CALL:3>OE2', warnings, 'f');
  assert.deepEqual(recs, [{ CALL: 'OE1A', COMMENT: 'a<b>c' }, { CALL: 'OE2' }]);
  assert.match(warnings[0], /^f: trailing fields/);
});

test('adifField / adifAsciiField', () => {
  assert.equal(adifField('CALL', 'OE1AB'), '<CALL:5>OE1AB ');
  for (const v of ['', undefined, null]) assert.equal(adifField('CALL', v), '');
  assert.equal(adifField('N', 0), '<N:1>0 ');
  assert.equal(adifAsciiField('QTH', 'Wien Döbling'), '<QTH:13>Wien Doebling ');
  assert.equal(adifAsciiField('X', '<>'), '');
  assert.equal(adifAscii('Größe <x> Café\nneu'), 'Groesse x Cafe neu');
});

test('serializeADIF round-trips through parseADIF', () => {
  const recs = parseADIF(SAMPLE, [], 's');
  const columns = ['CALL', 'QSO_DATE', 'TIME_ON', 'BAND', 'MODE', 'MY_SOTA_REF', 'COMMENT'];
  const out = serializeADIF(recs, columns, '2026-10-06T12:34:56.789Z');
  assert.match(out, /<PROGRAMID:10>ADIFEditor\n<ADIF_VER:5>3\.1\.7\n<CREATED_TIMESTAMP:15>20261006 123456\n<EOH>/);
  readADI(out); // spec-conformant (tests/adif-spec.mjs)
  assert.ok(out.includes('<CALL:5>OE1AB <QSO_DATE:8>20261004 <TIME_ON:4>1830 <BAND:3>20m <MODE:2>CW <EOR>\n'));
  const header = {};
  assert.deepEqual(parseADIF(out, [], 'rt', header), recs);
  assert.equal(header.PROGRAMID, 'ADIFEditor');
});

test('serializeCSV: RFC 4180 quoting, blank cells kept', () => {
  const csv = serializeCSV([{ CALL: 'OE1AB' }, { CALL: 'DL1XYZ', COMMENT: 'a, b "c"' }], ['CALL', 'COMMENT']);
  assert.equal(csv, '\ufeffCALL,COMMENT\r\nOE1AB,\r\nDL1XYZ,"a, b ""c"""', 'UTF-8 BOM for Excel');
});

test('serializeSotaCsv: V2 rows, chronological, no commas', () => {
  const recs = parseADIF(SAMPLE, [], 's');
  recs[0].MY_SOTA_REF = 'OE/WI-002';
  const out = serializeSotaCsv(recs, 'activator');
  assert.equal(out,
    'V2,,OE/WI-001,03/10/2026,0900,,,DL1XYZ,,a; b "c"\r\n' +
    'V2,,OE/WI-002,04/10/2026,1830,20m,CW,OE1AB,,\r\n');
  assert.equal(serializeSotaCsv(recs, 'chaser'), '');
});

test('editor single-file bundle builds and parses', () => {
  // the project's Python via uv, like confirm-offline.test.mjs
  try {
    execFileSync('uv', ['run', '--no-project', 'python', 'scripts/build_adif.py'], { cwd: OE1EBG, stdio: 'pipe' });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    execFileSync('python3', ['scripts/build_adif.py'], { cwd: OE1EBG, stdio: 'pipe' });
  }
  const html = readFileSync(join(OE1EBG, 'tools', 'adif', 'adif-editor.html'), 'utf8');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+rel="stylesheet"/.test(html), 'stylesheets inlined');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // theme (in <head>), app bundle
  assert.equal(scripts.length, 2);
  assert.ok(scripts[0].includes('OE1EBG_THEME'), 'theme script first');
  const app = scripts[1];
  assert.ok(!/^\s*(import|export)\b/m.test(app));
  assert.ok(app.includes('function parseADIF('), 'shared module inlined');
  for (const s of scripts) new vm.Script(s);
});

test('editor ADI export is ASCII (transliterated), keeps < > inside values, and says what it changed', () => {
  const recs = [{ CALL: 'OE1AB', QSO_DATE: '20261004', TIME_ON: '1830', NAME: 'Jürgen', COMMENT: 'a<b>c' }];
  const cols = ['CALL', 'QSO_DATE', 'TIME_ON', 'NAME', 'COMMENT'];
  const out = serializeADIF(recs, cols, '2026-10-06T00:00:00Z');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(out), 'ASCII only');
  const { records } = readADI(out);
  assert.equal(records[0].NAME, 'Juergen');
  assert.equal(records[0].COMMENT, 'a<b>c');
  assert.equal(adifChangedValues(recs, cols), 1);
});

test('editor ADI export keeps line breaks (as CR LF) only in MultilineString fields', () => {
  assert.equal(adifAscii('a\nb\r\nc\rd\te', { multiline: true }), 'a\r\nb\r\nc\r\nd e');
  const recs = [{ CALL: 'OE1AB', QSO_DATE: '20261004', TIME_ON: '1830', ADDRESS: 'Gasse 1\nWien', COMMENT: 'a\r\nb' }];
  const cols = ['CALL', 'QSO_DATE', 'TIME_ON', 'ADDRESS', 'COMMENT'];
  const out = serializeADIF(recs, cols, '2026-10-06T00:00:00Z');
  assert.ok(out.includes('<ADDRESS:13>Gasse 1\r\nWien '), out);
  assert.ok(out.includes('<COMMENT:3>a b '), out);
  assert.equal(adifChangedValues(recs, cols), 2, 'LF → CR LF and the COMMENT line break');
});

test('parseADIFAuto: lengths counted in UTF-8 bytes (common in practice) are detected', () => {
  // "Müller" / "Jürgen" = 6 characters, 7 bytes each; one value followed by a space, one directly by the next tag
  const bytes = '<CALL:5>OE1AB <NAME:7>Müller <QTH:4>Wien <EOR>\n<CALL:6>DL1XYZ <NAME:7>Jürgen<QTH:4>Graz<EOR>\n';
  const warnings = [];
  const recs = parseADIFAuto(bytes, warnings, 'b.adi');
  assert.deepEqual(recs, [{ CALL: 'OE1AB', NAME: 'Müller', QTH: 'Wien' }, { CALL: 'DL1XYZ', NAME: 'Jürgen', QTH: 'Graz' }]);
  assert.ok(warnings.some(w => /UTF-8 bytes/.test(w)));
  // the same content with spec-conformant character counts is read as such
  const chars = '<CALL:5>OE1AB <NAME:6>Müller <QTH:4>Wien <EOR>\n<CALL:6>DL1XYZ <NAME:6>Jürgen<QTH:4>Graz<EOR>\n';
  const w2 = [];
  assert.deepEqual(parseADIFAuto(chars, w2, 'c.adi'), recs);
  assert.deepEqual(w2, []);
  // ASCII files: plain parseADIF
  assert.deepEqual(parseADIFAuto(SAMPLE, [], 's'), parseADIF(SAMPLE, [], 's'));
});
