// The data behind the roster report (PDF and page): span, rows, presence timeline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rosterData, rosterDur } from '../tools/netlog/js/rosterdata.js';

const at = hm => ({ iso: `2026-10-21T${hm}:00.000Z`, quality: 'exact' });
const person = (id, call, order, status, presence) => ({ id, call, base: call, name: '', status, rosterOrder: order, presence, deleted: null });

function app() {
  const a = person('a', 'OE0QXA', 1, 'active', [{ from: at('18:00'), to: null }]);
  const b = person('b', 'OE0QXB', 2, 'out', [{ from: at('18:00'), to: at('18:50') }]);
  const c = person('c', 'OE0QXC', 3, 'active', [{ from: at('18:10'), to: null }]);
  return {
    s: { ncsId: 'b', own: { call: 'OE0QXC', base: 'OE0QXC' } },
    sd: {
      participants: [a, b, c],
      notes: [{ id: 'n1', participantId: 'a', time: at('18:20'), deleted: null }, { id: 'n2', participantId: 'a', time: at('18:30'), deleted: null }],
      contributions: [],
      events: [
        { id: 'e1', type: 'ncs', from: 'a', to: 'b', time: at('18:15'), deleted: null },
        { id: 'e2', type: 'status', participantId: 'a', from: 'active', to: 'paused', time: at('18:25'), deleted: null },
        { id: 'e3', type: 'status', participantId: 'a', from: 'paused', to: 'active', time: at('18:35'), deleted: null },
        { id: 'e5', type: 'status', participantId: 'b', from: 'active', to: 'out', time: at('18:50'), deleted: null },
        { id: 'e4', type: 'round', kind: 'closed', time: at('19:00'), deleted: null },
      ],
    },
  };
}

test('rosterDur: hh:mm, "-" for none or over a day', () => {
  assert.equal(rosterDur(56 * 60000), '00:56');
  assert.equal(rosterDur(65 * 60000), '01:05');
  assert.equal(rosterDur(NaN), '-');
  assert.equal(rosterDur(-1), '-');
  assert.equal(rosterDur(25 * 3600000), '-');
});

test('rosterData: span to the net closed, rows with in / out / duration, NCS and me tags', () => {
  const d = rosterData(app());
  assert.deepEqual(d.span, { start: '2026-10-21T18:00:00.000Z', end: '2026-10-21T19:00:00.000Z', closed: true });
  assert.deepEqual(d.rows.map(r => [r.p.id, r.ncs, r.me]), [['b', 'current', false], ['a', 'former', false], ['c', null, true]]);
  const row = id => d.rows.find(r => r.p.id === id);
  assert.equal(rosterDur(row('b').ms), '00:50'); // checked out at 18:50
  assert.equal(rosterDur(row('a').ms), '01:00'); // still in: runs to the closing of the net
  assert.equal(row('a').notes, 2);
  assert.equal(row('b').outAt, '2026-10-21T18:50:00.000Z');
});

test('rosterData: the timeline has stretches by status, gaps while out, net control runs and note times', () => {
  const d = rosterData(app());
  const row = id => d.chart.rows.find(r => r.p.id === id);
  const m = hm => Date.parse(`2026-10-21T${hm}:00.000Z`);
  assert.deepEqual(row('a').stretches.map(s => [s.status, s.from, s.to]), [['active', m('18:00'), m('18:25')], ['paused', m('18:25'), m('18:35')], ['active', m('18:35'), m('19:00')]]);
  assert.deepEqual(row('b').stretches.map(s => [s.status, s.to]), [['active', m('18:50')]], 'nothing after the check-out');
  assert.deepEqual(row('a').ncs, [[m('18:00'), m('18:15')]]); // before the handover: the station it was taken from
  assert.deepEqual(row('b').ncs, [[m('18:15'), m('19:00')]]);
  assert.deepEqual(row('a').notes, [m('18:20'), m('18:30')]);
  assert.equal(d.chart.t0, m('18:00'));
});

test('rosterData: no stations, no chart', () => {
  const d = rosterData({ s: { ncsId: null }, sd: { participants: [], notes: [], contributions: [], events: [] } });
  assert.deepEqual([d.rows.length, d.chart], [0, null]);
});
