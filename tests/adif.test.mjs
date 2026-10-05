// tools/shared/js/adif.js (used by the ADIF editor and the confirmation log)
// and the ADIF editor's export formats + single-file bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseADIF, adifField, adifAsciiField, adifAscii } from '../tools/shared/js/adif.js';
import { serializeADIF, serializeCSV, serializeSotaCsv } from '../tools/adif/js/export.js';

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
  const out = serializeADIF(recs, columns);
  assert.match(out, /<PROGRAMID:10>ADIFEditor\n<ADIF_VER:5>3\.1\.7\n<EOH>/);
  assert.ok(out.includes('<CALL:5>OE1AB <QSO_DATE:8>20261004 <TIME_ON:4>1830 <BAND:3>20m <MODE:2>CW <EOR>\n'));
  const header = {};
  assert.deepEqual(parseADIF(out, [], 'rt', header), recs);
  assert.equal(header.PROGRAMID, 'ADIFEditor');
});

test('serializeCSV: RFC 4180 quoting, blank cells kept', () => {
  const csv = serializeCSV([{ CALL: 'OE1AB' }, { CALL: 'DL1XYZ', COMMENT: 'a, b "c"' }], ['CALL', 'COMMENT']);
  assert.equal(csv, 'CALL,COMMENT\r\nOE1AB,\r\nDL1XYZ,"a, b ""c"""');
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
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 1);
  assert.ok(!/^\s*(import|export)\b/m.test(scripts[0]));
  assert.ok(scripts[0].includes('function parseADIF('), 'shared module inlined');
  new vm.Script(scripts[0]);
});
