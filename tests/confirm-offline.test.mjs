// The confirmation log must work 100% offline: no runtime reference to any
// external host, and the single-file bundle must build and parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const OE1EBG = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(OE1EBG, 'docs', 'confirm');
const GENERATED = new Set(['confirm-offline.html', 'precache.js']);

function walk(d) {
  return readdirSync(d).flatMap(n => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? (n === 'data' ? [] : walk(p)) : [p];
  });
}

test('no external URLs in shipped confirm sources', () => {
  const offenders = [];
  for (const p of walk(DIR)) {
    const name = p.slice(DIR.length + 1);
    if (GENERATED.has(name) || !/\.(js|html|webmanifest|svg|css)$/.test(name)) continue;
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)) {
      // XML namespace in the SVG is an identifier, not a request.
      if (m[0] === 'http://www.w3.org/2000/svg') continue;
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('offline bundle builds into one self-contained, parseable file', () => {
  execFileSync('python3', [join(OE1EBG, 'scripts', 'build_confirm.py')], { stdio: 'pipe' });
  const html = readFileSync(join(DIR, 'confirm-offline.html'), 'utf8');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+href="(?!data:)/.test(html), 'no external links');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // app bundle, plus the inlined data/ files when they have been built
  const hasData = existsSync(join(DIR, 'data')) && readdirSync(DIR + '/data').some(n => n.endsWith('.json'));
  assert.equal(scripts.length, hasData ? 2 : 1);
  const app = scripts[scripts.length - 1];
  assert.ok(!/^\s*(import|export)\b/m.test(app));
  for (const src of scripts) new vm.Script(src); // throws on syntax errors
  if (hasData) assert.match(scripts[0], /^\s*globalThis\.CONFIRM_DATA = \{/);
  assert.ok(existsSync(join(DIR, 'precache.js')));
  const pre = readFileSync(join(DIR, 'precache.js'), 'utf8');
  assert.match(pre, /version: "[0-9a-f]{12}"/);
  for (const f of ['"./"', '"index.html"', '"js/app.js"', '"confirm-offline.html"', '"manifest.webmanifest"']) assert.ok(pre.includes(f), f);
  assert.ok(!pre.includes('"sw.js"'));
});
