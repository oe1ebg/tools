// The confirmation log must work 100% offline: no runtime reference to any
// external host, and the single-file bundle must build and parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { commitUrl, versionItems, REPO_URL } from '../content/confirm/js/sources.js';

const OE1EBG = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(OE1EBG, "content", 'confirm');
const GENERATED = new Set(['confirm-offline.html', 'precache.js', 'build-info.js']);
// Dataset/licence links and map links: <a href> targets only, never fetched.
const LINK_ONLY = 'js/sources.js';
const XML_NAMESPACES = new Set(['http://www.w3.org/2000/svg', 'http://www.opengis.net/kml/2.2']);

// The project's Python (oe1ebg/.python-version via uv; the stdlib-only build
// scripts need a current one, a bare `python3` may be an old system Python,
// e.g. 3.9 on macOS). Falls back to `python3` only when uv isn't installed.
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
    return statSync(p).isDirectory() ? (n === 'data' ? [] : walk(p)) : [p];
  });
}

test('no external URLs in shipped confirm sources', () => {
  const offenders = [];
  for (const p of walk(DIR)) {
    const name = p.slice(DIR.length + 1);
    // vendor/: unmodified third-party code (Leaflet); its URLs are in
    // comments/licence text only — see the no-tiles/no-icons test below.
    if (GENERATED.has(name) || name === LINK_ONLY || name.startsWith('vendor/') || !/\.(js|html|webmanifest|svg|css)$/.test(name)) continue;
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)) {
      // XML namespaces (SVG, the KML export) are identifiers, not requests.
      if (XML_NAMESPACES.has(m[0])) continue;
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('map: no tile layers, no image icons (Leaflet would request them)', () => {
  const bad = [];
  for (const p of walk(join(DIR, 'js'))) {
    const src = readFileSync(p, 'utf8').replace(/\/\/.*$/gm, '');
    if (/tileLayer|L\.icon\(|L\.Icon\b|imageOverlay/.test(src)) bad.push(p);
    // every Leaflet marker must use a CSS divIcon
    for (const m of src.matchAll(/L\.marker\([^;]*/g)) if (!/icon/.test(m[0])) bad.push(`${p}: ${m[0].slice(0, 60)}`);
  }
  assert.deepEqual(bad, []);
  assert.match(readFileSync(join(DIR, 'index.html'), 'utf8'), /\.leaflet-control-layers-toggle\{ background-image:none/);
});

test('the link-only module really only provides links', () => {
  const src = readFileSync(join(DIR, LINK_ONLY), 'utf8');
  const code = src.replace(/\/\/.*$/gm, ''); // comments may mention "fetched"
  assert.ok(!/\bfetch\s*\(|\bimport\s*\(|XMLHttpRequest|importScripts|sendBeacon|\bsrc\s*:/.test(code), 'no request APIs');
  assert.match(src, /href: url/);
});

test('offline bundle builds into one self-contained, parseable file', () => {
  runPython(join(OE1EBG, 'scripts', 'build_confirm.py'), { GIT_SHA: 'dev' });
  const html = readFileSync(join(DIR, 'confirm-offline.html'), 'utf8');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+href="(?!data:)/.test(html), 'no external links');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // app bundle, plus the inlined data/ files when they have been built
  const hasData = existsSync(join(DIR, 'data')) && readdirSync(DIR + '/data').some(n => n.endsWith('.json'));
  // load-failure fallback, Leaflet, (inlined data/ when built), app bundle
  assert.equal(scripts.length, hasData ? 4 : 3);
  assert.ok(scripts.some(s => s.includes('Leaflet 1.9.4')), 'Leaflet inlined');
  assert.ok(!/vendor\/leaflet/.test(html.replace(/<script>[\s\S]*?<\/script>/g, '')), 'no reference to vendor files left');
  const app = scripts[scripts.length - 1];
  assert.ok(!/^\s*(import|export)\b/m.test(app));
  assert.match(app, /CONFIRM_STARTED = true/);
  for (const src of scripts) new vm.Script(src); // throws on syntax errors
  if (hasData) assert.ok(scripts.some(s => /^\s*globalThis\.CONFIRM_DATA = \{/.test(s)), 'data inlined');
  assert.ok(existsSync(join(DIR, 'precache.js')));
  const pre = readFileSync(join(DIR, 'precache.js'), 'utf8');
  assert.match(pre, /version: "[0-9a-f]{12}"/);
  for (const f of ['"./"', '"index.html"', '"js/app.js"', '"manifest.webmanifest"']) assert.ok(pre.includes(f), f);
  assert.ok(!pre.includes('"sw.js"'));
  assert.ok(!pre.includes('"confirm-offline.html"'), 'bundle is a download, not precached');
});

function buildWith(sha) {
  runPython(join(OE1EBG, 'scripts', 'build_confirm.py'), { GIT_SHA: sha });
  return {
    pre: readFileSync(join(DIR, 'precache.js'), 'utf8'),
    info: readFileSync(join(DIR, 'build-info.js'), 'utf8'),
    html: readFileSync(join(DIR, 'confirm-offline.html'), 'utf8'),
  };
}

function buildInfo(src) {
  const ctx = { self: {} };
  vm.runInNewContext(src, ctx);
  return JSON.parse(JSON.stringify(ctx.self.CONFIRM_BUILD)); // plain object of this realm
}

test('commit: shown via build-info.js, never part of the content hash', () => {
  const full = '0123456789abcdef0123456789abcdef01234567';
  const a = buildWith(full);
  const b = buildWith('dev');
  try {
    // precache.js (byte-compared by the browser for SW updates) is identical,
    // so a new commit alone never offers an "Update".
    assert.equal(a.pre, b.pre);
    assert.ok(!a.pre.includes('0123456'), 'commit not in precache.js');
    assert.ok(a.pre.includes('"build-info.js"'), 'build-info.js is precached');
    const version = /version: "([0-9a-f]{12})"/.exec(a.pre)[1];
    assert.deepEqual(buildInfo(a.info), { commit: '0123456', version });
    assert.deepEqual(buildInfo(b.info), { commit: 'dev', version });
    // the offline file carries the same build info, inlined
    assert.ok(a.html.includes(`self.CONFIRM_BUILD = {"commit": "0123456", "version": "${version}"};`));
    assert.ok(!a.html.includes('src="build-info.js"'), 'no reference to build-info.js left in the bundle');
    assert.equal(buildInfo(buildWith('not a sha; rm -rf').info).commit, 'dev');
    assert.equal(buildInfo(buildWith('ABCDEF1').info).commit, 'abcdef1');
  } finally {
    buildWith('dev');
  }
});

test('commit link only for real SHAs, built in the link-only module', () => {
  assert.equal(commitUrl('abc1234'), `${REPO_URL}/commit/abc1234`);
  assert.match(REPO_URL, /^https:\/\/github\.com\/ebirn\/web_outdated_at$/);
  for (const s of ['dev', '', null, undefined, 'abc12', 'xyz1234', 'abc1234/../x']) assert.equal(commitUrl(s), null, String(s));
  // no link (and no DOM needed) for dev builds
  assert.deepEqual(versionItems(undefined, undefined), ['commit ', 'dev', ' · data dev']);
  assert.deepEqual(versionItems({ commit: 'dev', version: '111111111111' }, '1a2b3c4d5e6f'), ['commit ', 'dev', ' · data 1a2b3c4d5e6f']);
  assert.deepEqual(versionItems({ commit: 'dev', version: '111111111111' }), ['commit ', 'dev', ' · data 111111111111']);
});
