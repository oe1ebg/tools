// The Notfunk-Meldebuch must work 100% offline, like the confirmation log:
// no runtime reference to any external host, a service worker precache that
// lists everything it loads, and a single-file bundle that builds and parses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const OE1EBG = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(OE1EBG, 'tools', 'notfunk');
const SHARED_DATA = join(OE1EBG, 'tools', 'shared', 'data');
const GENERATED = new Set(['notfunk-offline.html', 'precache.js', 'build-info.js']);

// The project's Python via uv (see confirm-offline.test.mjs), else python3.
function runPython(script, env = {}) {
  const opts = { stdio: 'pipe', env: { ...process.env, ...env } };
  try {
    execFileSync('uv', ['run', '--no-project', 'python', script], { ...opts, cwd: OE1EBG });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    execFileSync('python3', [script], opts);
  }
}

function walk(d) {
  return readdirSync(d).flatMap(n => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// (The shared modules are checked by confirm-offline.test.mjs.)
test('no external URLs in shipped notfunk sources', () => {
  const offenders = [];
  for (const p of walk(DIR)) {
    const name = p.slice(DIR.length + 1);
    if (GENERATED.has(name) || !/\.(js|html|webmanifest|svg|css)$/.test(name)) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)) {
      if (m[0] === 'http://www.w3.org/2000/svg') continue; // XML namespace, not a request
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

function buildWith(sha) {
  runPython(join(OE1EBG, 'scripts', 'build_notfunk.py'), { GIT_SHA: sha });
  return {
    pre: readFileSync(join(DIR, 'precache.js'), 'utf8'),
    html: readFileSync(join(DIR, 'notfunk-offline.html'), 'utf8'),
  };
}

test('offline bundle builds into one self-contained, parseable file', () => {
  const { pre, html } = buildWith('dev');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+href="(?!data:)/.test(html), 'no external links');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const hasData = existsSync(SHARED_DATA) && readdirSync(SHARED_DATA).some(n => n.endsWith('.json'));
  // theme, load-failure fallback, (inlined data when built), app bundle
  assert.equal(scripts.length, hasData ? 4 : 3);
  assert.ok(scripts[0].includes('OE1EBG_THEME'), 'theme script inlined, first');
  assert.ok(html.includes('.pf-sheet{'), 'tool CSS (with the print layout) inlined');
  assert.ok(html.includes('.ac-pop{'), 'shared form CSS inlined');
  assert.ok(!/(vendor|shared)\//.test(html.replace(/<script>[\s\S]*?<\/script>/g, '')), 'no reference to shared files left');
  const app = scripts[scripts.length - 1];
  assert.ok(!/^\s*(import|export)\b/m.test(app));
  assert.match(app, /NOTFUNK_STARTED = true/);
  assert.match(app, /self\.NOTFUNK_BUILD = \{"commit": "dev"/);
  for (const src of scripts) new vm.Script(src); // throws on syntax errors
  assert.ok(!html.includes('<!-- NOTFUNK-LICENSES -->'));
  if (hasData) {
    const stated = Number(/mit allen Daten, ~(\d+) MB/.exec(readFileSync(join(DIR, 'index.html'), 'utf8'))[1]);
    const actual = statSync(join(DIR, 'notfunk-offline.html')).size / 1e6;
    assert.ok(Math.abs(stated - actual) < 1, `index.html says ~${stated} MB, the file has ${actual.toFixed(1)} MB`);
  }
  // precache: the tool, the shared modules and styles it loads, the data
  for (const f of ['"./"', '"index.html"', '"js/app.js"', '"js/numbering.js"', '"manifest.webmanifest"', '"../shared/css/forms.css"', '"../shared/js/offline.js"']) assert.ok(pre.includes(f), f);
  if (hasData) for (const f of ['callsigns-oe', 'repeaters-at', 'vienna-locations', 'austria-areas']) assert.ok(pre.includes(`"../shared/data/${f}.json"`), f);
  assert.ok(!pre.includes('"sw.js"') && !pre.includes('"notfunk-offline.html"'));
  const ctx = { self: {} };
  vm.runInNewContext(pre, ctx);
  for (const f of ctx.self.NOTFUNK_PRECACHE.files) {
    if (f !== './' && f !== 'build-info.js') assert.ok(existsSync(join(DIR, f)), f);
    assert.ok(!f.endsWith('.md'), f);
  }
});

test('commit is never part of the content hash', () => {
  try {
    assert.equal(buildWith('0123456789abcdef0123456789abcdef01234567').pre, buildWith('dev').pre);
  } finally {
    buildWith('dev');
  }
});

test('the service worker uses its own cache prefix', () => {
  const sw = readFileSync(join(DIR, 'sw.js'), 'utf8');
  assert.match(sw, /prefix: 'notfunk', precache: 'NOTFUNK_PRECACHE'/);
  assert.match(sw, /importScripts\('\.\.\/shared\/js\/sw-core\.js'\)/);
});
