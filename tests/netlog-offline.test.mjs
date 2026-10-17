// Netlog works offline once installed: no runtime reference to any external
// host (station-lookup links the user opens are the one exception, in
// js/links.js, and only as link targets), and a service worker precache
// that lists every module it loads; the single-file netlog-offline.html
// carries everything inline for file://.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { sharedDataBuilt } from './real-data.mjs';

const OE1EBG = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(OE1EBG, 'tools', 'netlog');
const GENERATED = new Set(['precache.js', 'build-info.js', 'netlog-offline.html']);
// user-opened station lookups (QRZ.com, HamQTH, …): links, never fetched
const LINK_MODULES = new Set(['js/links.js']);

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

test('no external URLs in shipped netlog sources (except the lookup links)', () => {
  const offenders = [];
  for (const p of walk(DIR)) {
    const name = p.slice(DIR.length + 1);
    if (GENERATED.has(name) || LINK_MODULES.has(name) || !/\.(js|html|webmanifest|svg|css)$/.test(name)) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)) {
      if (m[0] === 'http://www.w3.org/2000/svg') continue; // XML namespace, not a request
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the lookup links are only link targets, no fetch/XHR anywhere in netlog', () => {
  for (const p of walk(join(DIR, 'js'))) {
    const src = readFileSync(p, 'utf8');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|EventSource/.test(src), p);
  }
});

test('precache lists every module and file the page loads, plus build-info.js', () => {
  runPython(join(OE1EBG, 'scripts', 'build_netlog.py'), { GIT_SHA: 'dev' });
  const sandbox = { self: {} };
  vm.runInNewContext(readFileSync(join(DIR, 'precache.js'), 'utf8'), sandbox);
  const pre = sandbox.self.NETLOG_PRECACHE;
  assert.match(pre.version, /^[0-9a-f]{12}$/);
  const files = new Set(pre.files);
  assert.ok(files.has('./') && files.has('index.html') && files.has('build-info.js'));
  for (const p of walk(join(DIR, 'js'))) assert.ok(files.has(`js/${p.slice(join(DIR, 'js').length + 1)}`), p);
  for (const f of ['style.css', 'manifest.webmanifest', 'icon.svg', '../shared/js/theme.js', '../shared/css/tools.css', '../shared/js/storage.js', '../shared/js/offline.js']) {
    assert.ok(files.has(f), f);
  }
  assert.ok(!files.has('sw.js') && !files.has('precache.js'));
  for (const f of files) {
    if (f === './' || f === 'build-info.js') continue;
    assert.ok(existsSync(join(DIR, f)), `${f} exists`);
  }
  assert.ok(!files.has('netlog-offline.html'), 'the bundle is not precached');
});

test('netlog-offline.html is one self-contained, parseable file', () => {
  runPython(join(OE1EBG, 'scripts', 'build_netlog.py'), { GIT_SHA: 'dev' });
  const html = readFileSync(join(DIR, 'netlog-offline.html'), 'utf8');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+href="(?!data:)/.test(html), 'no external links');
  assert.ok(!/<link rel="manifest"/.test(html), 'no manifest');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const hasData = sharedDataBuilt();
  // theme, load-failure fallback, (inlined data when built), app bundle
  assert.equal(scripts.length, hasData ? 4 : 3);
  assert.ok(scripts[0].includes('OE1EBG_THEME'), 'theme script first');
  assert.ok(!/(vendor|shared)\//.test(html.replace(/<script>[\s\S]*?<\/script>/g, '')), 'no reference to shared files left');
  const app = scripts[scripts.length - 1];
  assert.ok(!/^\s*(import|export)\b/m.test(app));
  assert.match(app, /NETLOG_READY = true/);
  assert.match(app, /self\.NETLOG_BUILD = \{"commit": "dev"/);
  for (const src of scripts) new vm.Script(src); // throws on syntax errors
  assert.ok(!html.includes('<!-- NETLOG-LICENSES -->'));
  if (hasData) {
    for (const f of ['callsigns-oe.json', 'repeaters-at.json']) assert.ok(scripts[2].includes(`"${f}"`), `${f} inlined`);
    // the size both languages state
    const actual = statSync(join(DIR, 'netlog-offline.html')).size / 1e6;
    for (const lang of ['en', 'de']) {
      const text = readFileSync(join(DIR, 'js', `lang-${lang}.js`), 'utf8');
      const stated = Number(/'offlineFile\.text': '[^']*?(?:about|ca\.) (\d+) MB/.exec(text)[1]);
      assert.ok(Math.abs(stated - actual) < 1, `${lang}: says ~${stated} MB, the file has ${actual.toFixed(1)} MB`);
    }
  }
});

test('the hash ignores the commit (build-info.js only)', () => {
  runPython(join(OE1EBG, 'scripts', 'build_netlog.py'), { GIT_SHA: 'a'.repeat(40) });
  const a = readFileSync(join(DIR, 'precache.js'), 'utf8');
  const infoA = readFileSync(join(DIR, 'build-info.js'), 'utf8');
  runPython(join(OE1EBG, 'scripts', 'build_netlog.py'), { GIT_SHA: 'b'.repeat(40) });
  assert.equal(readFileSync(join(DIR, 'precache.js'), 'utf8'), a);
  assert.notEqual(readFileSync(join(DIR, 'build-info.js'), 'utf8'), infoA);
  assert.match(readFileSync(join(DIR, 'build-info.js'), 'utf8'), /self\.NETLOG_BUILD = \{"commit": "bbbbbbb"/);
});
