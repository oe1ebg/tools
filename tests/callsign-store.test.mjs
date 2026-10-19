// The shared callsign store: sources kept apart, per-field merge in rank
// order, switching sources off, generations (replace/undo), soft delete and
// erasure (tools/shared/js/callsign-store.js, callsign-merge.js).
// Synthetic callsigns and fictitious names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../tools/netlog/js/memstore.js';
import { buildCallbook } from '../tools/shared/js/callbook.js';
import { buildCallsignDirectory, CALLSIGN_BUILTIN_ID } from '../tools/shared/js/callsign-merge.js';
import {
  CALLSIGN_STORES, CALLSIGN_SCHEMA, ensureBuiltinSource, loadCallsignStore, importCallsignSource,
  swapCallsignGeneration, setCallsignSourceEnabled, deleteCallsignSource, restoreCallsignSource,
  moveCallsignSource, eraseCallsignSource,
} from '../tools/shared/js/callsign-store.js';

const book = buildCallbook({ calls: [['OE0QXA', 'Anna Amtlich', '1010 Wien'], ['OE0QXD', '', '']] });
const row = (call, extra = {}) => ({ call, base: call, ...extra });

async function fresh() {
  const store = memoryStore(CALLSIGN_STORES);
  await ensureBuiltinSource(store, 'Österreichische Rufzeichenliste');
  return store;
}
async function dir(store, callbook = book) {
  return buildCallsignDirectory({ ...(await loadCallsignStore(store)), callbook });
}

test('schema: stable name, every store created', () => {
  assert.equal(CALLSIGN_SCHEMA.name, 'oe1ebg-callsigns');
  assert.equal(CALLSIGN_SCHEMA.version, 1);
  const created = [];
  CALLSIGN_SCHEMA.upgrade(0, n => created.push(n));
  assert.deepEqual(created.sort(), Object.keys(CALLSIGN_STORES).sort());
});

test('the same callsign from several sources stays separate; the first source wins per field', async () => {
  const s = await fresh();
  await importCallsignSource(s, { kind: 'csv', name: 'Meine Liste', rows: [row('OE0QXA', { name: 'Anna Privat' })] });
  await importCallsignSource(s, { kind: 'polo', name: 'Hams of Note', rows: [row('OE0QXA', { note: '🤩 Elmer' }), row('OE0QXA', { note: '🌳 POTA' })] });
  const hit = (await dir(s)).lookup('OE0QXA/P');
  assert.equal(hit.name, 'Anna Privat');
  assert.equal(hit.from.name, 'Meine Liste');
  assert.equal(hit.qth, '1010 Wien');                 // Austrian list fills the gap
  assert.equal(hit.from.qth, 'Österreichische Rufzeichenliste');
  assert.deepEqual(hit.notes.map(n => n.text), ['🤩 Elmer', '🌳 POTA']);
  assert.equal(hit.entries.length, 4);
  assert.equal((await s.getAll('records')).length, 3);   // nothing overwritten
});

test('switching a source off, including the Austrian list, removes it from the answer', async () => {
  const s = await fresh();
  const mine = await importCallsignSource(s, { kind: 'csv', name: 'Meine Liste', rows: [row('OE0QXA', { name: 'Anna Privat' })] });
  await setCallsignSourceEnabled(s, CALLSIGN_BUILTIN_ID, false);
  let hit = (await dir(s)).lookup('OE0QXA');
  assert.equal(hit.qth, '');
  assert.equal((await dir(s)).lookup('OE0QXD'), null);   // only in the Austrian list
  await setCallsignSourceEnabled(s, mine.id, false);
  assert.equal((await dir(s)).lookup('OE0QXA'), null);
  await setCallsignSourceEnabled(s, CALLSIGN_BUILTIN_ID, true);
  hit = (await dir(s)).lookup('OE0QXA');
  assert.equal(hit.name, 'Anna Amtlich');
});

test('order: moving a source changes which value wins; the built-in list is last by default', async () => {
  const s = await fresh();
  const a = await importCallsignSource(s, { kind: 'csv', name: 'A', rows: [row('OE0QXA', { name: 'Von A' })] });
  const b = await importCallsignSource(s, { kind: 'csv', name: 'B', rows: [row('OE0QXA', { name: 'Von B' })] });
  assert.equal((await dir(s)).lookup('OE0QXA').name, 'Von A');
  assert.ok(await moveCallsignSource(s, b.id, -1));
  assert.equal((await dir(s)).lookup('OE0QXA').name, 'Von B');
  assert.ok(!(await moveCallsignSource(s, b.id, -1)));    // already first
  assert.deepEqual((await dir(s)).sources.map(x => x.id), [b.id, a.id, CALLSIGN_BUILTIN_ID]);
});

test('re-import replaces a source, keeps the generation before for undo, erases older ones', async () => {
  const s = await fresh();
  const src = await importCallsignSource(s, { kind: 'csv', name: 'L', rows: [row('OE0QXA', { name: 'Eins' })] });
  const two = await importCallsignSource(s, { kind: 'csv', name: 'L', rows: [row('OE0QXA', { name: 'Zwei' }), row('OE0QXB', { name: 'Neu' })], replaceId: src.id });
  assert.equal(two.gen, 2); assert.equal(two.prevGen, 1); assert.equal(two.count, 2);
  assert.equal((await dir(s)).lookup('OE0QXA').name, 'Zwei');
  assert.equal((await s.getAll('records')).length, 3);   // gen 1 kept for undo
  const back = await swapCallsignGeneration(s, src.id);
  assert.equal(back.gen, 1); assert.equal(back.count, 1);
  assert.equal((await dir(s)).lookup('OE0QXA').name, 'Eins');
  assert.equal((await dir(s)).lookup('OE0QXB'), null);
  await swapCallsignGeneration(s, src.id);                // forward again
  assert.equal((await dir(s)).lookup('OE0QXB').name, 'Neu');
  await importCallsignSource(s, { kind: 'csv', name: 'L', rows: [row('OE0QXC')], replaceId: src.id });
  assert.deepEqual((await s.getAll('records')).map(r => r.gen).sort(), [2, 2, 3]);   // gen 1 erased
});

test('a failing import writes nothing', async () => {
  const s = await fresh();
  s.failWrites = (store, v) => (store === 'sources' && v.kind === 'csv' ? new Error('disk full') : null);
  await assert.rejects(importCallsignSource(s, { kind: 'csv', name: 'L', rows: [row('OE0QXA')] }));
  assert.equal((await s.getAll('records')).length, 0);
});

test('soft delete hides, restore brings back, erase removes records and source; built-in cannot be erased', async () => {
  const s = await fresh();
  const src = await importCallsignSource(s, { kind: 'csv', name: 'L', rows: [row('OE0QXB', { name: 'Bernd' })] });
  await deleteCallsignSource(s, src.id);
  assert.equal((await dir(s)).lookup('OE0QXB'), null);
  assert.equal((await s.getAll('records')).length, 1);
  await restoreCallsignSource(s, src.id);
  assert.equal((await dir(s)).lookup('OE0QXB').name, 'Bernd');
  await eraseCallsignSource(s, src.id);
  assert.equal((await s.getAll('records')).length, 0);
  assert.equal(await s.get('sources', src.id), undefined);
  await assert.rejects(eraseCallsignSource(s, CALLSIGN_BUILTIN_ID));
});

test('search: callsign prefix and name/QTH over all enabled sources', async () => {
  const s = await fresh();
  await importCallsignSource(s, { kind: 'csv', name: 'L', rows: [row('OE0QXB', { name: 'Bernd Müller', qth: 'Graz' })] });
  const d = await dir(s);
  assert.deepEqual(d.search('OE0QX').map(m => m.call), ['OE0QXA', 'OE0QXB', 'OE0QXD']);
  assert.deepEqual(d.search('muller').map(m => m.call), ['OE0QXB']);
  assert.deepEqual(d.search('wien').map(m => m.call), ['OE0QXA']);
  assert.deepEqual(d.search('').map(m => m.call), []);
});

test('ensureBuiltinSource is idempotent', async () => {
  const s = await fresh();
  await ensureBuiltinSource(s, 'x');
  assert.equal((await s.getAll('sources')).length, 1);
});
