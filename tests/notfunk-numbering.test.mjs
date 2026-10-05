// Gapless, never-reused message numbers (tools/notfunk/js/numbering.js) on
// the real shared storage layer. Node has no IndexedDB, so openToolStorage()
// takes its localStorage fallback — the weaker of the two backends.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openToolStorage } from '../tools/shared/js/storage.js';
import {
  saveNumbered, nextSeq, formatNumber, parseNumber, normalizePrefix, counterAfterImport, numberGaps, counterKey,
} from '../tools/notfunk/js/numbering.js';

class MemoryStorage {
  #m = new Map();
  get length() { return this.#m.size; }
  key(i) { return [...this.#m.keys()][i] ?? null; }
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
}

const SCHEMA = {
  name: 'test', version: 1, lsPrefix: 'test:',
  stores: { messages: { keyPath: 'id', byEvent: true }, counters: { keyPath: 'id', byEvent: true } },
  upgrade() {},
};
let store;
beforeEach(async () => {
  globalThis.localStorage = new MemoryStorage();
  store = await openToolStorage(SCHEMA);
});

let n = 0;
const save = (prefix, extra = {}, opId = 'op1') => saveNumbered(store, { opId, prefix, recordStore: 'messages' },
  ({ seq, number }) => ({ id: `m${++n}`, eventId: opId, prefix, seq, number, ...extra }));

test('format, parse, normalize', () => {
  assert.equal(formatNumber('W1', 7), 'W1-007');
  assert.equal(formatNumber('W1', 1234), 'W1-1234');
  assert.deepEqual(parseNumber(' w1-007 '), { prefix: 'W1', seq: 7 });
  for (const bad of ['W1', '-7', 'W1-', 'TOOLONG-1', 'W 1-2', null]) assert.equal(parseNumber(bad), null, String(bad));
  assert.equal(normalizePrefix(' w-1 '), 'W1');
});

test('numbers are sequential per prefix and stored with the counter', async () => {
  const a = [];
  for (let i = 0; i < 5; i++) a.push((await save('W1')).number);
  assert.deepEqual(a, ['W1-001', 'W1-002', 'W1-003', 'W1-004', 'W1-005']);
  assert.equal((await save('W2')).number, 'W2-001', 'other prefix: own sequence');
  assert.equal((await save('W1', {}, 'op2')).number, 'W1-001', 'other operation: own sequence');
  assert.equal((await store.get('counters', counterKey('op1', 'W1'))).last, 5);
});

test('concurrent saves in one tab never share a number', async () => {
  const msgs = await Promise.all(Array.from({ length: 25 }, () => save('W1')));
  assert.deepEqual(msgs.map(m => m.seq).sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.deepEqual(numberGaps(await store.getByEvent('messages', 'op1')), []);
});

test('a failed save consumes no number', async () => {
  await save('W1');
  await assert.rejects(saveNumbered(store, { opId: 'op1', prefix: 'W1', recordStore: 'messages' }, () => { throw new Error('boom'); }), /boom/);
  await assert.rejects(saveNumbered(store, { opId: 'op1', prefix: 'W1', recordStore: 'messages' }, ({ seq }) => ({ id: 'x', eventId: 'op1', prefix: 'W1', seq: seq + 1 })), /must keep/);
  assert.equal((await save('W1')).number, 'W1-002');
  assert.equal((await store.getAll('messages')).length, 2);
  await assert.rejects(save('w 1!'), /Stationskürzel/);
});

test('deleted (soft) and edited messages keep their numbers; nothing is reused', async () => {
  const m1 = await save('W1');
  const m2 = await save('W1');
  await store.tx([{ store: 'messages', put: { ...m2, deleted: '2026-10-05T10:00:00Z' } }]);
  await store.tx([{ store: 'messages', put: { ...m1, text: 'edited' } }]);
  assert.equal((await save('W1')).number, 'W1-003');
});

test('a lost counter (crash between the two writes) still never reuses a number', async () => {
  await save('W1');
  await save('W1');
  await store.tx([{ store: 'counters', del: counterKey('op1', 'W1') }]);
  assert.equal(nextSeq(undefined, await store.getByEvent('messages', 'op1'), 'W1'), 3);
  assert.equal((await save('W1')).number, 'W1-003');
});

test('restore: counters never go down', () => {
  const existing = [{ id: 'op1:W1', eventId: 'op1', prefix: 'W1', last: 9 }];
  const backup = [
    { eventId: 'op1', prefix: 'W1', seq: 4 }, // older backup: W1 got to 9 since
    { eventId: 'op1', prefix: 'W2', seq: 3 }, // another device
    { eventId: 'op2', prefix: 'W1', seq: 50 }, // other operation, ignored
  ];
  assert.deepEqual(counterAfterImport(existing, backup, 'op1'), [
    { id: 'op1:W1', eventId: 'op1', prefix: 'W1', last: 9 },
    { id: 'op1:W2', eventId: 'op1', prefix: 'W2', last: 3 },
  ]);
});

test('numberGaps', () => {
  assert.deepEqual(numberGaps([{ prefix: 'A', seq: 1 }, { prefix: 'A', seq: 3 }, { prefix: 'B', seq: 1 }]), ['A-002']);
});
