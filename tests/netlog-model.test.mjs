// Netlog's pure data model (tools/netlog/js/model.js): callsign identity
// and partial callsigns, session numbering, order changes that never touch
// history, presence intervals. Synthetic callsigns only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normCall, callBase, isUnresolved, callPattern, callCandidates, nextSessionNumber, sessionLabel,
  sessionsOf, moveInOrder, rosterSorted, changeStatus, timeOf, seriesDefaults,
} from '../tools/netlog/js/model.js';

test('callsigns: entered spelling kept, base identity for matching', () => {
  assert.equal(normCall(' oe0qxa/p '), 'OE0QXA/P');
  assert.equal(callBase('OE0QXA/P'), 'OE0QXA');
  assert.equal(callBase('OE/DL0QXB/M'), 'DL0QXB');
  assert.equal(callBase('OE0QXA'), 'OE0QXA');
  assert.equal(callBase('OE0QX?'), 'OE0QX?');
  assert.equal(callBase(''), '');
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

import { roundsSorted, previousRound, nextRoundNumber, nextSeq, roundSummary, queueItems, roundCounts, openTurn, responseOf } from '../tools/netlog/js/model.js';

test('rounds: session order, previous is the immediately preceding one (also empty), none in the first', () => {
  const rounds = [{ id: 'r4', number: 4, order: 4 }, { id: 'r2', number: 2, order: 2 }, { id: 'r3', number: 3, order: 3 }, { id: 'rx', number: 9, order: 9, deleted: 'x' }];
  assert.deepEqual(roundsSorted(rounds).map(r => r.id), ['r2', 'r3', 'r4']);
  assert.equal(previousRound(rounds, 'r4').id, 'r3');
  assert.equal(previousRound(rounds, 'r2'), null);
  assert.equal(nextRoundNumber(rounds), 5);
  assert.equal(nextRoundNumber([]), 1);
});

test('one sequence for notes and contributions, deleted ones keep their number', () => {
  assert.equal(nextSeq([{ seq: 3 }, { seq: 7, deleted: 'x' }], [{ seq: 5 }]), 8);
  assert.equal(nextSeq([], []), 1);
});

test('round summary: stations in first-contribution order, notes by contribution then recorded order', () => {
  const participants = [{ id: 'A', call: 'OE0QXA' }, { id: 'B', call: 'OE0QXB' }, { id: 'C', call: 'OE0QXC' }, { id: 'D', call: 'OE0QXD' }];
  const contributions = [
    { id: 'cB1', participantId: 'B', roundId: 'r', seq: 1 },
    { id: 'cA1', participantId: 'A', roundId: 'r', seq: 4 },
    { id: 'cB2', participantId: 'B', roundId: 'r', seq: 6 }, // B again (repeated contribution)
    { id: 'cD', participantId: 'D', roundId: 'r', seq: 20 }, // D spoke, no note
  ];
  const notes = [
    { id: 'n1', participantId: 'C', roundId: 'r', seq: 2, text: 'C, no contribution recorded' },
    { id: 'n2', participantId: 'B', roundId: 'r', seq: 7, contributionId: 'cB2', text: 'B second turn' },
    { id: 'n3', participantId: 'B', roundId: 'r', seq: 3, contributionId: 'cB1', text: 'B first turn' },
    { id: 'n4', participantId: 'A', roundId: 'r', seq: 5, contributionId: 'cA1', text: 'A' },
    { id: 'n5', participantId: 'A', roundId: 'other', seq: 8, text: 'other round' },
    { id: 'n6', participantId: 'B', roundId: 'r', seq: 9, text: 'B deleted', deleted: 'x' },
  ];
  const s = roundSummary({ notes, contributions, participants, roundId: 'r' });
  assert.deepEqual(s.map(g => g.participant.id), ['B', 'C', 'A'], 'B once, D (no notes) left out');
  assert.deepEqual(s[0].notes.map(n => n.id), ['n3', 'n2']);
  assert.deepEqual(roundSummary({ notes, contributions, participants, roundId: 'empty' }), []);
});

test('My Turn queue: open responses of any round and points, in manual order; tasks, unflagged and deleted sources out', () => {
  const notes = [{ id: 'n1', roundId: 'r1' }, { id: 'n2', roundId: 'r4' }, { id: 'n3', roundId: 'r4', deleted: 'x' }, { id: 'n4', roundId: 'r2' }];
  const items = [
    { id: 'a', kind: 'response', noteId: 'n1', state: 'open', active: true, order: 2 },
    { id: 'b', kind: 'point', state: 'open', active: true, order: 1 },
    { id: 'c', kind: 'task', noteId: 'n2', state: 'open', active: true, order: 0 },
    { id: 'd', kind: 'response', noteId: 'n2', state: 'open', active: false, order: 3 },
    { id: 'e', kind: 'response', noteId: 'n3', state: 'open', active: true, order: 4 },
    { id: 'f', kind: 'response', noteId: 'n4', state: 'done', doneTurnId: 'T', active: true, order: 5 },
    { id: 'g', kind: 'response', noteId: 'n4', state: 'done', doneTurnId: 'old', active: true, order: 6 },
  ];
  assert.deepEqual(queueItems(items, notes, 'T').map(i => i.id), ['b', 'a', 'f'], 'done in this turn stays visible');
  assert.deepEqual(queueItems(items, notes, null).map(i => i.id), ['b', 'a']);
  const counts = roundCounts(notes, items);
  assert.deepEqual(counts.get('r1'), { notes: 1, open: 1 });
  assert.deepEqual(counts.get('r4'), { notes: 1, open: 0 });
  assert.equal(openTurn([{ id: 'x', started: '1', ended: '2' }, { id: 'y', started: '3', ended: null }]).id, 'y');
  assert.equal(openTurn([{ id: 'x', started: '1', ended: '2' }]), null);
  assert.equal(responseOf(items, 'n2').id, 'd');
  assert.equal(responseOf(items, 'n2', 'task').id, 'c');
});

import { speakingState, speakingOrder, ncsFirst, netStyle } from '../tools/netlog/js/model.js';

test('speaking order: star without the NCS, circle with it first; paused and checked-out ones skipped', () => {
  const ps = [
    { id: 'n', call: 'OE0QXN', status: 'active', rosterOrder: 3 },
    { id: 'a', call: 'OE0QXA', status: 'active', rosterOrder: 1 },
    { id: 'b', call: 'OE0QXB', status: 'paused', rosterOrder: 2 },
    { id: 'c', call: 'OE0QXC', status: 'active', rosterOrder: 4, plannedOrder: null },
  ];
  const star = { ncsId: 'n', style: 'star', currentRoundId: 'r' };
  const circle = { ...star, style: 'circle' };
  assert.equal(netStyle({}), 'star');
  assert.deepEqual(speakingOrder(ps, star).map(p => p.id), ['a', 'b', 'c']);
  assert.deepEqual(speakingOrder(ps, circle).map(p => p.id), ['n', 'a', 'b', 'c']);
  assert.deepEqual(ncsFirst(ps, 'c').map(p => p.id), ['c', 'n', 'a', 'b']);
  let st = speakingState({ session: star, participants: ps, contributions: [] });
  assert.equal(st.next.id, 'a');
  assert.equal(st.onAir.id, 'n', 'the NCS opens the round');
  st = speakingState({ session: star, participants: ps, contributions: [{ id: 'x', participantId: 'a', roundId: 'r', seq: 1 }] });
  assert.equal(st.onAir.id, 'a');
  assert.equal(st.next.id, 'n', 'back to the NCS');
  assert.equal(st.then.id, 'c', 'b is paused');
  st = speakingState({ session: star, participants: ps, contributions: [{ id: 'x', participantId: 'a', roundId: 'r', seq: 1 }, { id: 'y', participantId: 'c', roundId: 'r', seq: 2 }, { id: 'z', participantId: 'n', roundId: 'r', seq: 3 }] });
  assert.equal(st.complete, true);
  assert.equal(st.next, null);
  // circle: the NCS takes part, the order goes on after the last speaker
  st = speakingState({ session: circle, participants: ps, contributions: [{ id: 'x', participantId: 'a', roundId: 'r', seq: 1 }] });
  assert.equal(st.next.id, 'c');
  st = speakingState({ session: circle, participants: ps, contributions: [{ id: 'x', participantId: 'c', roundId: 'r', seq: 1 }] });
  assert.equal(st.next.id, 'n', 'wraps around to the first');
  // other rounds do not count
  st = speakingState({ session: star, participants: ps, contributions: [{ id: 'x', participantId: 'a', roundId: 'old', seq: 1 }] });
  assert.equal(st.next.id, 'a');
});

test('star net: after each station the turn goes back to the NCS; complete when the NCS has it again', () => {
  const ps = [
    { id: 'n', call: 'OE0QXN', status: 'active', rosterOrder: 1 },
    { id: 'a', call: 'OE0QXA', status: 'active', rosterOrder: 2 },
    { id: 'b', call: 'OE0QXB', status: 'active', rosterOrder: 3 },
  ];
  const s = { ncsId: 'n', style: 'star', currentRoundId: 'r' };
  const turns = [];
  const step = () => speakingState({ session: s, participants: ps, contributions: turns });
  const say = id => turns.push({ id: `c${turns.length}`, participantId: id, roundId: 'r', seq: turns.length + 1 });
  let st = step();
  assert.equal(st.next.id, 'a');
  say('a');
  st = step();
  assert.equal(st.next.id, 'n');
  assert.equal(st.then.id, 'b');
  say('n');
  assert.equal(step().next.id, 'b');
  say('b');
  st = step();
  assert.equal(st.next.id, 'n');
  assert.equal(st.then, null);
  assert.equal(st.complete, false, 'not before the NCS has the turn again');
  say('n');
  st = step();
  assert.equal(st.complete, true);
  assert.equal(st.next, null);
});
