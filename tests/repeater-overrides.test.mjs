// Local corrections of the repeater list (issue #180): scripts/data_overrides.py
// applied by scripts/fetch_repeaters.py, and the committed override file.
// The Python is stdlib-only; the tests skip when no Python is there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OE1EBG = fileURLToPath(new URL('..', import.meta.url));

// Run `body` (Python, with `rec`, `correct`, `apply_overrides`, `json` in
// scope) and return what it prints as JSON; null without a Python.
function py(body) {
  const code = [
    'import json, sys',
    "sys.path.insert(0, 'scripts')",
    'from data_overrides import apply_overrides, validate',
    'from fetch_repeaters import correct, OVERRIDE_FIELDS',
    'def rec(call, band, out, inp, **kw):',
    "    r = {'call': call, 'band': band, 'out': out, 'in': inp, 'shift': round(inp - out, 4), 'ctcss': None, 'modes': ['FM'], 'status': 'active'}",
    '    r.update(kw)',
    '    return r',
    body,
  ].join('\n');
  for (const [cmd, pre] of [['python3', []], ['uv', ['run', '--no-project', 'python']]]) {
    try {
      return JSON.parse(execFileSync(cmd, [...pre, '-c', code], { cwd: OE1EBG, stdio: 'pipe', encoding: 'utf8' }));
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(String(e.stderr || e));
    }
  }
  return null;
}

const XUF = `{"match": {"call": "OE1XUF", "band": "70cm"}, "set": {"out": 438.3375, "in": 430.7375, "ctcss": 162.2, "ch": "RU667"}, "reason": "test", "date": "2026-11-06"}`;

test('an override patches single fields of the matching record and follows the shift', t => {
  const r = py(`
reps = [rec('OE1XUF', '70cm', 438.575, 430.975, ch='RU686'), rec('OE1XUF', '2m', 145.6, 145.0), rec('OE1XUU', '70cm', 438.95, 431.35)]
n, w = correct(reps, [${XUF}])
print(json.dumps({'n': n, 'w': w, 'reps': reps}))`);
  if (!r) return t.skip('no Python');
  assert.equal(r.n, 1);
  assert.deepEqual(r.w, []);
  const xuf = r.reps.find(x => x.call === 'OE1XUF' && x.band === '70cm');
  assert.equal(xuf.out, 438.3375);
  assert.equal(xuf.in, 430.7375);
  assert.equal(xuf.shift, -7.6);
  assert.equal(xuf.ctcss, 162.2);
  assert.equal(xuf.ch, 'RU667');
  assert.deepEqual(xuf.modes, ['FM'], 'other fields untouched');
  // the 2m entry of the same callsign and other repeaters are untouched
  assert.equal(r.reps.find(x => x.band === '2m').out, 145.6);
  assert.equal(r.reps.find(x => x.call === 'OE1XUU').out, 438.95);
  // still sorted by callsign, then output
  assert.deepEqual(r.reps.map(x => `${x.call} ${x.out}`), ['OE1XUF 145.6', 'OE1XUF 438.3375', 'OE1XUU 438.95']);
});

test('stale overrides warn: no match, several matches, upstream already corrected', t => {
  const r = py(`
out = {}
reps = [rec('OE1XUU', '70cm', 438.95, 431.35)]
out['none'] = correct(reps, [${XUF}])
reps = [rec('OE1XUF', '70cm', 438.575, 430.975), rec('OE1XUF', '70cm', 439.0, 431.4)]
out['several'] = correct(reps, [{"match": {"call": "oe1xuf"}, "set": {"ctcss": 162.2}, "reason": "x", "date": "2026-11-06"}])
out['severalReps'] = reps
reps = [rec('OE1XUF', '70cm', 438.3375, 430.7375, ctcss=162.2, ch='RU667')]
out['fixed'] = correct(reps, [${XUF}])
reps = [rec('OE1XUF', '70cm', 438.3375, 430.7375, ch='RU667')]
out['partly'] = correct(reps, [${XUF}])
out['partlyRep'] = reps[0]
print(json.dumps(out))`);
  if (!r) return t.skip('no Python');
  const [nNone, wNone] = r.none;
  assert.equal(nNone, 0);
  assert.match(wNone.join('\n'), /override 1 \(OE1XUF 70cm, 2026-11-06\) matches no record/);
  const [nSev, wSev] = r.several;
  assert.equal(nSev, 0);
  assert.match(wSev.join('\n'), /matches 2 records — not applied/);
  assert.ok(r.severalReps.every(x => x.ctcss === null), 'ambiguous override not applied');
  const [nFixed, wFixed] = r.fixed;
  assert.equal(nFixed, 0);
  assert.equal(wFixed.length, 1);
  assert.match(wFixed[0], /upstream already has the corrected values — no longer needed/);
  const [nPartly, wPartly] = r.partly;
  assert.equal(nPartly, 1);
  assert.equal(wPartly.length, 3, wPartly.join('\n'));
  assert.ok(['out', 'in', 'ch'].every(k => wPartly.some(w => w.includes(`upstream already has ${k}=`))));
  assert.equal(r.partlyRep.ctcss, 162.2);
});

test('malformed overrides fail the build', t => {
  const r = py(`
bad = [
  {"match": {}, "set": {"out": 1}, "reason": "x", "date": "2026-11-06"},
  {"match": {"call": "A"}, "set": {}, "reason": "x", "date": "2026-11-06"},
  {"match": {"call": "A"}, "set": {"outt": 1}, "reason": "x", "date": "2026-11-06"},
  {"match": {"call": "A"}, "set": {"out": 1}, "reason": "", "date": "2026-11-06"},
  {"match": {"call": "A"}, "set": {"out": 1}, "reason": "x", "date": "6.11.2026"},
]
errs = []
for e in bad:
    try:
        validate([e], OVERRIDE_FIELDS)
        errs.append(None)
    except ValueError as x:
        errs.append(str(x))
print(json.dumps(errs))`);
  if (!r) return t.skip('no Python');
  assert.ok(r.every(Boolean), JSON.stringify(r));
  assert.match(r[2], /unknown field\(s\) outt/);
  assert.match(r[4], /YYYY-MM-DD/);
});

test('the committed override file is valid and documented per entry', t => {
  const file = JSON.parse(readFileSync(new URL('../scripts/data/repeater-overrides.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(file.overrides) && file.overrides.length > 0);
  for (const e of file.overrides) {
    assert.ok(e.match.call, 'keyed by callsign');
    assert.ok(e.reason.length > 10);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  }
  const r = py(`
from data_overrides import load_overrides
from pathlib import Path
validate(load_overrides(Path('scripts/data/repeater-overrides.json')), OVERRIDE_FIELDS)
print('true')`);
  if (!r) return t.skip('no Python');
});
