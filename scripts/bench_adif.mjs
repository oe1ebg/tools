// Benchmark of the ADIF editor's pure hot paths (node, no DOM): parse,
// validate, serialize and the edit loop's serialize + validate, on the
// official ADIF test QSOs (tests/fixtures/adif-spec/test-qsos.adi) and on a
// synthetic log of 50 000 QSOs built from them. The numbers before and after
// the performance work are in tools/adif/README.md ("Performance").
//
//   node scripts/bench_adif.mjs [runs] [sizes]   (default: 5 runs, median shown;
//   sizes: comma list of synthetic log sizes, default 1000,10000,50000,100000;
//   `node --expose-gc` also reports the heap kept by the parsed log)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseADIFAuto } from '../tools/shared/js/adif.js';
import { validateAdif, validateAdifSteps } from '../tools/shared/js/adif-validate.js';
import { chunkedRun } from '../tools/shared/js/chunked.js';
import { serializeADIF, adifChangedValues } from '../tools/adif/js/export.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'tests', 'fixtures', 'adif-spec', 'test-qsos.adi'), 'utf8');
const RUNS = Number(process.argv[2]) || 5;
const TODAY = '20991231';
const STAMP = '2026-01-01T00:00:00Z';

function columnsOf(records) {
  const seen = new Set();
  for (const r of records) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

function median(fn) {
  const times = [];
  let out;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    out = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { ms: times[times.length >> 1], out };
}

function bench(label, text) {
  const parse = median(() => parseADIFAuto(text, [], label, {}));
  const records = parse.out;
  const columns = columnsOf(records);
  const validate = median(() => validateAdif(text, { today: TODAY }));
  const leanValidate = median(() => validateAdif(text, { today: TODAY, lean: true }));
  const serialize = median(() => serializeADIF(records, columns, STAMP));
  const changed = median(() => adifChangedValues(records, columns));
  const revalidate = median(() => validateAdif(serializeADIF(records, columns, STAMP), { today: TODAY }));
  const row = (name, m) => console.log(`  ${name.padEnd(32)} ${m.ms.toFixed(1).padStart(9)} ms`);
  console.log(`${label}: ${records.length} QSOs, ${columns.length} fields, ${(text.length / 1048576).toFixed(1)} MB`);
  row('parse (parseADIFAuto)', parse);
  row('validate (validateAdif)', validate);
  row('validate, lean (the editor)', leanValidate);
  row('serialize (serializeADIF)', serialize);
  row('adifChangedValues', changed);
  row('edit loop (serialize + validate)', revalidate);
  console.log(`  issues: ${validate.out.issues.length}`);
  if (globalThis.gc) {
    // heap kept by the parsed records and by one validation result
    gc(); const h0 = process.memoryUsage().heapUsed;
    const keep = parseADIFAuto(text, [], label, {});
    gc(); const h1 = process.memoryUsage().heapUsed;
    let res = validateAdif(text, { today: TODAY });
    gc(); const h2 = process.memoryUsage().heapUsed;
    const nIssues = res.issues.length;
    res = null; gc(); const h3 = process.memoryUsage().heapUsed;
    // the editor's lean result (records keep no fields; options.lean)
    const lean = validateAdif(text, { today: TODAY, lean: true });
    gc(); const h4 = process.memoryUsage().heapUsed;
    console.log(`  heap: parsed records ${((h1 - h0) / 1048576).toFixed(0)} MB, + validation result ${((h2 - h1) / 1048576).toFixed(0)} MB (${keep.length} records, ${nIssues} issues), lean result ${((h4 - h3) / 1048576).toFixed(0)} MB (${lean.records.length} records), peak RSS so far ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
  }
}

bench('test-qsos.adi', SOURCE);

// Synthetic logs: the official QSOs repeated (CALL varied so they differ).
const base = parseADIFAuto(SOURCE, [], 'test-qsos.adi', {});
const SIZES = (process.argv[3] || '1000,10000,50000,100000').split(',').map(Number);
for (const n of SIZES) {
  const big = [];
  for (let i = 0; big.length < n; i++) {
    const r = { ...base[i % base.length] };
    if (r.CALL) r.CALL = `${r.CALL}${i % 10}`.slice(0, 13);
    big.push(r);
  }
  bench(`synthetic ${n}`, serializeADIF(big, columnsOf(big), STAMP));
}
