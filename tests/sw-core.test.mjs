// The shared service worker logic (tools/shared/js/sw-core.js) run in a fake
// worker scope: development mode is explicit, a broken manifest fails the
// install, and the page's 'version' reply says whether the cache is complete.
// Also the pure parts of the page side (shared/js/offline.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { offlineStatus, saveSucceeded, runSaveHook } from '../tools/shared/js/offline.js';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'shared', 'js', 'sw-core.js'), 'utf8');

// precache: what importScripts('precache.js') does to the scope — define the
// global, or throw (404 / syntax error).
function load(precache, { cached = null, server = [GOOD_TEXT] } = {}) {
  let fetches = 0;
  const handlers = {};
  const store = new Map(); // cache name -> array of paths
  if (cached) store.set(cached.name, cached.paths);
  const self = {
    OE1EBG_SW: { prefix: 'tools-x', precache: 'X_PRECACHE' },
    location: new URL('https://h.example/tools/x/sw.js'),
    addEventListener: (t, fn) => { handlers[t] = fn; },
    clients: { claim: async () => {} },
    skipWaiting: () => {},
    importScripts: undefined,
  };
  const ctx = {
    self, URL, Request: class { constructor(u) { this.url = u; } }, Response, Promise,
    importScripts: () => {
      if (precache instanceof Error) throw precache;
      if (precache !== undefined) self.X_PRECACHE = precache;
    },
    caches: {
      has: async n => store.has(n),
      keys: async () => [...store.keys()],
      delete: async n => store.delete(n),
      open: async n => ({
        addAll: async reqs => { store.set(n, [...(store.get(n) || []), ...reqs.map(r => new URL(r.url, self.location).pathname)]); },
        keys: async () => (store.get(n) || []).map(p => ({ url: `https://h.example${p}` })),
        put: async req => { store.set(n, [...(store.get(n) || []), new URL(req.url, self.location).pathname]); },
        match: async req => ({ url: req.url }),
      }),
    },
    // the server: precache.js answers from `server` (the last entry repeats)
    fetch: async req => {
      if (!/precache\.js$/.test(req.url)) throw new Error('offline');
      const text = server[Math.min(fetches++, server.length - 1)];
      return { ok: true, status: 200, text: async () => text };
    },
  };
  vm.runInNewContext(SRC, ctx);
  return { handlers, store };
}

async function install(h) {
  let p;
  h.install({ waitUntil: x => { p = x; } });
  return p;
}
async function reply(h) {
  return new Promise(resolve => {
    h.message({ data: 'version', ports: [{ postMessage: o => resolve(JSON.parse(JSON.stringify(o))) }] });
  });
}

const manifestText = (version, files = ['./', 'js/app.js', '../shared/js/x.js']) => `self.X_PRECACHE = {\n  version: "${version}",\n  files: [\n${files.map(f => `    "${f}",`).join('\n')}\n  ],\n};\n`;
const GOOD_TEXT = manifestText('abc123');
const GOOD = { version: 'abc123', files: ['./', 'js/app.js', '../shared/js/x.js'] };

test('a valid manifest installs the cache and reports ready only when complete', async () => {
  const { handlers, store } = load(GOOD);
  await install(handlers);
  assert.deepEqual([...store.keys()], ['tools-x-abc123']);
  assert.deepEqual(await reply(handlers), { version: 'abc123', mode: 'production', ready: true });
  // an evicted/partial cache is not ready
  store.set('tools-x-abc123', ['/tools/x/']);
  assert.deepEqual(await reply(handlers), { version: 'abc123', mode: 'production', ready: false });
  store.delete('tools-x-abc123');
  assert.equal((await reply(handlers)).ready, false);
});

const BROKEN = {
  'precache.js fails to load (404)': new Error('NetworkError'),
  'precache.js defines nothing': undefined,
  'not an object': 'oops',
  'no version': { files: ['./'] },
  'empty version': { version: '', files: ['./'] },
  'version with odd characters': { version: 'a b/../c', files: ['./'] },
  'non-string version': { version: 12, files: ['./'] },
  'no files': { version: '1' },
  'empty files': { version: '1', files: [] },
  'files not a list': { version: '1', files: './' },
  'empty file name': { version: '1', files: ['./', ''] },
  'dev flag that is not true': { dev: 'yes' },
};
for (const [name, manifest] of Object.entries(BROKEN)) {
  test(`broken manifest fails the install, never "dev" or ready: ${name}`, async () => {
    const { handlers, store } = load(manifest);
    await assert.rejects(install(handlers), /precache\.js/);
    assert.equal(store.size, 0, 'nothing cached');
    const r = await reply(handlers);
    assert.equal(r.mode, 'broken');
    assert.equal(r.ready, false);
    assert.equal(offlineStatus(r).cls, 'err');
  });
}

test('development mode is only the explicit stub', async () => {
  const { handlers, store } = load({ dev: true });
  await install(handlers); // does nothing, does not fail
  assert.equal(store.size, 0);
  assert.deepEqual(await reply(handlers), { version: null, mode: 'dev', ready: false });
  assert.equal(offlineStatus(await reply(handlers)).text, 'Entwicklungsmodus (nicht offline)');
});

test('a broken worker serves nothing from the cache and does not delete the working cache', async () => {
  const { handlers, store } = load(new Error('x'), { cached: { name: 'tools-x-old', paths: ['/tools/x/'] } });
  let responded = false;
  handlers.fetch({ request: { method: 'GET', url: 'https://h.example/tools/x/js/app.js', mode: 'cors' }, respondWith: () => { responded = true; } });
  assert.equal(responded, false);
  // it never became active (install failed), so activate never ran: the old cache is untouched
  assert.deepEqual([...store.keys()], ['tools-x-old']);
});

test('activation removes only this tool\'s other caches', async () => {
  const { handlers, store } = load(GOOD, { cached: { name: 'tools-x-old', paths: [] } });
  store.set('tools-y-1', []);
  store.set('x-legacy', []);
  let p;
  handlers.activate({ waitUntil: x => { p = x; } });
  await p;
  assert.deepEqual([...store.keys()].sort(), ['tools-y-1', 'x-legacy']);
});

test('status chip texts distinguish ready / not ready / dev / failed', () => {
  assert.equal(offlineStatus({ version: 'a', mode: 'production', ready: true }).text, 'offline bereit ✓');
  assert.equal(offlineStatus({ version: 'a', mode: 'production', ready: false }).text, 'offline nicht bereit');
  assert.equal(offlineStatus({ version: null, mode: 'dev', ready: false }).cls, 'warn');
  assert.equal(offlineStatus({ version: null, mode: 'broken', ready: false }).text, 'offline nicht bereit');
  assert.equal(offlineStatus(undefined).cls, 'err');
  // a worker from before replies had a mode
  assert.equal(offlineStatus({ version: 'a' }).text, 'offline bereit ✓');
  assert.equal(offlineStatus({ version: null }).cls, 'warn');
});

test('save hook contract: only true is success', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await saveSucceeded(async () => true), true);
    assert.equal(await saveSucceeded(() => true), true);
    for (const v of [false, undefined, null, 1, 'ok', {}]) assert.equal(await saveSucceeded(async () => v), false, String(v));
    assert.equal(await saveSucceeded(async () => { throw new Error('quota'); }), false);
    assert.equal(await saveSucceeded(() => { throw new Error('sync'); }), false);
  } finally {
    console.warn = warn;
  }
});

test('save hook: a string or { message } says why, only true is success', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await runSaveHook(async () => true)).ok, true);
    { const r = await runSaveHook(async () => 'Entwurf liegt woanders'); assert.equal(r.ok, false); assert.equal(r.message, 'Entwurf liegt woanders'); }
    { const r = await runSaveHook(async () => ({ message: 'x' })); assert.equal(r.ok, false); assert.equal(r.message, 'x'); }
    { const r = await runSaveHook(async () => false); assert.equal(r.ok, false); assert.equal(r.message, ''); }
    { const r = await runSaveHook(async () => { throw new Error('quota'); }); assert.equal(r.ok, false); assert.equal(r.message, ''); }
  } finally {
    console.warn = warn;
  }
});

test('a development worker never deletes caches (a production cache survives)', async () => {
  const { handlers, store } = load({ dev: true }, { cached: { name: 'tools-x-abc123', paths: ['/tools/x/'] } });
  let p;
  handlers.activate({ waitUntil: x => { p = x; } });
  await p;
  assert.deepEqual([...store.keys()], ['tools-x-abc123']);
});

test('save hook: actions are kept when valid, the rest is dropped', async () => {
  const run = () => {};
  const r = await runSaveHook(async () => ({
    message: 'm', discards: 'd',
    actions: [{ label: 'A', run }, { label: 'no run' }, null, { run }, { label: 7, run }],
  }));
  assert.equal(r.ok, false);
  assert.equal(r.message, 'm');
  assert.equal(r.discards, 'd');
  assert.deepEqual(r.actions.map(a => a.label), ['A']);
  // actions never turn a failure into success; a non-array is ignored
  assert.equal((await runSaveHook(async () => ({ actions: 'x' }))).actions.length, 0);
  assert.equal((await runSaveHook(async () => ({ ok: true, message: 'x' }))).ok, false);
});

test('repair fetches only the missing files of this version into this version\'s cache', async () => {
  const { handlers, store } = load(GOOD, { cached: { name: 'tools-x-abc123', paths: ['/tools/x/'] } });
  store.set('tools-x-old', ['/tools/x/old.js']);
  let wait;
  const reply = new Promise(resolve => handlers.message({ data: 'repair', ports: [{ postMessage: o => resolve(JSON.parse(JSON.stringify(o))) }], waitUntil: p => { wait = p; } }));
  assert.deepEqual(await reply, { ok: true });
  await wait;
  assert.deepEqual([...store.get('tools-x-abc123')].sort(), ['/tools/shared/js/x.js', '/tools/x/', '/tools/x/js/app.js']);
  assert.deepEqual(store.get('tools-x-old'), ['/tools/x/old.js'], 'no other cache is touched');
  assert.equal((await new Promise(r => handlers.message({ data: 'version', ports: [{ postMessage: r }] }))).ready, true);
});

test('repair fails in development and broken mode', async () => {
  for (const manifest of [{ dev: true }, new Error('x')]) {
    const { handlers } = load(manifest);
    const r = await new Promise(resolve => handlers.message({ data: 'repair', ports: [{ postMessage: o => resolve(JSON.parse(JSON.stringify(o))) }], waitUntil: () => {} }));
    assert.equal(r.ok, false);
  }
});

const repairOf = handlers => new Promise(resolve => handlers.message({ data: 'repair', ports: [{ postMessage: o => resolve(JSON.parse(JSON.stringify(o))) }], waitUntil: () => {} }));

test('repair is refused while the server publishes another release: nothing is written, never "ready" for a mix', async () => {
  for (const server of [[manifestText('b2')], [manifestText('abc123', ['./', 'js/app.js', '../shared/js/y.js'])]]) {
    const { handlers, store } = load(GOOD, { cached: { name: 'tools-x-abc123', paths: ['/tools/x/'] }, server });
    const r = await repairOf(handlers);
    assert.equal(r.ok, false);
    assert.equal(r.newer, true);
    assert.match(r.message, /Neue Version auf dem Server/);
    assert.deepEqual([...store.keys()], ['tools-x-abc123']);
    assert.deepEqual(store.get('tools-x-abc123'), ['/tools/x/']);
    assert.equal((await new Promise(res => handlers.message({ data: 'version', ports: [{ postMessage: res }] }))).ready, false);
  }
});

test('a deployment that changes during the download is rolled back: no file is committed, staging is gone', async () => {
  // first check: still abc123; second check (after the download): b2
  const { handlers, store } = load(GOOD, { cached: { name: 'tools-x-abc123', paths: ['/tools/x/'] }, server: [GOOD_TEXT, manifestText('b2')] });
  const r = await repairOf(handlers);
  assert.equal(r.ok, false);
  assert.equal(r.newer, true);
  assert.deepEqual([...store.keys()], ['tools-x-abc123'], 'staging cache deleted');
  assert.deepEqual(store.get('tools-x-abc123'), ['/tools/x/'], 'active cache untouched');
});
