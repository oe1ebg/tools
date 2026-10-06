// HTML hygiene and interop rules for every tool page (tools/*/index.html)
// and their JS. Zero dependencies: string/regex checks on the source,
// which is plain enough for that. Rules: tools/shared/README.md
// ("HTML & interop rules").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');
const PAGES = readdirSync(TOOLS)
  .filter(d => d !== 'shared' && existsSync(join(TOOLS, d, 'index.html')))
  .map(d => join(TOOLS, d, 'index.html'));

function walk(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'vendor' || n === 'data' ? [] : walk(p);
    return [p];
  });
}

// The markup outside <script> / <style> elements and comments.
function markup(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '');
}

function tags(html, name) {
  return [...markup(html).matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map(m => m[1]);
}

const attr = (attrs, name) => new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+))?`, 'i').exec(attrs);

test('tool pages exist', () => {
  assert.ok(PAGES.length >= 3, PAGES.join(', '));
});

for (const page of PAGES) {
  const name = relative(TOOLS, page);
  const html = readFileSync(page, 'utf8');

  test(`${name}: document basics`, () => {
    assert.match(html, /^<!doctype html>\n<html lang="[a-z]{2}">/i);
    assert.equal((html.match(/<meta charset="utf-8">/gi) || []).length, 1, 'exactly one charset declaration');
    assert.ok(!/http-equiv="content-type"/i.test(html), 'no second (http-equiv) charset declaration');
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.equal(tags(html, 'h1').length, 1, 'one h1');
    assert.equal(tags(html, 'main').length, 1, 'one <main> landmark');
  });

  test(`${name}: shared theme first, styles in CSS files`, () => {
    const head = html.slice(0, html.indexOf('</head>'));
    const theme = head.indexOf('<script src="../shared/js/theme.js"></script>');
    assert.ok(theme > 0, 'loads shared/js/theme.js');
    assert.ok(theme < head.indexOf('<link rel="stylesheet"'), 'theme.js before the first stylesheet');
    assert.ok(head.includes('<link rel="stylesheet" href="../shared/css/tools.css">'));
    assert.ok(head.includes('<link rel="stylesheet" href="style.css">'));
    assert.ok(!/<style\b/i.test(html), 'no inline <style> (style.css)');
    assert.ok(!/\sstyle\s*=/i.test(markup(html)), 'no style="" attributes');
    assert.ok(!/\son[a-z]+\s*=/i.test(markup(html)), 'no inline event handler attributes');
  });

  test(`${name}: buttons have a type, fields have a name, ids are unique`, () => {
    for (const a of tags(html, 'button')) assert.ok(attr(a, 'type'), `<button${a}> without type`);
    const ids = tags(html, '[a-z0-9-]+').map(a => attr(a, 'id')?.[1]?.replace(/["']/g, '')).filter(Boolean);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dup, [], 'duplicate ids');
    const labelled = new Set(tags(html, 'label').map(a => attr(a, 'for')?.[1]?.replace(/["']/g, '')).filter(Boolean));
    const body = markup(html);
    for (const tag of ['input', 'select', 'textarea']) {
      for (const m of body.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))) {
        const a = m[1];
        const type = attr(a, 'type')?.[1]?.replace(/["']/g, '');
        if (type === 'hidden' || type === 'file' || attr(a, 'hidden')) continue;
        const id = attr(a, 'id')?.[1]?.replace(/["']/g, '');
        // wrapped in a <label>: the nearest unclosed <label> before it
        const before = body.slice(0, m.index);
        const wrapped = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
        assert.ok(wrapped || (id && labelled.has(id)) || attr(a, 'aria-label') || attr(a, 'aria-labelledby'),
          `<${tag}${a}> has no label`);
      }
    }
  });

  test(`${name}: external links say they open a new tab safely`, () => {
    for (const a of tags(html, 'a')) {
      if (!attr(a, 'target')) continue;
      assert.match(a, /rel="[^"]*noopener/, `<a${a}>`);
    }
  });
}

test('tool JS builds no HTML from strings with innerHTML (sota-alerts escapes via escapeHtml)', () => {
  const offenders = [];
  for (const p of walk(TOOLS).filter(p => p.endsWith('.js') || p.endsWith('index.html'))) {
    if (/adif-editor\.html|confirm-offline\.html/.test(p)) continue;
    const src = readFileSync(p, 'utf8').replace(/\/\/.*$/gm, '');
    const rel = relative(TOOLS, p);
    for (const m of src.matchAll(/\.(innerHTML|outerHTML)\s*=(?!=)|insertAdjacentHTML\s*\(/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      const stmt = src.slice(m.index, src.indexOf('\n', m.index));
      // allowed: clearing, and sota-alerts' template strings (escapeHtml)
      if (/=\s*(''|"")\s*;?$/.test(stmt.trim())) continue;
      if (rel.startsWith('sota-alerts/')) continue;
      offenders.push(`${rel}:${line} ${stmt.trim().slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('Leaflet popups/tooltips never get an HTML string built from data', () => {
  const offenders = [];
  for (const p of walk(TOOLS).filter(p => p.endsWith('.js'))) {
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/\.bind(?:Popup|Tooltip)\(\s*([^,]+)/g)) {
      const arg = m[1].trim();
      // functions and DOM nodes are fine; a variable or template string is HTML to Leaflet
      if (/^(\(\)|[a-z]+\s*=>|\(?[a-z, ]*\)?\s*=>|el\(|function\b)/.test(arg)) continue;
      offenders.push(`${relative(TOOLS, p)}: bind…(${arg})`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('no raw localStorage outside the shared helpers (it throws when storage is blocked)', () => {
  const allowed = ['shared/js/storage.js', 'shared/js/prefs.js', 'shared/js/theme.js'];
  const offenders = [];
  for (const p of walk(TOOLS).filter(p => p.endsWith('.js') || p.endsWith('index.html'))) {
    const rel = relative(TOOLS, p);
    if (allowed.includes(rel) || /adif-editor\.html|confirm-offline\.html/.test(rel)) continue;
    const src = readFileSync(p, 'utf8').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'|`[^`]*`/g, '""');
    if (/localStorage\s*\.\s*(getItem|setItem|removeItem)/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('no APIs that break the browser floor without a fallback', () => {
  const offenders = [];
  for (const p of walk(TOOLS).filter(p => p.endsWith('.js') || p.endsWith('index.html'))) {
    const rel = relative(TOOLS, p);
    if (/adif-editor\.html|confirm-offline\.html/.test(rel) || rel === 'shared/js/dom.js') continue;
    const src = readFileSync(p, 'utf8').replace(/\/\/.*$/gm, '');
    if (/\.requestSubmit\(/.test(src)) offenders.push(`${rel}: requestSubmit (Safari < 16) – use submitForm()`);
    if (/\.substr\(/.test(src)) offenders.push(`${rel}: substr (legacy) – use slice()`);
    if (/[\u0300-\u036f]/.test(src)) offenders.push(`${rel}: invisible combining character – write \\u0300-\\u036f`);
  }
  assert.deepEqual(offenders, []);
});
