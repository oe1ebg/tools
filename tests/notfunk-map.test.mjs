// The Notfunk map's choice of messages and pins (tools/notfunk/js/mapdata.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesForMap, placeTextsToResolve, groupByPlace, pinPriority } from '../tools/notfunk/js/mapdata.js';

const at = (lat, lon, label = 'X') => ({ lat, lon, label, maidenhead: 'JN88ee' });
const m = (id, extra) => ({ id, number: `W1-00${id}`, ts: `2026-10-08T12:0${id}:00Z`, priority: 'routine', ...extra });

test('stored places first, texts resolved now, unresolved and missing ones counted; deleted never', () => {
  const msgs = [
    m(1, { location: at(48.2, 16.37), locationText: 'Stephansplatz' }),
    m(2, { locationText: 'Brünner Straße 68' }),
    m(3, { locationText: 'Irgendwo (fiktiv)' }),
    m(4, {}),
    m(5, { location: at(48.1, 16.3), deleted: '2026-10-08T13:00:00Z' }),
    m(6, { location: { lat: null, lon: null }, locationText: '' }),
  ];
  assert.deepEqual(placeTextsToResolve(msgs), ['Brünner Straße 68', 'Irgendwo (fiktiv)']);
  const resolved = new Map([['Brünner Straße 68', at(48.27, 16.4)], ['Irgendwo (fiktiv)', null]]);
  assert.deepEqual(placeTextsToResolve(msgs, resolved), []);
  const r = messagesForMap(msgs, resolved);
  assert.deepEqual(r.placed.map(p => [p.msg.id, p.fromText]), [[1, false], [2, true]]);
  assert.deepEqual(r.unplaced.map(x => x.id), [3]);
  assert.equal(r.noPlace, 2);
});

test('messages at one place share a pin, newest first; the pin takes the most pressing priority', () => {
  const p = at(48.2, 16.37);
  const placed = [
    { msg: m(1, { priority: 'priority' }), loc: p, fromText: false },
    { msg: m(2, {}), loc: at(48.2000001, 16.3700001), fromText: true },
    { msg: m(3, { priority: 'emergency' }), loc: at(48.3, 16.5), fromText: false },
  ];
  const g = groupByPlace(placed);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].items.map(i => i.msg.id), [2, 1]);
  assert.equal(pinPriority(g[0].items), 'priority');
  assert.equal(pinPriority(g[1].items), 'emergency');
  assert.equal(pinPriority([{ msg: m(9, {}) }]), 'routine');
});
