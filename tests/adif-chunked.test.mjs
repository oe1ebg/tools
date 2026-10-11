// Chunked, cancellable ADIF work (issue #15): the generator versions of the
// parser, the validator and the ADI export give exactly the results of the
// synchronous ones, wherever they pause; a cancelled load returns nothing;
// a newer job supersedes an older one; limits refuse a file with a message
// before anything is applied. The runner and the loader are pure (no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseADIFAuto, parseADIFAutoSteps, parseADIF, adifCountsBytes, AdifLimitError } from '../tools/shared/js/adif.js';
import { validateAdif, validateAdifSteps } from '../tools/shared/js/adif-validate.js';
import { chunkedRun, ChunkedSlot, chunkedIsAbort } from '../tools/shared/js/chunked.js';
import { serializeADIF, serializeADIFSteps } from '../tools/adif/js/export.js';
import { loadLogFiles, ADIF_LIMITS, adifLimitMessage } from '../tools/adif/js/load.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(DIR, 'fixtures', 'adif');
const official = readFileSync(join(DIR, 'fixtures', 'adif-spec', 'test-qsos.adi'), 'utf8');
const TODAY = '20991231';
const STAMP = '2026-01-01T00:00:00Z';

// every step is its own slice: the most pauses possible
const everyStep = { budget: -1, tick: () => Promise.resolve() };

const inputs = [['official test QSOs', official]];
for (const f of readdirSync(FIXTURES).filter(n => n.endsWith('.adi'))) inputs.push([f, readFileSync(join(FIXTURES, f), 'utf8')]);
// lengths counted in UTF-8 bytes (the byte reading wins), and a non-ASCII file counted in characters
const byteCounted = '<ADIF_VER:5>3.1.7\n<EOH>\n' + Array.from({ length: 30 }, (_, i) =>
  `<CALL:5>OE${i % 10}AB<NAME:6>Jürgen<QSO_DATE:8>20240101<TIME_ON:4>1200<BAND:3>20m<MODE:3>SSB<EOR>`).join('\n');
const charCounted = '<ADIF_VER:5>3.1.7\n<EOH>\n<CALL:5>OE1AB<NAME:5>Jürgen<COMMENT:3>äöü<EOR>\n';
inputs.push(['UTF-8 byte lengths', byteCounted], ['non-ASCII characters', charCounted]);

for (const [label, text] of inputs) {
  test(`chunked parse equals the synchronous parse: ${label}`, async () => {
    const a = { w: [], h: {}, d: {} };
    const sync = parseADIFAuto(text, a.w, label, a.h, a.d);
    const b = { w: [], h: {}, d: {} };
    const chunked = await chunkedRun(parseADIFAutoSteps(text, b.w, label, b.h, b.d), everyStep);
    assert.deepEqual(chunked, sync);
    assert.deepEqual(b, a);
  });

  test(`chunked validation equals the synchronous validation: ${label}`, async () => {
    const sync = validateAdif(text, { today: TODAY });
    const chunked = await chunkedRun(validateAdifSteps(text, { today: TODAY }), everyStep);
    assert.deepEqual(chunked, sync);
  });
}

test('the steps report progress and are the same code as the sync path', () => {
  const phases = new Set();
  const gen = validateAdifSteps(official, { today: TODAY });
  let r;
  while (!(r = gen.next()).done) phases.add(r.value.phase);
  assert.deepEqual([...phases].sort(), ['check', 'records', 'scan']);
  assert.deepEqual(r.value, validateAdif(official, { today: TODAY }));
});

test('lean validation: same issues and counts, records without their fields', () => {
  const full = validateAdif(official, { today: TODAY });
  const lean = validateAdif(official, { today: TODAY, lean: true });
  assert.deepEqual(lean.issues, full.issues);
  for (const k of ['valid', 'errors', 'warnings', 'infos']) assert.equal(lean[k], full[k]);
  assert.equal(lean.records.length, full.records.length);
  assert.deepEqual(lean.records[5], { index: 5, offset: full.records[5].offset, line: full.records[5].line });
});

test('maxIssues keeps the counts of the whole file and says how many were left out', () => {
  const text = official.replace(/<QSO_DATE:8>\d{8}/g, '<QSO_DATE:8>20241301'); // an invalid date in every QSO
  const full = validateAdif(text, { today: TODAY });
  assert.ok(full.issues.length >= 100);
  const capped = validateAdif(text, { today: TODAY, maxIssues: 10 });
  for (const k of ['valid', 'errors', 'warnings', 'infos']) assert.equal(capped[k], full[k]);
  assert.ok(capped.issues.length < full.issues.length);
  assert.equal(capped.issuesDropped, full.issues.length - capped.issues.length);
  assert.equal(full.issuesDropped, undefined);
});

test('chunked ADI export equals serializeADIF', async () => {
  const recs = parseADIF(official, []);
  const cols = [...new Set(recs.flatMap(r => Object.keys(r)))];
  const sync = serializeADIF(recs, cols, STAMP);
  const chunked = await chunkedRun(serializeADIFSteps(recs, cols, STAMP), everyStep);
  assert.equal(chunked, sync);
});

/* ---------- the runner ---------- */

test('chunkedRun hands the thread back between slices and reports progress', async () => {
  let ticks = 0;
  const seen = [];
  function* job() { for (let i = 1; i <= 5; i++) yield { done: i }; return 'result'; }
  const r = await chunkedRun(job(), { budget: -1, tick: async () => { ticks++; }, onProgress: p => seen.push(p.done) });
  assert.equal(r, 'result');
  assert.equal(ticks, 5);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test('chunkedRun: a cancelled job rejects with AbortError, closes the generator and returns nothing', async () => {
  let closed = false;
  const signal = { aborted: false };
  function* job() { try { for (let i = 0; ; i++) yield i; } finally { closed = true; } }
  await assert.rejects(
    chunkedRun(job(), { budget: -1, signal, tick: async () => { signal.aborted = true; } }),
    e => chunkedIsAbort(e));
  assert.equal(closed, true);
});

test('chunkedRun: an error in the job rejects with that error', async () => {
  function* job() { yield 1; throw new Error('boom'); }
  await assert.rejects(chunkedRun(job(), everyStep), /boom/);
});

test('ChunkedSlot: a newer job supersedes the running one, only the newest result counts', async () => {
  const slot = new ChunkedSlot();
  const applied = [];
  function* job(name, steps) { for (let i = 0; i < steps; i++) yield i; return name; }
  const a = slot.start(job('first', 50), everyStep).then(v => applied.push(v), e => applied.push(chunkedIsAbort(e) ? 'aborted first' : 'failed'));
  const b = slot.start(job('second', 3), everyStep).then(v => applied.push(v));
  await Promise.all([a, b]);
  assert.deepEqual(applied.sort(), ['aborted first', 'second']);
  assert.equal(slot.running, false);
});

test('ChunkedSlot.cancel() stops the running job', async () => {
  const slot = new ChunkedSlot();
  function* job() { for (;;) yield 1; }
  const p = slot.start(job(), everyStep);
  slot.cancel();
  await assert.rejects(p, e => chunkedIsAbort(e));
  assert.equal(slot.running, false);
});

/* ---------- loading files ---------- */

const file = (name, text) => ({ name, size: Buffer.byteLength(text), arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const quick = { budget: -1, tick: () => Promise.resolve() };

test('loadLogFiles: records, warnings and validation equal the synchronous path', async () => {
  const { loaded, skipped } = await loadLogFiles([file('a.adi', official), file('b.adi', byteCounted)], quick);
  assert.deepEqual(skipped, []);
  assert.equal(loaded.length, 2);
  for (const [i, text] of [official, byteCounted].entries()) {
    const w = [], h = {}, d = {};
    const sync = parseADIFAuto(text, w, loaded[i].name, h, d);
    assert.deepEqual(loaded[i].parsed, sync);
    assert.deepEqual(loaded[i].warnings, w);
    assert.deepEqual(loaded[i].headerInfo, h);
    assert.deepEqual(loaded[i].defs, d);
    const v = validateAdif(text, { lean: true, maxIssues: ADIF_LIMITS.maxIssues });
    // the check's `today` is the current day in both
    assert.deepEqual(loaded[i].result, v);
  }
});

test('loadLogFiles: progress counts up to 100 % and names what it does', async () => {
  const seen = [];
  await loadLogFiles([file('a.adi', official), file('b.adi', official)], { ...quick, onProgress: p => seen.push(p) });
  assert.ok(seen.length > 4);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].pct >= seen[i - 1].pct, 'monotonic');
  assert.ok(seen.at(-1).pct >= 90 && seen.at(-1).pct <= 100);
  assert.ok(seen.some(p => /Reading a\.adi: [\d,]+ QSOs read/.test(p.text)));
  assert.ok(seen.some(p => /Checking b\.adi: [\d,]+ of [\d,]+ QSOs/.test(p.text)));
  assert.ok(seen.every(p => /^File [12] of 2: /.test(p.text)));
});

test('loadLogFiles: cancelling rejects with AbortError and returns nothing (even of finished files)', async () => {
  const signal = { aborted: false };
  const seen = [];
  const p = loadLogFiles([file('a.adi', official), file('b.adi', official)], {
    ...quick, signal,
    onProgress: pr => { seen.push(pr); if (pr.file === 2 && pr.pct > 55) signal.aborted = true; },
  });
  await assert.rejects(p, e => chunkedIsAbort(e));
  assert.ok(seen.some(pr => pr.file === 2), 'the first file was done when it was cancelled');
});

test('loadLogFiles: a cancelled load does not touch a log it was given', async () => {
  const log = parseADIF(official, []);
  const snapshot = JSON.stringify(log);
  const signal = { aborted: true };
  await assert.rejects(loadLogFiles([file('a.adi', official)], { ...quick, signal, existing: { records: log.length, fields: 1 } }), e => chunkedIsAbort(e));
  assert.equal(JSON.stringify(log), snapshot);
});

test('limits: a file over the size limit is skipped with a message, the others load', async () => {
  const big = { name: 'big.adi', size: 5 * 1024 * 1024, arrayBuffer: async () => { throw new Error('must not be read'); } };
  const { loaded, skipped } = await loadLogFiles([big, file('ok.adi', byteCounted)], { ...quick, limits: { maxFileBytes: 1024 * 1024 } });
  assert.deepEqual(loaded.map(f => f.name), ['ok.adi']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].message, /^big\.adi: not loaded, the file is 5 MB, the editor takes up to 1 MB per file\..*log is unchanged/);
});

test('limits: too many QSOs, counting what the log already holds', async () => {
  const text = Array.from({ length: 10 }, () => '<CALL:3>ABC<EOR>').join('\n');
  let r = await loadLogFiles([file('x.adi', text)], { ...quick, limits: { maxRecords: 9 } });
  assert.equal(r.loaded.length, 0);
  assert.match(r.skipped[0].message, /more than 9 QSOs \(at QSO 10\)/);
  r = await loadLogFiles([file('x.adi', text)], { ...quick, limits: { maxRecords: 15 }, existing: { records: 6, fields: 0 } });
  assert.equal(r.loaded.length, 0);
  assert.match(r.skipped[0].message, /more than 15 QSOs/);
  r = await loadLogFiles([file('x.adi', text)], { ...quick, limits: { maxRecords: 15 }, existing: { records: 5, fields: 0 } });
  assert.equal(r.loaded[0].parsed.length, 10);
});

test('limits: too many field values, an oversized value, an oversized QSO, too many columns', async () => {
  const text = '<CALL:3>ABC<BAND:3>20m<EOR>\n<CALL:3>DEF<BAND:3>40m<EOR>\n';
  let r = await loadLogFiles([file('x.adi', text)], { ...quick, limits: { maxFields: 3 } });
  assert.match(r.skipped[0].message, /more than 3 field values/);
  r = await loadLogFiles([file('x.adi', `<COMMENT:10>${'x'.repeat(10)}<EOR>`)], { ...quick, limits: { maxValueChars: 10 } });
  assert.equal(r.loaded.length, 1, 'a value exactly at the limit is fine');
  r = await loadLogFiles([file('x.adi', `<CALL:3>ABC<NOTES:5000>${'x'.repeat(5000)}<EOR>`)], { ...quick, limits: { maxValueChars: 1000 } });
  assert.match(r.skipped[0].message, /NOTES in QSO 1 has 5,000 characters, the editor takes values up to 1,000/);
  r = await loadLogFiles([file('x.adi', '<A:1>1<B:1>2<C:1>3<EOR>')], { ...quick, limits: { maxFieldsPerRecord: 2 } });
  assert.match(r.skipped[0].message, /QSO 1 has more than 2 fields/);
  r = await loadLogFiles([file('x.adi', '<A:1>1<EOR><B:1>2<EOR><C:1>3<EOR>')], { ...quick, limits: { maxColumns: 2 } });
  assert.match(r.skipped[0].message, /more than 2 different field names/);
});

test('limits: different field names count together over the files and with the log', async () => {
  const one = file('1.adi', '<A:1>1<B:1>2<EOR>'), two = file('2.adi', '<B:1>2<C:1>3<EOR>'), three = file('3.adi', '<D:1>4<EOR>');
  let r = await loadLogFiles([one, two, three], { ...quick, limits: { maxColumns: 3 } });
  assert.deepEqual(r.loaded.map(f => f.name), ['1.adi', '2.adi'], 'A B C fit, D is one too many');
  assert.match(r.skipped[0].message, /^3\.adi: not loaded, it has more than 3 different field names/);
  r = await loadLogFiles([two], { ...quick, limits: { maxColumns: 3 }, existing: { records: 1, fields: 2, columns: ['A', 'X'] } });
  assert.equal(r.loaded.length, 0, 'X A + B C = 4 names');
});

test('limits: the actual value counts, not a declared length past the end of the file', () => {
  const run = (text, limits) => { const gen = parseADIFAutoSteps(text, [], 'x', {}, {}, limits); let r; do r = gen.next(); while (!r.done); return r.value; };
  assert.throws(() => run(`<NOTES:500>${'x'.repeat(500)}<EOR>`, { maxValueChars: 100 }), e => e instanceof AdifLimitError && e.code === 'VALUE' && e.length === 500);
  // a truncated file: bogus huge declared length, 5 real characters
  assert.equal(run('<CALL:3>ABC<EOR><NOTES:99999999>short', { maxValueChars: 100 }).length, 2);
});

test('limits apply before the second reading of a non-ASCII file, and the validator reuses the detection', async () => {
  const text = '<CALL:5>OE1AB<NAME:7>Jürgen<EOR>\n'.repeat(50); // lengths count UTF-8 bytes
  const r = await loadLogFiles([file('u.adi', text)], { ...quick, limits: { maxRecords: 10 } });
  assert.equal(r.loaded.length, 0);
  assert.match(r.skipped[0].message, /more than 10 QSOs/);
  // the detection is told to the validator: same result as detecting itself
  const lim = { maxRecords: 100 };
  const gen = parseADIFAutoSteps(text, [], 'x', {}, {}, lim);
  for (let q = gen.next(); !q.done; q = gen.next());
  assert.equal(lim.countsBytes, true);
  assert.deepEqual(await chunkedRun(validateAdifSteps(text, { today: TODAY, bytesMode: true }), everyStep), validateAdif(text, { today: TODAY }));
});

test('a cancel in the last slice of the last file does not apply', async () => {
  // a tiny file runs in one slice: the signal is read before reading, after
  // reading, at the start of the slice; it flips to "cancelled" on the 4th
  // read, i.e. once the work is done and the result is about to be handed out
  let reads = 0;
  const signal = { get aborted() { return ++reads > 3; } };
  await assert.rejects(loadLogFiles([file('a.adi', '<CALL:3>ABC<EOR>')], { ...quick, budget: 1000, signal }), e => chunkedIsAbort(e));
});

test('maxIssues keeps issues of both phases when the structure has many', () => {
  const syntax = Array.from({ length: 40 }, () => '<BROKEN>x').join('\n');
  const text = `${syntax}\n<CALL:3>ABC<QSO_DATE:8>20241301<EOR>\n`;
  const full = validateAdif(text, { today: TODAY });
  const capped = validateAdif(text, { today: TODAY, maxIssues: 10 });
  assert.ok(capped.issues.some(i => i.recordType === 'qso'), 'a QSO issue survives');
  assert.ok(capped.issues.some(i => i.recordType !== 'qso'));
  for (const k of ['errors', 'warnings', 'infos']) assert.equal(capped[k], full[k]);
});

test('chunked equals sync on CRLF text and on a multi-file merge of defs', async () => {
  const crlf = official.replace(/\r?\n/g, '\r\n');
  assert.deepEqual(await chunkedRun(validateAdifSteps(crlf, { today: TODAY }), everyStep), validateAdif(crlf, { today: TODAY }));
  const a = '<ADIF_VER:5>3.1.7\n<USERDEF1:6:N>FOO_X\n<EOH>\n<CALL:3>ABC<FOO_X:1:N>1<APP_T_Y:1:N>2<EOR>\n';
  const b = '<ADIF_VER:5>3.1.7\n<USERDEF1:12:N>FOO_X,{1:9}\n<EOH>\n<CALL:3>DEF<FOO_X:1:N>3<EOR>\n';
  const { loaded } = await loadLogFiles([file('a.adi', a), file('b.adi', b)], quick);
  for (const [i, t] of [a, b].entries()) {
    const d = {}; const recs = parseADIFAuto(t, [], loaded[i].name, {}, d);
    assert.deepEqual(loaded[i].parsed, recs); assert.deepEqual(loaded[i].defs, d);
  }
});

test('limits: an unreadable file is reported, the others load', async () => {
  const bad = { name: 'bad.adi', size: 10, arrayBuffer: async () => { throw new Error('disk gone'); } };
  const { loaded, skipped } = await loadLogFiles([bad, file('ok.adi', byteCounted)], quick);
  assert.equal(loaded.length, 1);
  assert.equal(skipped[0].message, 'bad.adi: could not be read (disk gone).');
});

test('the limits message names the limit and says the log is unchanged', () => {
  const m = adifLimitMessage('f.adi', new AdifLimitError('RECORDS', 'x', { limit: ADIF_LIMITS.maxRecords, at: 500001 }));
  assert.match(m, /^f\.adi: not loaded, the log would have more than 500,000 QSOs \(at QSO 500,001\)/);
  assert.match(m, /The log is unchanged/);
});

/* ---------- review findings on PR #34 ---------- */

test('limits: a final QSO without <EOR> counts against the record ceiling', async () => {
  const text = '<CALL:3>ABC<EOR><CALL:3>DEF';
  let r = await loadLogFiles([file('x.adi', text)], { ...quick, limits: { maxRecords: 1 } });
  assert.equal(r.loaded.length, 0);
  assert.match(r.skipped[0].message, /more than 1 QSOs \(at QSO 2\)/);
  r = await loadLogFiles([file('x.adi', text)], { ...quick, limits: { maxRecords: 2 } });
  assert.equal(r.loaded[0].parsed.length, 2, 'two fit');
  // the log is at its ceiling: not even one unterminated record
  r = await loadLogFiles([file('y.adi', '<CALL:3>ABC')], { ...quick, limits: { maxRecords: 5 }, existing: { records: 5, fields: 0 } });
  assert.equal(r.loaded.length, 0);
  assert.match(r.skipped[0].message, /more than 5 QSOs/);
  r = await loadLogFiles([file('y.adi', '<CALL:3>ABC')], { ...quick, limits: { maxRecords: 5 }, existing: { records: 4, fields: 0 } });
  assert.equal(r.loaded[0].parsed.length, 1);
});

test('limits: malformed input keeps few warnings and issues, says how many were left out, and hands back', async () => {
  const text = '<BROKEN>'.repeat(10000) + '<CALL:3>ABC<EOR>';
  const r = await loadLogFiles([file('m.adi', text)], { ...quick, limits: { maxIssues: 10, maxWarnings: 5 } });
  const f = r.loaded[0];
  assert.ok(f.warnings.length <= 6, `parser warnings capped (${f.warnings.length})`);
  assert.match(f.warnings.at(-1), /9995 further warning\(s\)/);
  assert.ok(f.result.issues.length <= 10);
  assert.ok(f.result.errors >= 10000, 'all of them are still counted');
  assert.ok(f.result.issuesDropped >= 9990);
  assert.equal(f.parsed.length, 1);
  assert.equal(f.result.errors, validateAdif(text, { today: TODAY }).errors, 'the same counts as without a cap');
  // the scanner yields by scanned work: no tokens at all here
  const gen = validateAdifSteps('<BROKEN>'.repeat(20000), { today: TODAY });
  let scans = 0;
  for (let q = gen.next(); !q.done; q = gen.next()) if (q.value.phase === 'scan') scans++;
  assert.ok(scans >= 4, `scan yielded ${scans} times`);
});

test('non-ASCII length detection builds no records and enforces the limits', async () => {
  const text = '<ADIF_VER:5>3.1.7\nä\n<EOH>\n' + '<CALL:5>OE1AB<NOTES:3>abc<EOR>\n'.repeat(2000);
  let slices = 0;
  const orig = String.prototype.slice;
  String.prototype.slice = function (...a) { slices++; return orig.apply(this, a); };
  try { assert.equal(adifCountsBytes(text), false); } finally { String.prototype.slice = orig; }
  assert.ok(slices < 50, `detection sliced ${slices} values out`);
  assert.throws(() => adifCountsBytes(text, { maxRecords: 1 }), e => e instanceof AdifLimitError && e.code === 'RECORDS');
  const r = await loadLogFiles([file('n.adi', text)], { ...quick, limits: { maxRecords: 1 } });
  assert.match(r.skipped[0].message, /more than 1 QSOs/);
});

test('limits: maxValueChars counts decoded characters, also for byte-counted lengths', async () => {
  // NOTES:4 = 4 bytes = "ää" (2 characters)
  let r = await loadLogFiles([file('b.adi', '<NOTES:4>ää<EOR>')], { ...quick, limits: { maxValueChars: 3 } });
  assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
  assert.equal(r.loaded[0].parsed[0].NOTES, 'ää');
  r = await loadLogFiles([file('b.adi', '<NOTES:4>ää<EOR>')], { ...quick, limits: { maxValueChars: 1 } });
  assert.match(r.skipped[0].message, /NOTES in QSO 1 has 2 characters, the editor takes values up to 1/);
  // production cap: 60 000 characters (120 000 bytes) are fine, 100 001 are not
  r = await loadLogFiles([file('b.adi', `<CALL:3>ABC<NOTES:120000>${'ä'.repeat(60000)}<EOR>`)], { ...quick });
  assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
  assert.equal(r.loaded[0].parsed[0].NOTES.length, 60000);
  r = await loadLogFiles([file('b.adi', `<CALL:3>ABC<NOTES:200002>${'ä'.repeat(100001)}<EOR>`)], { ...quick });
  assert.match(r.skipped[0].message, /has 100,001 characters/);
  r = await loadLogFiles([file('b.adi', '<NOTES:2>ää<EOR>')], { ...quick, limits: { maxValueChars: 2 } });
  assert.equal(r.loaded.length, 1, 'lengths counted as characters work as before');
});

test('a flood of <EOH> tags is counted, not kept as tokens', () => {
  const text = '<ADIF_VER:5>3.1.7<EOH>' + '<EOH>'.repeat(50000) + '<CALL:3>ABC<EOR>';
  const full = validateAdif(text, { today: TODAY });
  assert.equal(full.errors, 50000, 'every second <EOH> is an error');
  let pushes = 0;
  const orig = Array.prototype.push;
  Array.prototype.push = function (...a) { pushes++; return orig.apply(this, a); };
  let capped;
  try { capped = validateAdif(text, { today: TODAY, maxIssues: 10, lean: true }); } finally { Array.prototype.push = orig; }
  assert.ok(pushes < 5000, `${pushes} array pushes`);
  assert.equal(capped.errors, 50000);
  assert.ok(capped.issues.length <= 10);
  assert.equal(capped.issuesDropped, capped.errors + capped.warnings + capped.infos - capped.issues.length);
  assert.equal(capped.records.length, 1);
});
