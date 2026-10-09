// Benchmark of the ADIF editor's pure hot paths (node, no DOM): parse,
// validate, serialize and the edit loop's serialize + validate, on the
// official ADIF test QSOs (tests/fixtures/adif-spec/test-qsos.adi) and on a
// synthetic log of 50 000 QSOs built from them. The numbers before and after
// the performance work are in tools/adif/README.md ("Performance").
//
//   node scripts/bench_adif.mjs [runs]     (default: 5 runs, median shown)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseADIFAuto } from '../tools/shared/js/adif.js';
import { validateAdif } from '../tools/shared/js/adif-validate.js';
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
  const serialize = median(() => serializeADIF(records, columns, STAMP));
  const changed = median(() => adifChangedValues(records, columns));
  const revalidate = median(() => validateAdif(serializeADIF(records, columns, STAMP), { today: TODAY }));
  const row = (name, m) => console.log(`  ${name.padEnd(32)} ${m.ms.toFixed(1).padStart(9)} ms`);
  console.log(`${label}: ${records.length} QSOs, ${columns.length} fields, ${(text.length / 1048576).toFixed(1)} MB`);
  row('parse (parseADIFAuto)', parse);
  row('validate (validateAdif)', validate);
  row('serialize (serializeADIF)', serialize);
  row('adifChangedValues', changed);
  row('edit loop (serialize + validate)', revalidate);
  console.log(`  issues: ${validate.out.issues.length}`);
}

bench('test-qsos.adi', SOURCE);

// 50k QSOs: the official QSOs repeated (CALL varied so they differ).
const base = parseADIFAuto(SOURCE, [], 'test-qsos.adi', {});
const big = [];
for (let i = 0; big.length < 50000; i++) {
  const r = { ...base[i % base.length] };
  if (r.CALL) r.CALL = `${r.CALL}${i % 10}`.slice(0, 13);
  big.push(r);
}
bench('synthetic 50k', serializeADIF(big, columnsOf(big), STAMP));
