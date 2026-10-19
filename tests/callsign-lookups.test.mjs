// Every callsign lookup of every tool goes through the shared callsign
// service (tools/shared/js/callsign-service.js), which knows the Austrian
// list and the user's own lists. A tool that reads the Austrian list on its
// own would not see the user's lists and would break the rules the service
// keeps (the typo warning is about the Austrian list only; a list that is
// switched off does not answer). Issue #81.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = p => readFileSync(join(ROOT, p), 'utf8');

function jsFiles(dir) {
  return readdirSync(join(ROOT, dir)).flatMap(n => {
    const p = join(dir, n);
    if (statSync(join(ROOT, p)).isDirectory()) return n === 'data' || n === 'vendor' || n === 'node_modules' ? [] : jsFiles(p);
    return /\.js$/.test(n) && !/(precache|build-info)\.js$/.test(n) ? [p.split(sep).join('/')] : [];
  });
}

// Only these may use the low-level list functions: the list itself, the
// service built on it.
const ALLOWED = new Set(['tools/shared/js/callbook.js', 'tools/shared/js/callsign-service.js']);
const LOW_LEVEL = /\b(buildCallbook|lookupCall|suggestCalls|searchCallbook)\b/;
const OLD_WIRING = /\b(getBook|state\.callbook|app\.data\.callbook|app\.data\.directory)\b/;

const FILES = ['confirm', 'notfunk', 'netlog', 'adif', 'sota-alerts', 'wavelog-import', 'shared'].flatMap(t => jsFiles(`tools/${t}/js`));

test('no tool uses the Austrian list on its own', () => {
  assert.ok(FILES.length > 30, 'the scan found the sources');
  const bad = FILES.filter(f => !ALLOWED.has(f) && LOW_LEVEL.test(read(f).replace(/^\s*\/\/.*$/gm, '')));
  assert.deepEqual(bad, [], 'use callsign-service.js (entry, search, official, label) instead');
});

test('the old wiring (getBook, state.callbook, app.data.callbook/directory) is gone', () => {
  const bad = FILES.filter(f => OLD_WIRING.test(read(f).replace(/^\s*\/\/.*$/gm, '')));
  assert.deepEqual(bad, []);
});

test('every tool that shows callsign lookups has the lists dialog and the focus refresh', () => {
  for (const tool of ['confirm', 'notfunk', 'netlog']) {
    const src = jsFiles(`tools/${tool}/js`).map(read).join('\n');
    assert.match(src, /createCallsignService\(/, `${tool}: a callsign service`);
    assert.match(src, /createCallsignLists\(/, `${tool}: the lists dialog`);
    assert.match(src, /\.watchFocus\(\)/, `${tool}: refresh when the window is looked at again`);
    assert.match(read(`tools/${tool}/index.html`), /id="btn-lists-open"/, `${tool}: the button`);
  }
});
