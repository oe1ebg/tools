// Snapshot of the validator's and the ADI export's output: issue counts per
// code plus a hash of every issue (severity, code, message, record, field,
// value, position), and a hash of the exported text. Guards the
// performance work on adif-validate.js and export.js (tools/adif/README.md,
// "Performance"): faster, but byte for byte the same answers.
//
// Inputs: the official test QSOs as they are (no issues), a deterministic
// mutation of them that trips the cross-field checks on thousands of QSOs
// (BAND/FREQ, STATE per DXCC, MODE/SUBMODE, *_EXT, LAT/LON, missing fields,
// locator in QTH, non-ASCII), and every fixture in tests/fixtures/adif/.
//
// An intended change of messages or checks updates the snapshot:
//   UPDATE_SNAPSHOT=1 node --test tests/adif-validate-snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdif } from '../tools/shared/js/adif-validate.js';
import { parseADIF } from '../tools/shared/js/adif.js';
import { serializeADIF } from '../tools/adif/js/export.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(DIR, 'fixtures', 'adif-validate-snapshot.json');
const TODAY = '20991231';
const STAMP = '2026-01-01T00:00:00Z';
const sha = s => createHash('sha256').update(s).digest('hex');

const official = readFileSync(join(DIR, 'fixtures', 'adif-spec', 'test-qsos.adi'), 'utf8');

function mutated() {
  const records = parseADIF(official, []);
  records.forEach((r, i) => {
    if (i % 7 === 0) { r.BAND = '20m'; r.FREQ = '7.1'; }
    if (i % 11 === 0 && r.DXCC) r.STATE = 'XX';
    if (i % 13 === 0) delete r.MODE;
    if (i % 17 === 0) r.QTH = 'JN88ee';
    if (i % 19 === 0) { r.MODE = 'SSB'; r.SUBMODE = 'FT4'; }
    if (i % 23 === 0) { r.GRIDSQUARE = 'JN88'; r.GRIDSQUARE_EXT = 'AB'; }
    if (i % 29 === 0) { r.LAT = 'N048 12.000'; delete r.LON; }
    if (i % 31 === 0) r.FREQ_RX = '999999';
    if (i % 37 === 0) r.COMMENT = 'Grüße aus Wien';
    if (i % 41 === 0) { delete r.BAND; delete r.FREQ; }
    if (i % 43 === 0) r.SUBMODE = 'NOSUCHMODE';
  });
  const columns = [...new Set(records.flatMap(r => Object.keys(r)))];
  return serializeADIF(records, columns, STAMP);
}

function summarize(text) {
  const r = validateAdif(text, { today: TODAY });
  const counts = {};
  for (const i of r.issues) counts[`${i.severity} ${i.code}`] = (counts[`${i.severity} ${i.code}`] || 0) + 1;
  return {
    records: r.records.length,
    counts: Object.fromEntries(Object.entries(counts).sort()),
    issues: sha(JSON.stringify(r.issues)),
  };
}

function current() {
  const inputs = { 'official test QSOs': official };
  const exported = mutated();
  inputs['official test QSOs, mutated'] = exported;
  for (const f of readdirSync(join(DIR, 'fixtures', 'adif')).sort()) {
    inputs[`fixtures/adif/${f}`] = readFileSync(join(DIR, 'fixtures', 'adif', f), 'utf8');
  }
  const out = { export: sha(exported) };
  for (const [name, text] of Object.entries(inputs)) out[name] = summarize(text);
  return out;
}

test('validator and ADI export output match the snapshot', () => {
  const now = current();
  if (process.env.UPDATE_SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + '\n');
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  assert.equal(now.export, snap.export, 'serializeADIF output changed');
  for (const name of Object.keys(snap)) {
    if (name === 'export') continue;
    assert.deepEqual(now[name], snap[name], name);
  }
  assert.deepEqual(Object.keys(now).sort(), Object.keys(snap).sort(), 'inputs');
});
