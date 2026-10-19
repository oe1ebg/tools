// The shared callsign service (tools/shared/js/callsign-service.js): the
// one lookup of every tool. Synthetic callsigns and fictitious names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../tools/netlog/js/memstore.js';
import { createCallsignService } from '../tools/shared/js/callsign-service.js';
import { CALLSIGN_STORES, importCallsignSource, setCallsignSourceEnabled, deleteCallsignSource } from '../tools/shared/js/callsign-store.js';
import { CALLSIGN_BUILTIN_ID } from '../tools/shared/js/callsign-merge.js';
import { locationOptions } from '../tools/shared/js/locfield.js';
import { LOC_ORIGINS, locOrigin } from '../tools/shared/js/locmeta.js';

const DATA = { stand: '2026-09-10', source: 'x', calls: [['OE0QXA', 'Anna Amtlich', '1010 Wien'], ['OE0QXD', '', ''], ['OE1ABC', 'Carla Cäsar', '1020 Wien']] };
const row = (call, extra = {}) => ({ call, base: call, ...extra });

async function make({ store = memoryStore(CALLSIGN_STORES), data = DATA } = {}) {
  const calls = createCallsignService({ openStore: async () => store, loadBook: async () => data });
  await calls.init();
  return { calls, store };
}

test('before init and without the store the lookup answers from the Austrian list alone, empty until it is loaded', async () => {
  const calls = createCallsignService({ openStore: async () => null, loadBook: async () => DATA });
  assert.equal(calls.entry('OE0QXA'), null);                       // nothing loaded yet, no error
  assert.deepEqual(calls.search('OE0QX'), []);
  assert.equal(calls.official('OE0QXA').enabled, false);
  await calls.init();
  assert.equal(calls.available(), false);                          // no IndexedDB: not an error
  assert.equal(calls.entry('OE0QXA').name, 'Anna Amtlich');
  assert.deepEqual(calls.summary(), { available: false, active: 1, total: 1 });
  assert.equal(calls.stand(), '2026-09-10');
});

test('entry: merged over the lists, with the list to name only when it is not the Austrian one', async () => {
  const { calls, store } = await make();
  assert.equal(calls.entry('OE0QXA').source, '');                  // Austrian list: no mention
  await importCallsignSource(store, { kind: 'csv', name: 'Meine Liste', rows: [row('OE0QXA', { name: 'Anna Privat' }), row('OE0QXB', { name: 'Bernd' })] });
  await calls.reload();
  const e = calls.entry('oe0qxa/p');
  assert.equal(e.call, 'OE0QXA');
  assert.equal(e.name, 'Anna Privat');
  assert.equal(e.source, 'Meine Liste');
  assert.equal(e.qth, '1010 Wien');                                 // the Austrian list fills the rest
  assert.equal(e.qthOfficial, true);
  assert.equal(calls.entry('OE0QXB').source, 'Meine Liste');
  assert.equal(calls.entry('OE9ZZZ'), null);
  assert.equal(calls.label('OE0QXA'), 'Anna Privat, 1010 Wien');
  assert.equal(calls.label('OE9ZZZ'), '');
  assert.ok(calls.has('OE0QXB') && !calls.has('OE9ZZZ'));
});

test('a callsign that only a note names: the note\'s list is named', async () => {
  const { calls, store } = await make();
  await importCallsignSource(store, { kind: 'polo', name: 'Hams of Note', rows: [row('OE0QXC', { note: '🌳 POTA' })] });
  await calls.reload();
  const e = calls.entry('OE0QXC');
  assert.equal(e.note, '🌳 POTA');
  assert.equal(e.source, 'Hams of Note');
});

test('official(): the Austrian list alone, whatever other lists say; off means "no conclusion"', async () => {
  const { calls, store } = await make();
  await importCallsignSource(store, { kind: 'csv', name: 'Mine', rows: [row('OE0QXB', { name: 'Bernd' })] });
  await calls.reload();
  const inMine = calls.official('OE0QXB');
  assert.equal(inMine.entry, null);                                 // a user list never makes a call "listed"
  assert.equal(inMine.enabled, true);
  assert.equal(inMine.isOE, true);
  assert.equal(inMine.stand, '2026-09-10');
  assert.deepEqual(calls.official('OE1ABC/P').entry, ['OE1ABC', 'Carla Cäsar', '1020 Wien']);
  await setCallsignSourceEnabled(store, CALLSIGN_BUILTIN_ID, false);
  await calls.reload();
  const off = calls.official('OE1ABC');
  assert.equal(off.enabled, false);                                 // callers must not warn "not in the list"
  assert.equal(off.entry, null);
  assert.equal(calls.entry('OE1ABC'), null);
  assert.equal(calls.entry('OE0QXB').name, 'Bernd');
  assert.equal(calls.stand(), '');
});

test('search is the directory search over the lists switched on, with the kind of the list', async () => {
  const { calls, store } = await make();
  const mine = await importCallsignSource(store, { kind: 'csv', name: 'Mine', rows: [row('OE0QXE', { name: 'Eva' })] });
  await calls.reload();
  assert.deepEqual(calls.search('OE0QX?').map(m => m.call), ['OE0QXA', 'OE0QXD', 'OE0QXE']);
  const hits = calls.search('OE0QXE');
  assert.equal(hits[0].fromKind, 'csv');
  assert.equal(calls.search('OE0QXA')[0].fromKind, 'builtin');
  await deleteCallsignSource(store, mine.id);
  await calls.reload();
  assert.deepEqual(calls.search('OE0QX?').map(m => m.call), ['OE0QXA', 'OE0QXD']);
});

test('version and onChange: every rebuild counts; refresh() reads only what changed elsewhere', async () => {
  const store = memoryStore(CALLSIGN_STORES);
  const { calls } = await make({ store });
  const other = createCallsignService({ openStore: async () => store, loadBook: async () => DATA });   // another tab or tool
  await other.init();
  let fired = 0;
  const off = calls.onChange(() => fired++);
  const v = calls.version();
  assert.equal(await calls.refresh(), false);                       // nothing changed
  assert.equal(calls.version(), v);
  await importCallsignSource(other.store(), { kind: 'csv', name: 'Elsewhere', rows: [row('OE0QXB', { name: 'Bernd' })] });
  assert.equal(calls.entry('OE0QXB'), null);                        // not seen yet
  assert.equal(await calls.refresh(), true);                        // seen after the window regains focus
  assert.equal(calls.entry('OE0QXB').name, 'Bernd');
  assert.ok(calls.version() > v);
  assert.equal(fired, 1);
  assert.equal(await calls.refresh(), false);
  off();
  await calls.reload();
  assert.equal(fired, 1);                                           // unsubscribed
});

test('the order of the lists decides, and a refresh sees a new order', async () => {
  const store = memoryStore(CALLSIGN_STORES);
  const { calls } = await make({ store });
  const a = await importCallsignSource(store, { kind: 'csv', name: 'A', rows: [row('OE0QXA', { name: 'Von A' })] });
  await calls.reload();
  assert.equal(calls.entry('OE0QXA').name, 'Von A');                // above the Austrian list
  const { moveCallsignSource } = await import('../tools/shared/js/callsign-store.js');
  await moveCallsignSource(store, CALLSIGN_BUILTIN_ID, -1);
  assert.equal(await calls.refresh(), true);
  assert.equal(calls.entry('OE0QXA').name, 'Anna Amtlich');         // the Austrian list is on top now
  assert.ok(a.id);
});

test('location options: the Austrian city as before, a city of another list named, never mixed up', () => {
  assert.deepEqual(locationOptions(null, '1010 Wien').map(o => [o.label, o.origin]), [['laut Rufzeichenliste: 1010 Wien', 'callbook']]);
  assert.deepEqual(locationOptions(null, { city: 'Graz', list: 'Meine Liste' }).map(o => [o.label, o.origin]), [['laut Liste „Meine Liste“: Graz', 'list']]);
  assert.deepEqual(locationOptions(null, ''), []);
  assert.ok(LOC_ORIGINS.list && LOC_ORIGINS.callbook);
  assert.equal(locOrigin({ origin: 'list' }, ''), 'list');
  assert.equal(locOrigin({ origin: 'unknown-in-old-versions' }, ''), '');   // an older app shows no label, nothing breaks
});
