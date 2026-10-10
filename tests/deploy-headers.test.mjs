// The security headers of deploy/nginx.conf.example and
// deploy/htaccess.example against the pages they protect: the
// Content-Security-Policy of each location allows exactly the inline
// scripts its pages have (by sha256), the SOTA Alerts Map's network hosts
// are those in its code, and the two examples send the same headers. The
// browser tests (tests/e2e/deploy.spec.mjs) check the same in a browser,
// against nginx with this config. When an inline script changes, put the
// hash this test prints into both files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipWithout } from './real-data.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = p => readFileSync(join(ROOT, p), 'utf8');
const NGINX = read('deploy/nginx.conf.example');
const HTACCESS = read('deploy/htaccess.example');

// --- the two configs
//
// Both parse to { header: { default, rules: [[regex source, value]] } }:
// what is sent for a URI is the value of the first matching rule, else the
// default ('' = not sent).

function parseNginx(text) {
  text = text.replace(/#[^\n]*/g, '');
  const maps = {};
  for (const [, name, body] of text.matchAll(/map\s+\$uri\s+\$(\w+)\s*\{([\s\S]*?)\}/g)) {
    const m = { default: '', rules: [] };
    for (const [, key, value] of body.matchAll(/(\S+)\s+"([^"]*)"\s*;/g)) {
      if (key === 'default') m.default = value; else m.rules.push([key.replace(/^~/, ''), value]);
    }
    maps[name] = m;
  }
  const headers = {}, always = new Set();
  for (const [, name, raw, a] of text.matchAll(/add_header\s+(\S+)\s+("[^"]*"|\S+?)(\s+always)?\s*;/g)) {
    const value = raw.replace(/^"|"$/g, '');
    headers[name] = value.startsWith('$') ? maps[value.slice(1)] : { default: value, rules: [] };
    assert.ok(headers[name], `map for ${value}`);
    if (a) always.add(name);
  }
  return { headers, always, locations: text.match(/location\b[^{]*\{[^}]*\}/g) || [] };
}

// `Header always set` only (the Cache-Control rule is a <FilesMatch>).
function parseHtaccess(text) {
  const headers = {};
  for (const [, name, value, cond] of text.matchAll(/^\s*Header always set (\S+) "([^"]*)"(?: "expr=%\{REQUEST_URI\} =~ m#(.*)#")?$/gm)) {
    const h = headers[name] ||= { default: '', rules: [] };
    // a later `set` replaces an earlier one: the last matching rule wins
    if (cond) h.rules.unshift([cond, value]); else h.default = value;
  }
  return { headers };
}

const SECURITY = ['Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy'];
const nginx = parseNginx(NGINX);
const htaccess = parseHtaccess(HTACCESS);
const CSP = nginx.headers['Content-Security-Policy'];

const sent = (h, uri) => (h.rules.find(([rx]) => new RegExp(rx).test(uri)) || [, h.default])[1];
const policyFor = uri => sent(CSP, uri);
const directive = (policy, name) => {
  const d = policy.split(';').map(s => s.trim().split(/\s+/)).find(([n]) => n === name);
  return d ? d.slice(1) : null;
};

// --- the pages

const sha256 = s => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const inlineScripts = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attrs]) => !/\ssrc\s*=/i.test(attrs)).map(([, , body]) => body);

function htmlFiles(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'data' || n === 'vendor' || n === 'node_modules' ? [] : htmlFiles(p);
    return n.endsWith('.html') ? [p] : [];
  });
}

// The single-file bundles (git-ignored build output): their names, from
// .gitignore, whether built or not.
const BUNDLES = read('.gitignore').split('\n').filter(l => /^tools\/.*\.html$/.test(l));

// Source pages (tools/<tool>/*.html) as /tools/…, plus the overview page
// and the rendered manuals of site/tools/ when it has been built.
function pages(base) {
  return htmlFiles(join(ROOT, base)).map(p => [`/tools/${relative(join(ROOT, base), p).split(sep).join('/')}`, readFileSync(p, 'utf8')]);
}

test('nginx sets every header at server level, for error responses too', () => {
  for (const name of SECURITY) {
    assert.ok(nginx.headers[name], `add_header ${name}`);
    assert.ok(nginx.always.has(name), `add_header ${name} … always`);
  }
  assert.equal(nginx.headers['X-Content-Type-Options'].default, 'nosniff');
  // a location with its own add_header would drop all server-level ones
  for (const loc of nginx.locations) assert.ok(!/add_header/.test(loc), `add_header inside ${loc}`);
});

// Every URI the tests know of, plus a few the rules single out.
const URIS = () => [...new Set([
  ...pages('tools').map(([u]) => u), ...BUNDLES.map(b => `/${b}`),
  '/tools/', '/tools/confirm/js/app.js', '/tools/sota-alerts/js/map.js', '/tools/no-such-file',
  '/prefix/tools/adif/adif-editor.html', '/prefix/tools/sota-alerts/index.html',
])];

test('htaccess.example sends the same headers as nginx.conf.example', () => {
  for (const name of SECURITY) {
    assert.ok(htaccess.headers[name], `Header always set ${name}`);
    for (const uri of URIS()) {
      assert.equal(sent(htaccess.headers[name], uri), sent(nginx.headers[name], uri), `${name} for ${uri}`);
    }
  }
});

// Framing: refused everywhere, except adif-editor.html by its own origin
// (tools/adif/README.md, "Zensical integration": an <iframe> in a site page).
test('every policy forbids plugins and <base>; framing only same-origin for adif-editor.html', () => {
  for (const p of [CSP.default, ...CSP.rules.map(r => r[1])]) {
    assert.deepEqual(directive(p, 'object-src'), ["'none'"], p);
    assert.deepEqual(directive(p, 'base-uri'), ["'none'"], p);
    assert.deepEqual(directive(p, 'default-src'), ["'self'"], p);
  }
  const xfo = nginx.headers['X-Frame-Options'];
  for (const uri of URIS()) {
    const embeddable = uri.endsWith('/adif/adif-editor.html');
    assert.deepEqual(directive(policyFor(uri), 'frame-ancestors'), [embeddable ? "'self'" : "'none'"], uri);
    assert.equal(sent(xfo, uri), embeddable ? 'SAMEORIGIN' : 'DENY', uri);
  }
});

test('single-file bundles get the inline policy, nothing else does', () => {
  assert.ok(BUNDLES.length >= 3, BUNDLES.join(', '));
  for (const b of BUNDLES) {
    const p = policyFor(`/${b}`);
    assert.ok(directive(p, 'script-src').includes("'unsafe-inline'"), b);
    // a hash next to 'unsafe-inline' would switch it off
    assert.ok(!directive(p, 'script-src').some(s => s.startsWith("'sha")), b);
  }
  for (const [uri] of pages('tools')) {
    if (BUNDLES.includes(uri.slice(1))) continue;
    const p = policyFor(uri);
    for (const d of ['script-src', 'style-src']) assert.ok(!directive(p, d).includes("'unsafe-inline'"), `${uri}: ${d}`);
    assert.ok(!p.includes("'unsafe-eval'"), `${uri}: ${p}`);
  }
});

function checkInlineScripts(list) {
  const used = new Set();
  for (const [uri, html] of list) {
    const p = policyFor(uri);
    const src = directive(p, 'script-src') || directive(p, 'default-src');
    if (src.includes("'unsafe-inline'")) continue;
    for (const body of inlineScripts(html)) {
      const h = sha256(body);
      used.add(h);
      assert.ok(src.includes(h), `${uri}: inline script ${h} is not in its policy's script-src (deploy/*.example):\n${p}`);
    }
    assert.ok(!/<style\b/i.test(html) || directive(p, 'style-src').includes("'unsafe-inline'"), `${uri}: inline <style>`);
  }
  return used;
}

test('the inline scripts of the tool pages are allowed by hash, and no other hash', () => {
  const used = checkInlineScripts(pages('tools'));
  const listed = [CSP.default, ...CSP.rules.map(r => r[1])]
    .flatMap(p => directive(p, 'script-src') || []).filter(s => s.startsWith("'sha256-"));
  assert.deepEqual([...new Set(listed)].sort(), [...used].sort(), 'hashes in the policies = inline scripts of the pages');
});

const SITE = join(ROOT, 'site', 'tools');
test('the built pages (overview, manuals) need no other inline script', { skip: skipWithout(existsSync(SITE), 'run `just build` first') }, () => {
  checkInlineScripts(pages('site/tools'));
});

test('the SOTA Alerts Map may reach exactly the hosts in its code', () => {
  const p = policyFor('/tools/sota-alerts/index.html');
  assert.notEqual(p, CSP.default);
  const hosts = (src, re) => [...new Set([...src.matchAll(re)].map(m => `https://${m[1].replace('{s}.', '*.')}`))].sort();
  // api.js: every request of the tool (SOTA API, Overpass)
  const api = hosts(read('tools/sota-alerts/js/api.js'), /['`]https:\/\/([^/'`]+)/g);
  const tiles = hosts(read('tools/sota-alerts/js/map.js'), /L\.tileLayer\('https:\/\/([^/']+)/g);
  assert.ok(api.includes('https://api2.sota.org.uk') && tiles.length >= 3, `${api} ${tiles}`);
  const others = name => directive(p, name).filter(s => s.startsWith('https:')).sort();
  assert.deepEqual(others('connect-src'), api, 'connect-src');
  assert.deepEqual(others('img-src'), tiles, 'img-src');
  // nothing of that outside sota-alerts/
  assert.ok(!CSP.default.includes('https:'));
});
