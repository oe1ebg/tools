// The shared storage layer's localStorage fallback (tools/shared/js/storage.js,
// contract in tools/shared/README.md): all-or-nothing batches (undo
// journal), rollback of a batch a dead tab left behind, one write lock
// across instances (Web Locks), compare-and-set. Node has no IndexedDB, so
// openToolStorage() always takes the fallback here; the IndexedDB side
// (aborted batches, blocked/versionchange, moving fallback records over)
// is covered in the browser by tests/e2e/storage.spec.mjs.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openToolStorage, assertUnchanged, ConflictError, StorageBusyError } from '../tools/shared/js/storage.js';
import { saveNumbered, numberGaps } from '../tools/notfunk/js/numbering.js';

// localStorage stand-in. failOn(n): the n-th setItem from now throws a
// QuotaExceededError; freezeAfter(n): after n more setItem calls every
// write throws (the tab "died" mid-batch).
class MemoryStorage {
  #m = new Map();
  #sets = 0;
  #failAt = Infinity;
  #frozenAt = Infinity;
  get length() { return this.#m.size; }
  key(i) { return [...this.#m.keys()][i] ?? null; }
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) {
    this.#sets++;
    if (this.#sets === this.#failAt || this.#sets > this.#frozenAt) {
      const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
    }
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    if (this.#sets >= this.#frozenAt) throw new Error('frozen');
    this.#m.delete(k);
  }
  failOn(n) { this.#failAt = this.#sets + n; }
  freezeAfter(n) { this.#frozenAt = this.#sets + n; }
  thaw() { this.#failAt = Infinity; this.#frozenAt = Infinity; }
  dump() { return Object.fromEntries(this.#m); }
}

// Web Locks stand-in shared by "tabs": one FIFO queue per lock name.
function lockManager() {
  const tails = new Map();
  return {
    request(name, cb) {
      const p = (tails.get(name) || Promise.resolve()).then(() => cb({ name }));
      tails.set(name, p.catch(() => {}));
      return p;
    },
  };
}

const SCHEMA = {
  name: 'test', version: 1, lsPrefix: 'test:v1:',
  stores: { messages: { keyPath: 'id', byEvent: true }, counters: { keyPath: 'id', byEvent: true } },
  upgrade() {},
};

let ls;
beforeEach(() => {
  ls = new MemoryStorage();
  globalThis.localStorage = ls;
});

const open = (opts = {}) => openToolStorage(SCHEMA, { locks: lockManager(), ...opts });

test('a record without its key fails the whole batch before anything is written', async () => {
  const s = await open();
  await assert.rejects(s.tx([
    { store: 'messages', put: { id: 'a', eventId: 'e' } },
    { store: 'messages', put: { eventId: 'e' } },
  ]), err => err.name === 'DataError');
  assert.deepEqual(await s.getAll('messages'), []);
  await assert.rejects(s.atomic(['messages'], async ({ put }) => {
    put('messages', { id: 'b', eventId: 'e' });
    put('messages', { text: 'no key' });
  }), err => err.name === 'DataError');
  assert.deepEqual(await s.getAll('messages'), []);
});

test('a quota error in the middle of a batch leaves no changes', async () => {
  const s = await open();
  await s.tx([
    { store: 'messages', put: { id: 'a', eventId: 'e', v: 1 } },
    { store: 'messages', put: { id: 'b', eventId: 'e', v: 1 } },
  ]);
  const before = ls.dump();
  ls.failOn(3); // journal, first record, then the second record fails
  await assert.rejects(s.tx([
    { store: 'messages', put: { id: 'a', eventId: 'e', v: 2 } },
    { store: 'messages', put: { id: 'c', eventId: 'e', v: 2 } },
    { store: 'messages', del: 'b' },
  ]), err => err.name === 'QuotaExceededError');
  assert.deepEqual(ls.dump(), before, 'old values restored, journal removed');
  // the journal itself doesn't fit: nothing written either
  ls.failOn(1);
  await assert.rejects(s.tx([{ store: 'messages', put: { id: 'z', eventId: 'e' } }]), /quota/);
  assert.deepEqual(ls.dump(), before);
  // and it still works afterwards
  await s.tx([{ store: 'messages', put: { id: 'c', eventId: 'e', v: 3 } }]);
  assert.equal((await s.get('messages', 'c')).v, 3);
});

test('a batch a dead tab left half-written is rolled back on the next open and before the next write', async () => {
  const s = await open();
  await s.tx([{ store: 'messages', put: { id: 'a', eventId: 'e', v: 1 } }]);
  const before = ls.dump();
  ls.freezeAfter(2); // journal and the first record get written, then nothing
  await assert.rejects(s.tx([
    { store: 'messages', put: { id: 'a', eventId: 'e', v: 2 } },
    { store: 'messages', put: { id: 'b', eventId: 'e', v: 2 } },
  ]));
  ls.thaw();
  assert.equal(JSON.parse(ls.getItem('test:v1:messages:a')).v, 2, 'half-written');
  assert.ok(ls.getItem('test:v1:#journal'));
  const s2 = await open();
  assert.deepEqual(s2.recovery, { rolledBack: 2 });
  assert.deepEqual(ls.dump(), before);

  // the same when another instance writes next (no reopen)
  ls.freezeAfter(2);
  await assert.rejects(s.tx([
    { store: 'messages', put: { id: 'a', eventId: 'e', v: 3 } },
    { store: 'messages', put: { id: 'b', eventId: 'e', v: 3 } },
  ]));
  ls.thaw();
  await s2.tx([{ store: 'counters', put: { id: 'x', eventId: 'e', last: 1 } }]);
  assert.equal((await s2.get('messages', 'a')).v, 1);
  assert.equal(await s2.get('messages', 'b'), undefined);
  assert.equal(ls.getItem('test:v1:#journal'), null);
});

test('without Web Locks a journal of another tab is never overwritten', async () => {
  const settle = { locks: null, journalSettleMs: 30 };
  const journal = (at = Date.now()) => JSON.stringify({ at, page: 'other-tab', changes: [{ k: 'test:v1:messages:a', before: null }] });
  // A tab crashed mid-batch and was reloaded at once (new page id, young
  // journal): it stays unchanged while we wait, so it is orphaned and
  // rolled back at open; writes work right away.
  ls.setItem('test:v1:#journal', journal());
  ls.setItem('test:v1:messages:a', '{"id":"a"}');
  const s = await open(settle);
  assert.equal(s.crossTabLock, false);
  assert.deepEqual(s.recovery, { rolledBack: 1 });
  assert.equal(await s.get('messages', 'a'), undefined);
  await s.tx([{ store: 'messages', put: { id: 'b', eventId: 'e' } }]);

  // Another tab keeps writing (its journal changes while we wait): the
  // write is refused, with a message for the user, and its journal stays.
  ls.setItem('test:v1:#journal', journal());
  const busy = setInterval(() => ls.setItem('test:v1:#journal', journal(Date.now() + Math.random())), 5);
  try {
    const err = await s.tx([{ store: 'messages', put: { id: 'c', eventId: 'e' } }]).catch(e => e);
    assert.ok(err instanceof StorageBusyError);
    assert.match(err.message, /von einem anderen Tab benutzt/);
    await assert.rejects(s.atomic(['messages'], async ({ put }) => put('messages', { id: 'c', eventId: 'e' })), StorageBusyError);
    assert.ok(ls.getItem('test:v1:#journal'), 'journal untouched');
    assert.equal(await s.get('messages', 'c'), undefined);
  } finally {
    clearInterval(busy);
  }
  // it stopped (the tab died): the next write rolls it back and goes through
  await s.tx([{ store: 'messages', put: { id: 'c', eventId: 'e' } }]);
  assert.ok(await s.get('messages', 'c'));
  assert.equal(ls.getItem('test:v1:#journal'), null);
  // older than a minute: rolled back without waiting
  ls.setItem('test:v1:#journal', journal(Date.now() - 120000));
  ls.setItem('test:v1:messages:a', '{"id":"a"}');
  const s2 = await open({ locks: null, journalSettleMs: 60000 });
  assert.deepEqual(s2.recovery, { rolledBack: 1 });
});

test('without Web Locks a failed rollback of this page is undone before the next write', async () => {
  const s = await open({ locks: null });
  await s.tx([{ store: 'messages', put: { id: 'a', eventId: 'e', v: 1 } }]);
  const before = ls.dump();
  ls.freezeAfter(2); // journal + first record; then the write and the rollback fail
  await assert.rejects(s.tx([
    { store: 'messages', put: { id: 'a', eventId: 'e', v: 2 } },
    { store: 'messages', put: { id: 'b', eventId: 'e', v: 2 } },
  ]));
  ls.thaw();
  assert.ok(ls.getItem('test:v1:#journal'), 'the journal stayed');
  await s.tx([{ store: 'counters', put: { id: 'c', eventId: 'e', last: 1 } }]);
  assert.equal((await s.get('messages', 'a')).v, 1);
  assert.equal(await s.get('messages', 'b'), undefined);
  assert.equal(ls.getItem('test:v1:#journal'), null);
  assert.deepEqual(Object.keys(ls.dump()).sort(), [...Object.keys(before), 'test:v1:counters:c'].sort());
});

const saveOn = (store, i) => saveNumbered(store, { opId: 'op1', prefix: 'W1', recordStore: 'messages' },
  ({ seq, number }) => ({ id: `${i}`, eventId: 'op1', prefix: 'W1', seq, number }));

test('two instances on one storage (two tabs) never take the same number', async () => {
  const locks = lockManager();
  const a = await open({ locks });
  const b = await open({ locks });
  const saved = await Promise.all(Array.from({ length: 40 }, (_, i) => saveOn(i % 2 ? a : b, i)));
  assert.deepEqual(saved.map(m => m.seq).sort((x, y) => x - y), Array.from({ length: 40 }, (_, i) => i + 1));
  const stored = await a.getByEvent('messages', 'op1');
  assert.equal(stored.length, 40);
  assert.deepEqual(numberGaps(stored), []);
  assert.equal((await b.get('counters', 'op1:W1')).last, 40);
});

test('the same with the platform Web Locks (navigator.locks)', { skip: !globalThis.navigator?.locks }, async () => {
  const a = await openToolStorage(SCHEMA);
  const b = await openToolStorage(SCHEMA);
  assert.equal(a.crossTabLock, true);
  const saved = await Promise.all(Array.from({ length: 20 }, (_, i) => saveOn(i % 2 ? a : b, i)));
  assert.equal(new Set(saved.map(m => m.number)).size, 20);
});

test('without a shared lock the per-instance queue does not exclude other tabs (documented limit)', async () => {
  const a = await open({ locks: null });
  const b = await open({ locks: null });
  const saved = await Promise.all([saveOn(a, 1), saveOn(b, 2)]);
  assert.deepEqual(saved.map(m => m.number), ['W1-001', 'W1-001']);
});

test('tx() and atomic() of two instances are serialised against each other', async () => {
  const locks = lockManager();
  const a = await open({ locks });
  const b = await open({ locks });
  await a.tx([{ store: 'counters', put: { id: 'c', eventId: 'e', last: 0 } }]);
  const incr = s => s.atomic(['counters'], async ({ get, put }) => {
    const c = await get('counters', 'c');
    await new Promise(r => setTimeout(r, 1)); // allowed on the fallback: it holds the lock
    put('counters', { ...c, last: c.last + 1 });
  });
  await Promise.all([incr(a), incr(b), b.tx([{ store: 'messages', put: { id: 'm', eventId: 'e' } }]), incr(a), incr(b)]);
  assert.equal((await a.get('counters', 'c')).last, 4);
});

test('compare-and-set: getUnchanged() in atomic(), ConflictError, nothing written', async () => {
  const s = await open();
  const rec = { id: 'm1', eventId: 'e', text: 'a', updated: '2026-10-01T10:00:00Z' };
  // expected undefined: the record must not exist yet
  await s.atomic(['messages'], async ({ getUnchanged, put }) => {
    assert.equal(await getUnchanged('messages', 'm1', undefined), undefined);
    put('messages', rec);
  });
  const edit = (expected, text) => s.atomic(['messages'], async ({ getUnchanged, put }) => {
    const cur = await getUnchanged('messages', 'm1', expected);
    put('messages', { ...cur, text, updated: `2026-10-01T10:0${text.length}:00Z` });
    put('messages', { id: 'side', eventId: 'e' });
  });
  await edit('2026-10-01T10:00:00Z', 'bb');
  const err = await edit('2026-10-01T10:00:00Z', 'ccc').catch(e => e);
  assert.ok(err instanceof ConflictError);
  assert.equal(err.name, 'ConflictError');
  assert.deepEqual([err.store, err.key, err.expected, err.actual], ['messages', 'm1', '2026-10-01T10:00:00Z', '2026-10-01T10:02:00Z']);
  assert.equal(err.current.text, 'bb');
  assert.equal((await s.get('messages', 'm1')).text, 'bb');
  await s.tx([{ store: 'messages', del: 'side' }]);
  await assert.rejects(edit('2026-10-01T10:00:00Z', 'ddd'), ConflictError);
  assert.equal(await s.get('messages', 'side'), undefined, 'the other put of the failed call was not written');
  await assert.rejects(s.atomic(['messages'], ({ getUnchanged }) => getUnchanged('messages', 'm1', undefined)), ConflictError);

  assert.equal(assertUnchanged('s', 'k', { updated: 'x' }, 'x').updated, 'x');
  assert.throws(() => assertUnchanged('s', 'k', undefined, 'x'), err => err instanceof ConflictError && err.actual === undefined);
  assert.equal(assertUnchanged('s', 'k', { id: 1 }, null).id, 1, 'a record without `updated` matches null');
});

test('the fallback has no fallback data to move', async () => {
  const s = await open();
  assert.equal(s.kind, 'localstorage');
  assert.equal(await s.fallbackData(), null);
  assert.ok(s.fallbackReason instanceof Error);
});
