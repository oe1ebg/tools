// Gold set (tests/location-goldset.txt) against the real generated data:
// per-category hit rates and the cap on wrong/forbidden auto-selections.
// Skipped until `just build-location` has run. Details: `just eval-location -v`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haveRealData, loadRealIndex, loadGoldset, evaluate } from '../scripts/eval_location.mjs';

test('real data: gold set', { skip: !haveRealData() && 'run `just build-location` first' }, () => {
  const { cases, minimums, maxWrongAuto } = loadGoldset();
  const { byCat, failures } = evaluate(loadRealIndex(), cases);
  const list = pred => failures.filter(pred).map(f => `  ${f.category} | ${f.query}: ${f.problems.join('; ')}`).join('\n');
  for (const [cat, min] of minimums) {
    const s = byCat.get(cat);
    assert.ok(s, `min ${cat}: no cases in that category`);
    assert.ok(s.hits / s.n >= min - 1e-9,
      `${cat}: ${s.hits}/${s.n} hits, below the minimum ${min}\n${list(f => f.category === cat && !f.hit)}`);
  }
  const wrongAuto = failures.filter(f => !f.autoOk);
  assert.ok(wrongAuto.length <= maxWrongAuto,
    `${wrongAuto.length} wrong/forbidden auto-selections (max ${maxWrongAuto})\n${list(f => !f.autoOk)}`);
});
