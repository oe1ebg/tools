// The shared storage layer (tools/shared/js/storage.js) on the browser's real
// IndexedDB: a batch whose request can't be created leaves no changes, a
// blocked upgrade waits instead of switching to localStorage, an old
// connection gives way to a newer version, a late open success after the
// timeout is closed again, and fallback records are found and moved into
// IndexedDB without overwriting anything. The localStorage fallback itself
// is covered by the node tests (tests/storage.test.mjs).
import { test, expect } from './fixtures.mjs';

// An empty page next to the shared modules, so they import by relative URL.
test.beforeEach(async ({ page }) => {
  await page.route('**/tools/shared/storage-test.html', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="de"><meta charset="utf-8"><title>storage</title><main></main></html>',
  }));
  await page.goto('tools/shared/storage-test.html');
});

// Runs fn(storageModule, schema(name, version)) in the page.
function inPage(page, fn, arg) {
  return page.evaluate(async ([src, a]) => {
    const m = await import(new URL('js/storage.js', location.href).href);
    const schema = (name, version = 1, extra = {}) => ({
      name, version, lsPrefix: `${name}:v1:`,
      stores: { messages: { keyPath: 'id', byEvent: true }, counters: { keyPath: 'id', byEvent: true } },
      upgrade(old, create) { if (old < 1) { create('messages'); create('counters'); } },
      ...extra,
    });
    const rawOpen = (name, version) => new Promise((resolve, reject) => {
      const r = indexedDB.open(name, version);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('blocked'));
    });
    // eslint-disable-next-line no-new-func
    return new Function('m', 'schema', 'rawOpen', 'a', `return (${src})(m, schema, rawOpen, a);`)(m, schema, rawOpen, a);
  }, [fn.toString(), arg]);
}

test('a batch with a request that cannot be created leaves no changes and keeps the original error', async ({ page }) => {
  const r = await inPage(page, async (m, schema) => {
    const s = await m.openToolStorage(schema('st-abort'));
    const out = { kind: s.kind };
    try {
      await s.tx([
        { store: 'messages', put: { id: 'a', eventId: 'e' } },
        { store: 'messages', put: { eventId: 'e' } }, // no key: DataError on put()
      ]);
    } catch (e) { out.tx = e.name; }
    try {
      await s.atomic(['messages', 'counters'], async ({ get, put }) => {
        await get('counters', 'c');
        put('counters', { id: 'c', eventId: 'e', last: 1 });
        put('messages', { text: 'no key' });
      });
    } catch (e) { out.atomic = e.name; }
    out.messages = (await s.getAll('messages')).length;
    out.counters = (await s.getAll('counters')).length;
    return out;
  });
  expect(r).toEqual({ kind: 'indexeddb', tx: 'DataError', atomic: 'DataError', messages: 0, counters: 0 });
});

test('a blocked upgrade waits for the other tab instead of switching to localStorage', async ({ page }) => {
  const r = await inPage(page, async (m, schema, rawOpen) => {
    const old = await rawOpen('st-blocked', 1); // an old tab: no versionchange handler
    const events = [];
    const p = m.openToolStorage(schema('st-blocked', 2, { upgrade(o, create) { if (o < 1) create('messages'); if (o < 2) create('counters'); } }),
      { openTimeout: 200, onBlocked: e => events.push(`blocked ${e.oldVersion}->${e.newVersion}`) });
    let done = false;
    p.then(() => { done = true; });
    await new Promise(res => setTimeout(res, 600)); // well past openTimeout
    events.push(done ? 'opened while blocked' : 'still waiting');
    old.close();
    const s = await p;
    await s.tx([{ store: 'counters', put: { id: 'c', eventId: 'e', last: 1 } }]);
    return { events, kind: s.kind, ls: Object.keys(localStorage).filter(k => k.startsWith('st-blocked')).length };
  });
  expect(r).toEqual({ events: ['blocked 1->2', 'still waiting'], kind: 'indexeddb', ls: 0 });
});

test('an open connection gives way to a newer version and reports it', async ({ page }) => {
  const r = await inPage(page, async (m, schema, rawOpen) => {
    const closed = [];
    const s = await m.openToolStorage(schema('st-vc'), { onClosed: e => closed.push(e.reason) });
    await s.tx([{ store: 'messages', put: { id: 'a', eventId: 'e' } }]);
    const newer = await rawOpen('st-vc', 2); // rejects on "blocked"
    newer.close();
    let after = null;
    try { await s.getAll('messages'); } catch (e) { after = e.name; }
    let write = null;
    try { await s.tx([{ store: 'messages', put: { id: 'b', eventId: 'e' } }]); } catch (e) { write = e.name; }
    return { closed, after, write };
  });
  expect(r).toEqual({ closed: ['versionchange'], after: 'StorageClosedError', write: 'StorageClosedError' });
});

test('an open that succeeds after the timeout is closed again (no leaked connection)', async ({ page }) => {
  const r = await inPage(page, async (m, schema) => {
    // Hold the database in a long upgrade: our open queues behind it
    // without any event, so it runs into openTimeout.
    let upgrading;
    const inUpgrade = new Promise(res => { upgrading = res; });
    const firstP = new Promise((resolve, reject) => {
      const req = indexedDB.open('st-late', 1);
      req.onupgradeneeded = () => {
        upgrading();
        const db = req.result;
        const os = db.createObjectStore('messages', { keyPath: 'id' });
        db.createObjectStore('counters', { keyPath: 'id' });
        os.createIndex('eventId', 'eventId');
        const until = Date.now() + 400;
        const spin = () => { if (Date.now() < until) os.get('x').onsuccess = spin; };
        spin();
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await inUpgrade;
    const s = await m.openToolStorage(schema('st-late'), { openTimeout: 50 });
    (await firstP).close();
    await new Promise(res => setTimeout(res, 800)); // the late success arrives meanwhile
    const blocked = await new Promise(resolve => {
      const req = indexedDB.open('st-late', 2);
      req.onblocked = () => resolve(true);
      req.onsuccess = () => { req.result.close(); resolve(false); };
      req.onerror = () => resolve(`error ${req.error && req.error.name}`);
    });
    return { kind: s.kind, reason: s.fallbackReason && s.fallbackReason.name, blocked };
  });
  expect(r).toEqual({ kind: 'localstorage', reason: 'TimeoutError', blocked: false });
});

test('fallback records are found and moved into IndexedDB without overwriting anything', async ({ page }) => {
  const r = await inPage(page, async (m, schema) => {
    const p = 'st-move:v1:';
    const put = (store, rec) => localStorage.setItem(`${p}${store}:${rec.id}`, JSON.stringify(rec));
    const merge = (store, cur, inc) => (store === 'counters' ? { ...cur, last: Math.max(cur.last, inc.last) } : undefined);
    const s = await m.openToolStorage(schema('st-move', 1, { merge }));
    await s.tx([
      { store: 'messages', put: { id: 'same', eventId: 'e', text: 'x' } },
      { store: 'messages', put: { id: 'both', eventId: 'e', text: 'idb', updated: '2' } },
      { store: 'counters', put: { id: 'e:W1', eventId: 'e', last: 3 } },
    ]);
    put('messages', { id: 'new', eventId: 'e', text: 'only in ls' });
    put('messages', { id: 'same', eventId: 'e', text: 'x' });
    put('messages', { id: 'both', eventId: 'e', text: 'ls', updated: '1' });
    put('counters', { id: 'e:W1', eventId: 'e', last: 5 });
    localStorage.setItem(`${p}probe`, 'not a record');
    const found = await s.fallbackData();
    const lsBoth = (await s.readFallback('messages')).find(x => x.id === 'both').text;
    const res = await s.migrateFallback();
    return {
      found,
      lsBoth,
      res,
      idb: Object.fromEntries((await s.getAll('messages')).map(x => [x.id, x.text])),
      counter: (await s.get('counters', 'e:W1')).last,
      left: Object.keys(localStorage).filter(k => k.startsWith(p)).sort(),
      again: await s.fallbackData(),
    };
  });
  expect(r.found).toEqual({ total: 4, stores: { messages: 3, counters: 1 }, journal: false });
  expect(r.lsBoth).toBe('ls');
  expect(r.res).toEqual({ copied: 1, merged: 1, identical: 1, kept: [{ store: 'messages', key: 'both', reason: 'conflict' }] });
  expect(r.idb).toEqual({ same: 'x', both: 'idb', new: 'only in ls' });
  expect(r.counter).toBe(5);
  expect(r.left).toEqual(['st-move:v1:messages:both', 'st-move:v1:probe']);
  expect(r.again).toEqual({ total: 1, stores: { messages: 1 }, journal: false });
});
