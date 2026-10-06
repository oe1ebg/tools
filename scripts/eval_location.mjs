// Gold-set evaluation of the offline location lookup: hit rate per category
// and the auto-select guards from tests/location-goldset.txt, against the
// real generated data. `just eval-location` prints the table (add -v for every
// failing case); tests/location-goldset.test.mjs enforces the minimums.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLocationIndex, locate } from '../tools/shared/js/location/index.js';
import { distanceMeters } from '../tools/shared/js/geo.js';

const here = p => fileURLToPath(new URL(p, import.meta.url));
export const GOLDSET = here('../tests/location-goldset.txt');
export const DATA = here('../tools/shared/data/vienna-locations.json');
export const AREAS = here('../tools/shared/data/austria-areas.json');

export function haveRealData() {
  return existsSync(DATA);
}

export function loadRealIndex() {
  const areas = existsSync(AREAS) ? JSON.parse(readFileSync(AREAS, 'utf8')) : undefined;
  return buildLocationIndex(JSON.parse(readFileSync(DATA, 'utf8')), areas);
}

// -> { cases: [{category, query, expect, rank, flags, line}], minimums: Map, maxWrongAuto }
export function loadGoldset(path = GOLDSET) {
  const cases = [], minimums = new Map();
  let maxWrongAuto = Infinity;
  readFileSync(path, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const min = /^min\s+(\S+)\s+([\d.]+)$/.exec(line);
    if (min) { minimums.set(min[1], +min[2]); return; }
    const mw = /^max-wrong-auto\s+(\d+)$/.exec(line);
    if (mw) { maxWrongAuto = +mw[1]; return; }
    const [category, query, expect, rank, flags = ''] = line.split('|').map(s => s.trim());
    if (!category || !query || !expect) throw new Error(`${path}:${i + 1}: expected "category | query | expect | rank | flags"`);
    cases.push({ category, query, expect: parseExpect(expect), rank: +rank || 1, flags: new Set(flags.split(/\s+/).filter(Boolean)), line: i + 1 });
  });
  return { cases, minimums, maxWrongAuto };
}

function parseExpect(s) {
  if (s === '-') return null;
  return s.split(/\s+OR\s+/).map(alt => {
    const m = /^@(-?[\d.]+),(-?[\d.]+)(?:\/(\d+))?$/.exec(alt);
    return m ? { lat: +m[1], lon: +m[2], radius: m[3] ? +m[3] : 400 } : { label: alt.toLowerCase() };
  });
}

export function matches(result, expect) {
  return expect.some(e => e.label !== undefined
    ? result.label.toLowerCase().includes(e.label)
    : distanceMeters(result.lat, result.lon, e.lat, e.lon) <= e.radius);
}

// One case -> { hit, autoOk, problems[] }
export function evaluateCase(idx, c) {
  const out = locate(idx, c.query);
  const problems = [];
  let hit = true;
  if (c.expect) {
    hit = out.results.slice(0, c.rank).some(r => matches(r, c.expect));
    if (!hit) problems.push(`not in top ${c.rank}`);
  }
  let autoOk = true;
  const auto = out.autoSelect;
  if ((c.flags.has('noauto') || !c.expect) && auto) {
    autoOk = false;
    problems.push(`auto-selected "${auto.label}"`);
  }
  if (c.flags.has('auto') && !(auto && c.expect && matches(auto, c.expect))) {
    autoOk = false;
    problems.push(auto ? `auto-selected "${auto.label}" instead` : 'not auto-selected');
  }
  // A confident wrong pick is the worst outcome: auto-selected, but not what was expected.
  if (auto && c.expect && !matches(auto, c.expect)) {
    autoOk = false;
    if (!problems.some(p => p.startsWith('auto-selected'))) problems.push(`auto-selected wrong "${auto.label}"`);
  }
  return { hit, autoOk, problems, top: out.results.slice(0, 3).map(r => `${r.label} [${r.type}/${r.confidence}]`) };
}

export function evaluate(idx, cases) {
  const byCat = new Map();
  const failures = [];
  let worstMs = 0;
  for (const c of cases) {
    const t = performance.now();
    const r = evaluateCase(idx, c);
    worstMs = Math.max(worstMs, performance.now() - t);
    let s = byCat.get(c.category);
    if (!s) byCat.set(c.category, (s = { n: 0, hits: 0, autoFails: 0 }));
    s.n++;
    if (r.hit) s.hits++;
    if (!r.autoOk) s.autoFails++;
    if (!r.hit || !r.autoOk) failures.push({ ...c, ...r });
  }
  return { byCat, failures, worstMs };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!haveRealData()) {
    console.error('No location data — run `just build-location` (and `just build-areas`) first.');
    process.exit(1);
  }
  const verbose = process.argv.includes('-v');
  const t0 = performance.now();
  const idx = loadRealIndex();
  const buildMs = performance.now() - t0;
  const { cases, minimums, maxWrongAuto } = loadGoldset();
  const { byCat, failures, worstMs } = evaluate(idx, cases);
  const pct = x => `${Math.round(x * 100)}%`.padStart(5);
  console.log(`category       cases   hit   min  wrong-auto`);
  let tn = 0, th = 0, ta = 0;
  for (const [cat, s] of byCat) {
    tn += s.n; th += s.hits; ta += s.autoFails;
    const min = minimums.get(cat);
    const flag = min !== undefined && s.hits / s.n < min ? '  < min' : '';
    console.log(`${cat.padEnd(14)} ${String(s.n).padStart(5)} ${pct(s.hits / s.n)} ${min === undefined ? '    -' : pct(min)} ${String(s.autoFails).padStart(11)}${flag}`);
  }
  console.log(`${'total'.padEnd(14)} ${String(tn).padStart(5)} ${pct(th / tn)}       ${String(ta).padStart(11)}${ta > maxWrongAuto ? `  > max ${maxWrongAuto}` : ''}`);
  console.log(`index build ${Math.round(buildMs)} ms, slowest lookup ${worstMs.toFixed(1)} ms, ${idx.keys.length} search keys`);
  if (verbose) {
    for (const f of failures) console.log(`\n${f.category} | ${f.query}  (line ${f.line}): ${f.problems.join('; ')}\n    ${f.top.join(' ; ') || '(nothing)'}`);
  } else if (failures.length) {
    console.log(`${failures.length} failing cases — run with -v to list them`);
  }
}
