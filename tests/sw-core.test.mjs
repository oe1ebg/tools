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
import { offlineStatus, saveSucceeded } from '../tools/shared/js/offline.js';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'shared', 'js', 'sw-core.js'), 'utf8');

// precache: what importScripts('precache.js') does to the scope — define the
// global, or throw (404 / syntax error).
function load(precache, { cached = null } = {}) {
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
        addAll: async reqs => { store.set(n, reqs.map(r => new URL(r.url, self.location).pathname)); },
        keys: async () => (store.get(n) || []).map(p => ({ url: `https://h.example${p}` })),
        match: async () => undefined,
      }),
    },
    fetch: async () => { throw new Error('offline'); },
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
