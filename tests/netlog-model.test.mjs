// Netlog's pure data model (tools/netlog/js/model.js): callsign identity
// and partial callsigns, session numbering, order changes that never touch
// history, presence intervals. Synthetic callsigns only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normCall, baseCall, isUnresolved, callPattern, callCandidates, nextSessionNumber, sessionLabel,
  sessionsOf, moveInOrder, rosterSorted, changeStatus, timeOf, seriesDefaults,
} from '../tools/netlog/js/model.js';

test('callsigns: entered spelling kept, base identity for matching', () => {
  assert.equal(normCall(' oe0qxa/p '), 'OE0QXA/P');
  assert.equal(baseCall('OE0QXA/P'), 'OE0QXA');
  assert.equal(baseCall('OE/DL0QXB/M'), 'DL0QXB');
  assert.equal(baseCall('OE0QXA'), 'OE0QXA');
  assert.equal(baseCall('OE0QX?'), 'OE0QX?');
  assert.equal(baseCall(''), '');
});

test('partial and unknown callsigns are unresolved and match candidates', () => {
  for (const c of ['OE0QX?', '?QXB', '?', '', 'OE0*']) assert.ok(isUnresolved(c), c);
  assert.ok(!isUnresolved('OE0QXA'));
  assert.ok(callPattern('OE0QX?').test('OE0QXB'));
  assert.ok(!callPattern('OE0QX?').test('OE0QX'));
  assert.ok(callPattern('?QXB').test('OE0QXB'));
  assert.ok(!callPattern('?QXB').test('OE0QXC'));
  assert.ok(callPattern('?').test('OE0QXC'));
  assert.ok(callPattern('OE0QXA').test('OE0QXA'));
  assert.ok(!callPattern('OE0QXA').test('OE0QXAB'));
  assert.equal(callPattern(''), null);
  const pool = [{ call: 'OE0QXB', name: 'Jonas' }, { call: 'OE0QXC/P', name: 'Lea' }, { call: 'OE0QXB', name: 'Jonas' }, { call: 'OE0QX?' }, { call: 'DL0QXZ' }];
  assert.deepEqual(callCandidates('OE0QX?', pool).map(c => c.call), ['OE0QXB', 'OE0QXC/P']);
  assert.deepEqual(callCandidates('?QXB', pool).map(c => c.call), ['OE0QXB']);
  assert.deepEqual(callCandidates('', pool), []);
});

test('session numbers: one above the highest given, missed dates never counted', () => {
  const sessions = [
    { id: 'a', seriesId: 's', number: 435, date: '2026-10-01' },
    { id: 'b', seriesId: 's', number: 437, date: '2026-10-15' }, // 436 was skipped by the user
    { id: 'c', seriesId: 's', number: 999, date: '2026-10-16', deleted: '2026-10-16T00:00:00Z' },
    { id: 'd', seriesId: 'other', number: 2000 },
    { id: 'e', seriesId: 's', number: null },
  ];
  assert.equal(nextSessionNumber(sessions, 's'), 438);
  assert.equal(nextSessionNumber(sessions, 'new'), 1);
  assert.equal(sessionLabel({ number: 437, name: '' }, { name: 'Evening net' }), 'Evening net #437');
  assert.equal(sessionLabel({ number: null, name: 'Ad hoc' }, null), 'Ad hoc');
  // newest first, deleted left out
  assert.deepEqual(sessionsOf(sessions, 's').map(s => s.id), ['b', 'a', 'e']);
});

test('series defaults are copied values', () => {
  const series = { defaults: { repeater: 'OE0XRA', ncs: 'OE0QXA' } };
  const d = seriesDefaults(series);
  series.defaults.repeater = 'changed later';
  assert.equal(d.radio.repeater, 'OE0XRA');
  assert.equal(d.suggestedNcs, 'OE0QXA');
});

test('moveInOrder swaps neighbours only, also with missing order values', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(moveInOrder(list, 'b', -1, 'order'), [{ id: 'a', order: 2 }, { id: 'b', order: 1 }, { id: 'c', order: 3 }]);
  assert.deepEqual(moveInOrder(list, 'a', -1, 'order'), []);
  assert.deepEqual(moveInOrder(list, 'c', 1, 'order'), []);
  const numbered = [{ id: 'a', order: 1 }, { id: 'b', order: 2 }, { id: 'c', order: 3 }];
  assert.deepEqual(moveInOrder(numbered, 'c', -1, 'order'), [{ id: 'b', order: 3 }, { id: 'c', order: 2 }]);
});

test('roster order: explicit order, stable for equal values, deleted left out', () => {
  const ps = [
    { id: 'x', rosterOrder: 2, created: '2026-10-16T19:00:01Z' },
    { id: 'y', rosterOrder: 1, created: '2026-10-16T19:00:02Z' },
    { id: 'z', rosterOrder: 1, created: '2026-10-16T19:00:00Z' },
    { id: 'w', rosterOrder: 0, deleted: '2026-10-16T19:01:00Z' },
  ];
  assert.deepEqual(rosterSorted(ps).map(p => p.id), ['z', 'y', 'x']);
});

test('status changes: checkout closes the interval, reentry opens a new one, pause keeps it', () => {
  let p = { id: 'p', status: 'active', presence: [{ from: timeOf('2026-10-16T19:00:00Z'), to: null }] };
  const paused = changeStatus(p, 'paused', '2026-10-16T19:05:00Z');
  assert.equal(paused.participant.presence.length, 1);
  assert.equal(paused.participant.presence[0].to, null);
  p = changeStatus(paused.participant, 'out', '2026-10-16T19:10:00Z').participant;
  assert.equal(p.presence[0].to.iso, '2026-10-16T19:10:00Z');
  const back = changeStatus(p, 'active', '2026-10-16T19:20:00Z');
  assert.equal(back.participant.presence.length, 2);
  assert.equal(back.participant.presence[1].from.iso, '2026-10-16T19:20:00Z');
  assert.deepEqual(back.event, { type: 'status', participantId: 'p', from: 'out', to: 'active', time: { iso: '2026-10-16T19:20:00Z', quality: 'exact' } });
  assert.equal(changeStatus(back.participant, 'active', '2026-10-16T19:21:00Z'), null);
  assert.equal(changeStatus(back.participant, 'bogus', '2026-10-16T19:21:00Z'), null);
});

test('times: unknown has no instant, never invented precision', () => {
  assert.deepEqual(timeOf(null), { iso: null, quality: 'unknown' });
  assert.deepEqual(timeOf('2026-10-16T19:00:00Z', 'estimated'), { iso: '2026-10-16T19:00:00Z', quality: 'estimated' });
  assert.deepEqual(timeOf('2026-10-16T19:00:00Z', 'unknown'), { iso: '2026-10-16T19:00:00Z', quality: 'exact' });
});
