// Browser benchmark of the tools' responsiveness with large logs (issue #15).
// NOT part of `just e2e` / CI: run it with `just bench-ui` (needs `just build`
// first; it serves site/ itself on a private port).
//
//   node scripts/bench_ui.mjs [--runs 3] [--tool confirm,notfunk,adif]
//        [--size 200,1000,5000] [--adif-size 10000,50000]
//        [--engine chromium,webkit] [--throttle 1,4,6] [--viewport desktop,mobile]
//        [--out bench-ui.json] [--quick]
//
// Seeds realistic data straight into the tool's IndexedDB (confirm: lines of
// a log, notfunk: messages of an Einsatz) or hands the ADIF editor a generated
// file, then measures, per run (fresh browser context, fresh storage):
//   confirm   keystroke in the callsign field: sync handler time and time to
//             the next frame; save of a line -> new row in the table; scroll
//             of the page (frame deltas, frames > 50 ms); heap
//   notfunk   search typing (input -> book rebuilt -> next frame, after the
//             150 ms debounce: reported net of it), filter buttons, save of a
//             message -> book updated; scroll; heap
//   adif      file chosen -> validation shown and rows rendered; longest
//             long task during load; scroll of the virtualized table; edit
//             commit (Enter) -> next frame and -> re-checked; heap
// and always the long tasks (PerformanceObserver 'longtask': Chromium only;
// WebKit has none, so only the timings are reported there).
// CPU throttling uses CDP (Chromium only); WebKit runs unthrottled.
// A measured operation must show its observable result (new row, edited cell,
// finished re-check) within a timeout, else the run FAILS: its samples are
// dropped, the tables show ERROR and the script exits 1. `--selftest` runs a
// small configuration with the save/edit disabled and passes only if that
// is detected.
// Results: a JSON file (--out) and Markdown tables on stdout (median / p95 /
// max over all samples of all runs).
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- arguments
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const quick = args.includes('--quick');
const list = (name, dflt) => String(opt(name, dflt)).split(',').map(s => s.trim()).filter(Boolean);
const RUNS = Number(opt('runs', quick ? 1 : 3));
const TOOLS = list('tool', 'confirm,notfunk,adif');
const SIZES = list('size', quick ? '200,1000' : '200,1000,5000').map(Number);
const ADIF_SIZES = list('adif-size', quick ? '10000' : '10000,50000').map(Number);
const ENGINES = list('engine', 'chromium,webkit');
const THROTTLES = list('throttle', quick ? '1,4' : '1,4,6').map(Number);
const VIEWPORTS = list('viewport', 'desktop,mobile');
const OUT = opt('out', join(ROOT, 'bench-ui.json'));
const KEY_REPS = quick ? 3 : 6;
const NOOP = process.env.BENCH_INJECT_NOOP === '1'; // selftest: saves and edits are disabled
const NOSEARCH = process.env.BENCH_INJECT_NOSEARCH === '1'; // selftest: the notfunk search handler is disabled
const INJECT_ERROR = process.env.BENCH_INJECT_ERROR === '1'; // selftest: an uncaught error shortly after load

// Errors that are known artifacts of this benchmark, matched exactly (anything
// else in the page's error log fails the run):
//  - service workers are blocked (isolation from the precache), so the
//    registration in tools/shared/js/offline.js yields no `reg`;
//  - WebKit aborts the lazy location-data fetch when the seeding step reloads
//    the page.
const KNOWN_PAGE_ERRORS = [
  /^Cannot read properties of undefined \(reading 'addEventListener'\)$/, // Chromium (checked against the stack below)
  /^undefined is not an object \(evaluating 'reg\.addEventListener'\)$/, // WebKit
  /^(Fetch API cannot load http:\s*)?\/*127\.0\.0\.1:\d+\/tools\/shared\/data\/(vienna-locations|austria-areas)\.json due to access control checks\.$/,
];
function unexpectedError(err) {
  const msg = String(err?.message ?? err).replace(/\s+/g, ' ').trim().replace(/^Unhandled Promise Rejection: (\w*Error: )?/, '').replace(/^TypeError: /, '');
  const known = KNOWN_PAGE_ERRORS.some(re => re.test(msg));
  if (!known) return true;
  // the Chromium variant only counts as known when it comes from offline.js
  return /^Cannot read properties/.test(msg) && err?.stack && !/offline\.js/.test(err.stack);
}

if (args.includes('--selftest')) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tool', 'notfunk,adif', '--size', '200', '--adif-size', '10000',
    '--engine', 'chromium', '--throttle', '1', '--viewport', 'desktop', '--runs', '1', '--out', join(tmpdir(), 'bench-ui-selftest.json')],
  { env: { ...process.env, BENCH_INJECT_NOOP: '1' }, encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  const ok1 = r.status === 1 && /notfunk 200 ERROR/.test(out) && /adif 10000 ERROR/.test(out);
  const r2 = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tool', 'notfunk', '--size', '200', '--engine', 'chromium',
    '--throttle', '1', '--viewport', 'desktop', '--runs', '1', '--out', join(tmpdir(), 'bench-ui-selftest.json')],
  { env: { ...process.env, BENCH_INJECT_ERROR: '1' }, encoding: 'utf8' });
  const out2 = r2.stdout + r2.stderr;
  const ok2 = r2.status === 1 && /notfunk 200 ERROR/.test(out2) && /BENCH_SELFTEST_RUNTIME_ERROR/.test(out2);
  const r3 = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tool', 'notfunk', '--size', '200', '--engine', 'chromium',
    '--throttle', '1', '--viewport', 'desktop', '--runs', '1', '--out', join(tmpdir(), 'bench-ui-selftest.json')],
  { env: { ...process.env, BENCH_INJECT_NOSEARCH: '1' }, encoding: 'utf8' });
  const out3 = r3.stdout + r3.stderr;
  const ok3 = r3.status === 1 && /notfunk 200 ERROR/.test(out3) && /search "[^"]*": the book did not show/.test(out3);
  console.log(ok1 && ok2 && ok3 ? 'selftest ok: disabled save/edit, a disabled search handler and an injected page error were detected, exit code 1 each'
    : `selftest FAILED (operations: ${ok1 ? 'ok' : `exit ${r.status}\n${out}`}; page error: ${ok2 ? 'ok' : `exit ${r2.status}\n${out2}`}; search: ${ok3 ? 'ok' : `exit ${r3.status}\n${out3}`})`);
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
}

// ---- Playwright (installed by `just bench-ui` into tests/e2e/node_modules)
const pwPath = join(ROOT, 'tests', 'e2e', 'node_modules', '@playwright', 'test', 'index.mjs');
if (!existsSync(pwPath)) {
  console.error('Playwright is missing: run `just bench-ui` (installs it into tests/e2e/node_modules).');
  process.exit(2);
}
const { chromium, webkit, devices } = await import(pathToFileURL(pwPath).href);

// ---- static server: tests/e2e/serve.py (the headers of deploy/nginx.conf.example)
async function freePort() {
  return new Promise(resolve => {
    const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const port = await freePort();
const server = spawn('python3', [join(ROOT, 'tests', 'e2e', 'serve.py'), join(ROOT, 'site'), String(port)], { stdio: 'ignore' });
process.on('exit', () => server.kill());
const BASE = `http://127.0.0.1:${port}/tools/`;
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 100));
}

// ---- seeded pseudo-random data (the same on every run)
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
function callsign(r) {
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return `OE${1 + Math.floor(r() * 9)}${L[Math.floor(r() * 26)]}${L[Math.floor(r() * 26)]}${L[Math.floor(r() * 26)]}`;
}
const PLACES = ['Wien 1220, Wagramer Str.', 'Mödling', 'Klosterneuburg', 'Wien 1100', 'Baden bei Wien', 'Schwechat', 'Tulln', 'St. Pölten Hbf', 'Wien 1010, Stephansplatz', 'Korneuburg'];
const NAMES = ['Karl', 'Maria', 'Franz', 'Eva', 'Josef', 'Anna', 'Peter', 'Helga'];

function confirmSeed(n) {
  const r = rng(15);
  const eventId = 'bench-event';
  const t0 = Date.now() - n * 20_000;
  const pool = Array.from({ length: Math.max(20, Math.round(n * 0.6)) }, () => callsign(r));
  const header = { operator: 'OE1EBG', station: 'OE1EBG', freq: '145.500', mode: 'FM', myGrid: 'JN88', myQth: 'Wien', viaRepeater: false, repeaterCall: '', repeaterFreq: '', repeaterShift: '', repeaterTone: '', dcs: '', colorCode: '', timeslot: '', talkgroup: '', dgid: '', dstarModule: '', can: '' };
  const snap = Object.fromEntries(['operator', 'station', 'freq', 'mode', 'myGrid', 'myQth', 'repeaterCall', 'repeaterFreq', 'repeaterShift', 'repeaterTone', 'dcs', 'colorCode', 'timeslot', 'talkgroup', 'dgid', 'dstarModule', 'can'].map(k => [k, header[k] ?? '']));
  const now = new Date().toISOString();
  const entries = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(t0 + i * 20_000).toISOString();
    entries.push({
      id: `bench-e${i}`, eventId, seq: i + 1, ts, call: pick(r, pool),
      fields: { rst_rcvd: pick(r, ['59', '57', '55', '45']), rst_sent: '59', name: pick(r, NAMES), qth: pick(r, PLACES) },
      loc: null, viaRepeater: r() < 0.3, note: r() < 0.2 ? 'Rundspruch gehört, gute Verbindung' : '',
      snap: { ...snap }, created: ts, updated: ts, deleted: null,
    });
  }
  const event = { id: eventId, title: `Benchmark ${n}`, template: 'rst', header, created: now, updated: now, nextSeq: n + 1, archived: false, deleted: null, exportedTotal: 0 };
  return { event, entries, eventId };
}

const { newMessage, setStatus, filterMessages } = await import(pathToFileURL(join(ROOT, 'tools', 'notfunk', 'js', 'model.js')).href);
const { counterKey, formatNumber } = await import(pathToFileURL(join(ROOT, 'tools', 'notfunk', 'js', 'numbering.js')).href);
const LOREM = ['Lage am Einsatzort unverändert, Zufahrt über die B3 gesperrt, Umleitung eingerichtet.', 'Stromausfall im Bereich Nord, Notstromaggregat im Einsatz, Treibstoff für sechs Stunden vorhanden.',
  'Anforderung: zwei Funkgeräte 2 m, ein Satz Akkus, Rückmeldung an den Stab bis 18:00.', 'Brücke Kilometer 12 gesperrt, Hochwasserstand steigt, Pegel 4,2 m, weitere Meldung in 30 Minuten.',
  'Verbindung zur Meldesammelstelle über Relais OE1XUU hergestellt, Signal gut, keine Störungen.', 'Verletztenmeldung: drei Personen versorgt, Transport mit Rettung erfolgt, Einsatzleiter informiert.'];
const SUBJECTS = ['Lagemeldung Nord', 'Anforderung Material', 'Straße gesperrt', 'Stromausfall', 'Pegelstand', 'Funkverbindung', 'Personenschaden'];
function notfunkSeed(n) {
  const r = rng(11);
  const opId = 'bench-op';
  const t0 = Date.now() - n * 60_000;
  const op = { id: opId, name: `Benchmark ${n}`, prefix: 'W1', call: 'OE1EBG', station: 'Wien', operator: 'OE1EBG', home: 'Stab', freq: '145.500', via: 'OE1XUU', created: new Date(t0).toISOString(), updated: new Date(t0).toISOString(), archived: false, deleted: null };
  const messages = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(t0 + i * 60_000).toISOString();
    const dir = r() < 0.55 ? 'in' : 'out';
    const fields = {
      direction: dir, ts: at, channel: pick(r, ['funk', 'funk', 'funk', 'telefon', 'melder']), radio: { freq: '145.500', via: r() < 0.5 ? 'OE1XUU' : '' },
      peer: callsign(r), type: pick(r, ['meldung', 'meldung', 'auftrag', 'frage', 'lagemeldung']), priority: pick(r, ['routine', 'routine', 'routine', 'priority', 'emergency']),
      from: { name: pick(r, ['FF Floridsdorf', 'Einsatzleiter', 'Stab', 'Rotes Kreuz']), call: '', contact: '' }, to: { name: 'Stab', call: '', contact: '' },
      subject: pick(r, SUBJECTS), text: `${pick(r, LOREM)} ${pick(r, LOREM)}`, stichzeit: null, origin: {}, location: null, remarks: '',
    };
    let m = newMessage(fields, { prefix: 'W1', seq: i + 1, number: formatNumber('W1', i + 1) }, { id: `bench-m${i}`, opId, operator: 'OE1EBG', stationCall: 'OE1EBG', now: at });
    const k = r();
    if (k < 0.7) m = setStatus(m, 'forwarded', { operator: 'OE1EBG', now: at });
    if (k < 0.4) m = setStatus(m, 'acknowledged', { operator: 'OE1EBG', now: at, who: 'Stab' });
    messages.push(m);
  }
  const counters = [{ id: counterKey(opId, 'W1'), eventId: opId, prefix: 'W1', last: n }];
  return { op, messages, counters, opId };
}

function adifFile(n) {
  // The official test QSOs repeated (CALL varied), as the node benchmark does.
  return import(pathToFileURL(join(ROOT, 'tools', 'shared', 'js', 'adif.js')).href).then(async ({ parseADIFAuto }) => {
    const { serializeADIF } = await import(pathToFileURL(join(ROOT, 'tools', 'adif', 'js', 'export.js')).href);
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(ROOT, 'tests', 'fixtures', 'adif-spec', 'test-qsos.adi'), 'utf8');
    const base = parseADIFAuto(src, [], 'test-qsos.adi', {});
    const recs = [];
    for (let i = 0; recs.length < n; i++) {
      const r = { ...base[i % base.length] };
      if (r.CALL) r.CALL = `${r.CALL}${i % 10}`.slice(0, 13);
      recs.push(r);
    }
    const cols = [...new Set(recs.flatMap(r => Object.keys(r)))];
    return serializeADIF(recs, cols, '2026-01-01T00:00:00Z');
  });
}

// ---- statistics
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const summarize = a => ({ n: a.length, median: pct(a, 0.5), p95: pct(a, 0.95), max: a.length ? Math.max(...a) : NaN });
const f = x => (Number.isFinite(x) ? (x >= 100 ? x.toFixed(0) : x.toFixed(1)) : '–');

// ---- in-page helpers, injected into every page
const INIT = () => {
  window.__lt = [];
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push({ s: e.startTime, d: e.duration }); }).observe({ type: 'longtask', buffered: true });
    window.__ltOk = true;
  } catch { window.__ltOk = false; }
  // time until the frame after the current work was produced
  window.__frame = () => new Promise(res => requestAnimationFrame(() => setTimeout(res, 0)));
  // frame deltas while `step(i)` runs once per animation frame
  window.__frames = (count, step) => new Promise(res => {
    const d = []; let last = performance.now(), i = 0;
    const tick = now => { d.push(now - last); last = now; if (i < count) { step(i++); requestAnimationFrame(tick); } else res(d); };
    requestAnimationFrame(tick);
  });
  window.__ltSince = t0 => window.__lt.filter(e => e.s + e.d >= t0).map(e => e.d);
};

// ---- measurement per tool; each returns { metric: [samples (ms)] }
const add = (m, k, v) => { (m[k] ||= []).push(...(Array.isArray(v) ? v : [v])); };

async function heap(page, cdp, m, label) {
  if (!cdp) return;
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const used = metrics.find(x => x.name === 'JSHeapUsedSize')?.value;
  const nodes = metrics.find(x => x.name === 'Nodes')?.value;
  if (used != null) add(m, `${label} heap MB`, used / 1048576);
  if (nodes != null) add(m, `${label} DOM nodes`, nodes);
}

async function longTasks(page, since) {
  // the longest task since `since` (0 = none): one sample per measured window
  return page.evaluate(t => (window.__ltOk ? [Math.max(0, ...window.__ltSince(t))] : []), since);
}

async function idleFrame(page, m) {
  const v = await page.evaluate(async () => {
    const o = [];
    for (let i = 0; i < 8; i++) { const t = performance.now(); await window.__frame(); o.push(performance.now() - t); }
    return o.sort((a, b) => a - b)[4];
  });
  add(m, 'idle frame ms (reference)', v);
}

async function seedIdb(page, dbName, stores) {
  await page.evaluate(async ({ dbName, stores }) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open(dbName); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const names = Object.keys(stores);
      const t = db.transaction(names, 'readwrite');
      for (const n of names) for (const rec of stores[n]) t.objectStore(n).put(rec);
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
    db.close();
  }, { dbName, stores });
}

async function scrollPage(page, m, key, target) {
  const since = await page.evaluate(() => performance.now());
  const d = await page.evaluate(async target => {
    const sc = target === 'window' ? null : document.querySelector(target);
    const h = (sc || document.documentElement).scrollHeight - (sc ? sc.clientHeight : innerHeight);
    const steps = 90, dy = Math.max(1, Math.min(60, Math.floor(h / steps)));
    const to = y => (sc ? (sc.scrollTop = y) : scrollTo(0, y));
    return window.__frames(steps, i => to((i + 1) * dy)).then(d => { to(0); return d.slice(1); });
  }, target);
  add(m, `${key} frame ms`, d);
  add(m, `${key} frames >50ms`, d.filter(x => x > 50).length);
  add(m, `${key} longest task ms`, await longTasks(page, since));
}

async function benchConfirm(page, cdp, size, m) {
  const { event, entries, eventId } = confirmSeed(size);
  await page.goto(`${BASE}confirm/`);
  await page.waitForFunction(() => globalThis.CONFIRM_READY === true);
  await seedIdb(page, 'oe1ebg-confirm', { events: [event], entries });
  await page.goto(`${BASE}confirm/#/e/${eventId}`);
  await page.reload();
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForFunction(n => document.querySelectorAll('#log-body tr[data-id]').length >= n, size);
  add(m, 'open log -> all rows ms', (await page.evaluate(() => performance.now())) - t0);
  await page.waitForFunction(() => globalThis.CONFIRM_READY === true);
  await idleFrame(page, m);
  await heap(page, cdp, m, 'open');

  // keystrokes: O, OE, OE1, ... as the user types a callsign (input event on
  // the field: updateCallFeedback -> renderLog), then cleared again
  const since = await page.evaluate(() => performance.now());
  const res = await page.evaluate(async reps => {
    const input = document.querySelector('#f-call');
    input.focus();
    const sync = [], frame = [];
    const word = 'OE1ABC';
    for (let r = 0; r < reps; r++) {
      for (let i = 1; i <= word.length; i++) {
        input.value = word.slice(0, i);
        const t = performance.now();
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: word[i - 1], inputType: 'insertText' }));
        sync.push(performance.now() - t);
        await window.__frame();
        frame.push(performance.now() - t);
      }
      input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
      await window.__frame();
    }
    return { sync, frame };
  }, KEY_REPS);
  add(m, 'keystroke handler ms', res.sync);
  add(m, 'keystroke -> next frame ms', res.frame);
  add(m, 'keystroke: longest task ms', await longTasks(page, since));

  // save of a line -> the new row is in the table
  const saves = [];
  for (let i = 0; i < Math.min(KEY_REPS, 4); i++) {
    await page.fill('#f-call', `OE9Z${String.fromCharCode(65 + i)}${String.fromCharCode(66 + i)}`);
    const ms = await page.evaluate(async () => {
      const t = performance.now();
      const before = document.querySelectorAll('#log-body tr[data-id]').length;
      const call = document.querySelector('#f-call').value;
      document.querySelector('#btn-save').click();
      // the saved line: one more row, showing the callsign
      while (document.querySelectorAll('#log-body tr[data-id]').length <= before || !document.querySelector('#log-body').textContent.includes(call)) {
        if (performance.now() - t > 30000) throw new Error(`save did not show ${call} within 30 s`);
        await new Promise(r => setTimeout(r, 0));
      }
      await window.__frame();
      return performance.now() - t;
    });
    saves.push(ms);
  }
  add(m, 'save line -> new row + frame ms', saves);
  await scrollPage(page, m, 'scroll', 'window');
  await heap(page, cdp, m, 'after use');
}

async function benchNotfunk(page, cdp, size, m) {
  const { op, messages, counters, opId } = notfunkSeed(size);
  await page.goto(`${BASE}notfunk/`);
  await page.waitForFunction(() => globalThis.NOTFUNK_READY === true);
  await seedIdb(page, 'oe1ebg-notfunk', { operations: [op], messages, counters });
  await page.goto(`${BASE}notfunk/#/e/${opId}`);
  await page.reload();
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForFunction(() => document.querySelectorAll('#book-body tr[data-id]').length > 0);
  add(m, 'open book -> rows ms', (await page.evaluate(() => performance.now())) - t0);
  await idleFrame(page, m);
  await heap(page, cdp, m, 'open');

  // search typing: input event -> (150 ms debounce) -> book rebuilt -> frame.
  // The debounce is subtracted: the number is the cost of renderBook + paint.
  // Every step is checked against the expected result (the message ids
  // model.filterMessages() gives for the query): the book must come to show
  // exactly those rows (none for no match), within 5 s, else the run fails. A
  // step that leaves the rows as they are is legitimate (e.g. "s" -> "st") and
  // is only measured by a frame after the debounce; a disabled handler is
  // caught by the first step whose result differs from what is shown.
  const terms = ['Pegel', 'Pegelstand', 'OE1', 'Funk', 'Stromausfall', 'qqqq-no-match', 's'];
  const expected = Object.fromEntries([...terms, ''].map(q => [q, filterMessages(messages, { query: q }).map(x => x.id).sort().join()]));
  if (!terms.some(q => expected[q] !== expected[''])) throw new Error('benchmark data: no search term narrows the book');
  const since = await page.evaluate(() => performance.now());
  const search = await page.evaluate(async ({ terms, expected, reps }) => {
    const input = document.querySelector('#book-search');
    const body = document.querySelector('#book-body');
    const shown = () => [...body.querySelectorAll('tr[data-id]')].map(tr => tr.dataset.id).sort().join();
    const out = [];
    const apply = async q => {
      const want = expected[q];
      const same = shown() === want;
      input.value = q;
      const t = performance.now();
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: q.slice(-1) }));
      if (same) {
        // legitimately unchanged: nothing to observe, so wait past the debounce,
        // then the frame (a long rebuild task would delay it) and verify
        await new Promise(r => setTimeout(r, 250));
        await window.__frame();
        if (shown() !== want) throw new Error(`search "${q}": the book changed to a wrong result`);
        return { built: 0, frame: Math.max(0, performance.now() - t - 250) };
      }
      while (shown() !== want) {
        if (performance.now() - t > 5000) throw new Error(`search "${q}": the book did not show the expected ${want ? want.split(',').length : 0} messages within 5 s`);
        await new Promise(r => setTimeout(r, 0));
      }
      const built = performance.now() - t - 150; // after the debounce
      await window.__frame();
      return { built, frame: performance.now() - t - 150 };
    };
    for (let r = 0; r < reps; r++) {
      for (const q of terms) out.push(await apply(q));
      await apply(''); // back to the full book (checked too)
    }
    return out;
  }, { terms, expected, reps: Math.max(2, KEY_REPS >> 1) });
  add(m, 'search: book rebuilt (after debounce) ms', search.map(x => x.built));
  add(m, 'search: -> next frame ms', search.map(x => x.frame));
  add(m, 'search: longest task ms', await longTasks(page, since));

  // filter buttons: click -> sync renderBook -> frame
  const filt = await page.evaluate(async reps => {
    const btns = [...document.querySelectorAll('#view-book [data-filter]')];
    const out = [];
    for (let r = 0; r < reps; r++) for (const b of btns) {
      const t = performance.now(); b.click(); await window.__frame(); out.push(performance.now() - t);
    }
    btns[0].click();
    return out;
  }, 2);
  add(m, 'filter click -> next frame ms', filt);

  // save of a message through the form -> the book shows it
  const saves = [];
  for (let i = 0; i < Math.min(KEY_REPS, 4); i++) {
    await page.locator('#m-dir input').first().check();
    await page.fill('#m-from', 'FF Benchmark');
    await page.fill('#m-to', 'Stab');
    await page.fill('#m-subject', `Messung ${i}`);
    await page.fill('#m-text', 'Benchmark-Meldung, Wortlaut wie übermittelt.');
    const ms = await page.evaluate(async () => {
      const t = performance.now();
      const before = document.querySelector('#book-body tr[data-id]')?.dataset.id;
      const subject = document.querySelector('#m-subject').value;
      document.querySelector('#btn-save').click();
      // the saved message: a new first row (newest first) carrying the subject
      for (;;) {
        const first = document.querySelector('#book-body tr[data-id]');
        if (first && first.dataset.id !== before && first.textContent.includes(subject)) break;
        if (performance.now() - t > 30000) throw new Error(`save did not show "${subject}" within 30 s`);
        if (document.querySelector('#btn-save-anyway:not([hidden])')) { document.querySelector('#btn-save-anyway').click(); }
        await new Promise(r => setTimeout(r, 5));
      }
      await window.__frame();
      return performance.now() - t;
    });
    saves.push(ms);
  }
  add(m, 'save message -> book updated + frame ms', saves);
  await scrollPage(page, m, 'scroll', 'window');
  await heap(page, cdp, m, 'after use');
}

async function benchAdif(page, cdp, size, m, file) {
  await page.goto(`${BASE}adif/`);
  await idleFrame(page, m);
  const since = await page.evaluate(() => {
    window.__t0 = 0;
    document.addEventListener('change', () => { window.__t0 = performance.now(); }, true);
    return performance.now();
  });
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction(() => window.__t0 && document.querySelector('#drop tbody tr[data-ri]') && document.querySelector('#validation-summary')?.textContent.trim());
  const shown = await page.evaluate(() => performance.now() - window.__t0);
  add(m, 'file chosen -> rows + validation shown ms', shown);
  const lt = await longTasks(page, since);
  add(m, 'load: longest task ms (UI blocked)', lt);
  await page.evaluate(() => window.__frame());
  await heap(page, cdp, m, 'loaded');

  await scrollPage(page, m, 'scroll', '#drop');

  // edit commit: type in a cell, Enter -> next frame; then until re-checked
  const edit = [];
  for (let i = 0; i < Math.min(KEY_REPS, 4); i++) {
    const r = await page.evaluate(async ({ i, noop }) => {
      const td = document.querySelector('#drop tbody td[data-col="COMMENT"]') || document.querySelector('#drop tbody td[contenteditable]');
      td.focus();
      td.textContent = `bench ${i}`;
      const t = performance.now();
      if (!noop) td.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const sync = performance.now() - t;
      await window.__frame();
      const frame = performance.now() - t;
      // the commit marks the log as changed: "checking…" appears at once and
      // stays until the re-check (after the 150 ms debounce) has run
      const box = document.querySelector('#validation');
      const checking = () => box.classList.contains('is-checking');
      while (!checking()) {
        if (performance.now() - t > 5000) throw new Error('edit was not committed: no re-check was scheduled within 5 s');
        await new Promise(r => setTimeout(r, 5));
      }
      while (checking()) {
        if (performance.now() - t > 120000) throw new Error('re-check did not finish within 120 s');
        await new Promise(r => setTimeout(r, 5));
      }
      const rec = td.isConnected ? td.textContent : null;
      if (rec !== null && rec !== `bench ${i}`) throw new Error(`edited cell shows "${rec}", not "bench ${i}"`);
      // the longest task while the re-check ran (Chromium: 0 = none, WebKit: not measured)
      const rechecked = performance.now() - t;
      await window.__frame(); // long-task entries are delivered a little late
      const blocked = window.__ltOk ? Math.max(0, ...window.__ltSince(t)) : null;
      return { sync, frame, rechecked, blocked };
    }, { i, noop: NOOP });
    edit.push(r);
  }
  add(m, 'edit commit handler ms', edit.map(e => e.sync));
  add(m, 'edit commit -> next frame ms', edit.map(e => e.frame));
  add(m, 'edit -> re-checked ms (incl. 150 ms debounce)', edit.map(e => e.rechecked));
  if (edit[0].blocked !== null) add(m, 'edit -> re-checked: longest task ms (UI blocked)', edit.map(e => e.blocked));
  await heap(page, cdp, m, 'after use');
}

// ---- matrix
const VIEWPORT_OPTS = {
  desktop: { viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 },
  mobile: null, // per engine: Pixel 7 (Chromium) / iPhone 13 (WebKit)
};
const results = [];
const adifFiles = new Map();
const tmp = mkdtempSync(join(tmpdir(), 'bench-ui-'));

async function run(engine, throttle, vp, tool, size) {
  const launcher = engine === 'webkit' ? webkit : chromium;
  const browser = await launcher.launch(engine === 'chromium' ? { args: ['--enable-precise-memory-info'] } : {});
  const samples = {};
  let failed = 0;
  try {
    for (let r = 0; r < RUNS; r++) {
      const runSamples = {};
      const ctxOpts = vp === 'mobile'
        ? { ...devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'] }
        : { ...VIEWPORT_OPTS.desktop };
      const ctx = await browser.newContext({ ...ctxOpts, locale: 'de-AT', timezoneId: 'Europe/Vienna', serviceWorkers: 'block' });
      await ctx.addInitScript(INIT);
      // selftest: the save buttons and form submits do nothing (document-level capture runs first)
      if (NOOP) await ctx.addInitScript(() => {
        for (const type of ['click', 'submit']) {
          document.addEventListener(type, e => { if (e.target.closest?.('#btn-save, #btn-save-anyway, #msg-form, #entry-form')) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
        }
      });
      if (NOSEARCH) await ctx.addInitScript(() => {
        document.addEventListener('input', e => { if (e.target?.id === 'book-search') e.stopImmediatePropagation(); }, true);
      });
      if (INJECT_ERROR) await ctx.addInitScript(() => { setTimeout(() => { throw new Error('BENCH_SELFTEST_RUNTIME_ERROR'); }, 1500); });
      const page = await ctx.newPage();
      const errors = []; // unexpected uncaught errors and console errors of this run
      page.on('pageerror', e => { if (unexpectedError(e)) errors.push(`pageerror: ${String(e.message || e).split('\n')[0]}`); });
      page.on('console', m => {
        if (m.type() === 'error' && unexpectedError(m.text())) errors.push(`console.error: ${m.text().split('\n')[0]}`);
      });
      let cdp = null;
      if (engine === 'chromium') {
        cdp = await ctx.newCDPSession(page);
        await cdp.send('Performance.enable');
        if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      }
      let failedThisRun = false;
      try {
        if (tool === 'confirm') await benchConfirm(page, cdp, size, runSamples);
        else if (tool === 'notfunk') await benchNotfunk(page, cdp, size, runSamples);
        else {
          if (!adifFiles.has(size)) { const p = join(tmp, `bench-${size}.adi`); writeFileSync(p, await adifFile(size)); adifFiles.set(size, p); }
          await benchAdif(page, cdp, size, runSamples, adifFiles.get(size));
        }
      } catch (e) {
        failed++; failedThisRun = true;
        console.error(`  ${engine} ${throttle}x ${vp} ${tool} ${size} run ${r + 1}: ${e.message.split('\n')[0]}`);
      }
      // unexpected page errors fail the run (once), whatever the timings look like
      if (errors.length && !failedThisRun) {
        failed++; failedThisRun = true;
        console.error(`  ${engine} ${throttle}x ${vp} ${tool} ${size} run ${r + 1}: page errors: ${errors.slice(0, 2).join(' | ')}`);
      }
      if (!failedThisRun) for (const [k, v] of Object.entries(runSamples)) add(samples, k, v);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  const row = { engine, throttle, viewport: vp, tool, size, failed, runs: RUNS, metrics: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, summarize(v)])) };
  results.push(row);
  const key = Object.keys(row.metrics).find(k => /keystroke -> |search: -> |shown|edit commit -> /.test(k));
  console.log(`${engine} ${throttle}x ${vp} ${tool} ${size}${failed ? ` ERROR: ${failed}/${RUNS} runs failed (not in the medians)` : ''}${key ? `: ${key} median ${f(row.metrics[key].median)} / p95 ${f(row.metrics[key].p95)}` : ''}`);
}

for (const engine of ENGINES) {
  for (const vp of VIEWPORTS) {
    for (const throttle of engine === 'chromium' ? THROTTLES : [1]) {
      for (const tool of TOOLS) {
        for (const size of tool === 'adif' ? ADIF_SIZES : SIZES) await run(engine, throttle, vp, tool, size);
      }
    }
  }
}

writeFileSync(OUT, JSON.stringify({ date: new Date().toISOString(), runs: RUNS, node: process.version, results }, null, 1));

// ---- Markdown tables: one per tool and metric group, median / p95 per size
const configLabel = r => `${r.engine}${r.engine === 'chromium' ? ` ${r.throttle}×` : ''} ${r.viewport}`;
for (const tool of TOOLS) {
  const rows = results.filter(r => r.tool === tool);
  const metrics = [...new Set(rows.flatMap(r => Object.keys(r.metrics)))];
  const sizes = [...new Set(rows.map(r => r.size))].sort((a, b) => a - b);
  const configs = [...new Set(rows.map(configLabel))];
  console.log(`\n### ${tool} (median / p95, ${RUNS} runs)\n`);
  for (const metric of metrics) {
    console.log(`**${metric}**\n`);
    console.log(`| config | ${sizes.join(' | ')} |\n| --- |${sizes.map(() => ' ---:').join('|')}|`);
    for (const c of configs) {
      const cells = sizes.map(s => {
        const row = rows.find(r => configLabel(r) === c && r.size === s);
        const x = row?.metrics[metric];
        const err = row?.failed ? ` ERROR (${row.failed}/${row.runs} runs failed)` : '';
        return (x ? (/heap|nodes|>50ms/.test(metric) ? f(x.median) : `${f(x.median)} / ${f(x.p95)}`) : (err ? '' : '')) + err;
      });
      console.log(`| ${c} | ${cells.join(' | ')} |`);
    }
    console.log('');
  }
}
const failedRows = results.filter(r => r.failed);
if (failedRows.length) console.error(`\nERROR: ${failedRows.length} configuration(s) had failed runs (excluded from the medians): ${failedRows.map(r => `${configLabel(r)} ${r.tool} ${r.size}`).join('; ')}`);
console.log(`raw results: ${OUT}`);
server.kill();
process.exit(failedRows.length ? 1 : 0);
