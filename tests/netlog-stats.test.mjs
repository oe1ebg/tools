// Netlog statistics (#83): per session and per series. Synthetic callsigns only; records shaped
// like the real stores (tools/netlog/js/db.js, README "Data model").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionStatistics, seriesStatistics } from '../tools/netlog/js/stats.js';
import { callBase } from '../tools/netlog/js/model.js';

const iso = (d, hm) => `${d}T${hm}:00.000Z`;
const T = (d, hm, quality = 'exact') => ({ iso: iso(d, hm), quality });
const NONE = { iso: null, quality: 'unknown' };
const MIN = 60000;

let n = 0;
const id = p => `${p}${++n}`;

// a session with its records; build via helper `net()`
function net({ sid = id('s'), date = '2026-10-01', number = null, start = '18:00', end = '19:00', startQ = 'exact', ncs = null, late = false } = {}) {
  const session = {
    id: sid, seriesId: 'ser', number, name: '', date, created: `${date}T00:00:00.000Z`,
    start: late ? NONE : T(date, start, startQ), end: NONE, joinedLate: late, ncsId: ncs, deleted: null,
  };
  const data = { session, participants: [], rounds: [], contributions: [], notes: [], events: [] };
  let order = 0, seq = 0;
  const api = {
    data, date,
    round(no, hm, extra = {}) {
      const r = { id: `${sid}-r${no}`, eventId: sid, number: no, order: no, topic: '', start: hm ? T(date, hm) : NONE, deleted: null, ...extra };
      data.rounds.push(r);
      return r;
    },
    // a station checking in at hm (a check-in event and an open presence interval)
    join(pid, call, hm, extra = {}) {
      const p = { id: pid, eventId: sid, call, base: callBase(call), name: '', profileId: null, status: 'active', rosterOrder: ++order, created: `${date}T00:00:0${order}.000Z`, presence: [{ from: T(date, hm), to: null }], deleted: null, ...extra };
      data.participants.push(p);
      data.events.push({ id: id('e'), eventId: sid, type: 'presence', kind: 'checkin', participantId: pid, time: T(date, hm), deleted: null });
      return p;
    },
    leave(pid, hm) {
      const p = data.participants.find(x => x.id === pid);
      p.presence[p.presence.length - 1].to = T(date, hm);
      p.status = 'out';
    },
    turn(pid, roundId, hm, q = 'exact') {
      const c = { id: id('c'), eventId: sid, participantId: pid, roundId, seq: ++seq, time: hm ? T(date, hm, q) : NONE, deleted: null };
      data.contributions.push(c);
      return c;
    },
    note(pid, roundId) {
      data.notes.push({ id: id('n'), eventId: sid, participantId: pid, roundId, seq: ++seq, text: 'x', time: NONE, deleted: null });
    },
    close(hm) { data.events.push({ id: id('e'), eventId: sid, type: 'round', kind: 'closed', time: T(date, hm), deleted: null }); },
    handover(from, to, hm) { data.events.push({ id: id('e'), eventId: sid, type: 'ncs', from, to, time: T(date, hm), deleted: null }); },
  };
  return api;
}
const row = (stats, pid) => stats.stations.find(r => r.participantId === pid);

// ---------- one session ----------

test('session: length, rounds with durations, stations present, time present per station', () => {
  const s = net({ ncs: 'a' });
  const r1 = s.round(1, '18:00'), r2 = s.round(2, '18:30');
  s.join('a', 'OE0QXA', '18:00'); s.join('b', 'OE0QXB', '18:10'); s.join('c', 'OE0QXC', '18:20');
  s.leave('b', '18:40');
  s.close('19:00');
  const st = sessionStatistics(s.data);
  assert.deepEqual([st.start.iso, st.end.iso, st.length], [iso('2026-10-01', '18:00'), iso('2026-10-01', '19:00'), { ms: 60 * MIN, quality: 'exact', leftOut: 0 }]);
  assert.deepEqual(st.rounds.map(r => [r.id, r.duration.ms]), [[r1.id, 30 * MIN], [r2.id, 30 * MIN]]);
  assert.equal(st.present, 3);
  assert.equal(row(st, 'a').timePresent.ms, 60 * MIN); // open: closed at the session end
  assert.equal(row(st, 'b').timePresent.ms, 30 * MIN);
  assert.equal(row(st, 'c').timePresent.ms, 40 * MIN);
  assert.equal(st.totals.timePresent.ms, 130 * MIN);
  assert.equal(st.totals.timePresent.quality, 'exact');
  assert.deepEqual([row(st, 'b').checkinOffset.ms, row(st, 'a').checkinOffset.ms], [10 * MIN, 0]);
});

test('session: an open interval without a known end is unknown, attendance still counts', () => {
  const s = net();
  s.round(1, '18:00');
  s.join('a', 'OE0QXA', '18:00'); s.join('b', 'OE0QXB', '18:05');
  s.leave('b', '18:35');
  const st = sessionStatistics(s.data); // net not closed: end unknown
  assert.equal(st.end.quality, 'unknown');
  assert.equal(st.length.quality, 'unknown');
  assert.deepEqual([st.present, row(st, 'a').attended], [2, true]);
  assert.deepEqual(row(st, 'a').timePresent, { ms: null, quality: 'unknown', leftOut: 1 });
  assert.equal(row(st, 'b').timePresent.ms, 30 * MIN);
  // the unknown one is left out of the sum and counted
  assert.deepEqual(st.totals.timePresent, { ms: 30 * MIN, quality: 'estimated', leftOut: 1 });
  assert.equal(st.rounds[0].duration.quality, 'unknown');
});

test('session: session.end wins over the closed event; estimated times stay estimated', () => {
  const s = net({ startQ: 'estimated' });
  s.join('a', 'OE0QXA', '18:00');
  s.close('19:30');
  s.data.session.end = T('2026-10-01', '19:00');
  const st = sessionStatistics(s.data);
  assert.equal(st.end.iso, iso('2026-10-01', '19:00'));
  assert.deepEqual(st.length, { ms: 60 * MIN, quality: 'estimated', leftOut: 0 });
  assert.equal(row(st, 'a').checkinOffset.quality, 'estimated');
  assert.equal(row(st, 'a').timePresent.quality, 'exact'); // interval and end are exact
});

test('session: joined late has no start: no check-in offset, durations to the end still known', () => {
  const s = net({ late: true });
  s.round(1, null);
  s.join('a', 'OE0QXA', '18:20');
  s.close('19:00');
  const st = sessionStatistics(s.data);
  assert.equal(st.start.quality, 'unknown');
  assert.deepEqual(row(st, 'a').checkinOffset, { ms: null, quality: 'unknown', leftOut: 0 });
  assert.equal(st.length.ms, null);
  assert.equal(row(st, 'a').timePresent.ms, 40 * MIN);
  assert.equal(st.rounds[0].start.iso, null);
  assert.equal(st.rounds[0].duration.ms, null);
  assert.equal(st.gaps, undefined); // series-level only
});

test('session: a negative check-in offset is unknown, never invented', () => {
  const s = net({ start: '18:30' });
  s.join('a', 'OE0QXA', '18:00');
  assert.equal(row(sessionStatistics(s.data), 'a').checkinOffset.quality, 'unknown');
});

test('session: presence intervals with unknown or reversed times are left out and counted', () => {
  const s = net();
  const p = s.join('a', 'OE0QXA', '18:00');
  p.presence = [{ from: T('2026-10-01', '18:00'), to: T('2026-10-01', '18:10') }, { from: NONE, to: T('2026-10-01', '18:30') }, { from: T('2026-10-01', '18:50'), to: T('2026-10-01', '18:40') }];
  s.close('19:00');
  assert.deepEqual(row(sessionStatistics(s.data), 'a').timePresent, { ms: 10 * MIN, quality: 'estimated', leftOut: 2 });
});

test('session: deleted records are ignored (participants, turns, notes, rounds, events)', () => {
  const s = net({ ncs: 'a' });
  const r1 = s.round(1, '18:00');
  s.round(2, '18:20', { deleted: '2026-10-01T18:21:00.000Z' });
  s.join('a', 'OE0QXA', '18:00'); s.join('b', 'OE0QXB', '18:05', { deleted: '2026-10-01T18:06:00.000Z' });
  s.turn('a', r1.id, '18:01'); s.turn('a', r1.id, '18:02').deleted = '2026-10-01T18:03:00.000Z';
  s.note('a', r1.id); s.data.notes[0].deleted = '2026-10-01T18:03:00.000Z'; s.note('a', r1.id);
  s.close('19:00');
  const st = sessionStatistics(s.data);
  assert.deepEqual([st.present, st.rounds.length, row(st, 'a').turns, row(st, 'a').notes, st.totals.turns, st.totals.notes], [1, 1, 1, 1, 1, 1]);
  assert.equal(row(st, 'b'), undefined);
  assert.equal(st.rounds[0].duration.ms, 60 * MIN); // the deleted round does not end round 1
});

test('session: unresolved callsigns are excluded and counted, not rows', () => {
  const s = net();
  s.join('a', 'OE0QXA', '18:00'); s.join('b', 'OE0QX?', '18:05'); s.join('c', '?', '18:06'); s.join('d', '', '18:07');
  const st = sessionStatistics(s.data);
  assert.deepEqual([st.stations.map(r => r.participantId), st.excluded, st.present], [['a'], 3, 1]);
});

test('session: zero turns, zero rounds, empty session', () => {
  const st = sessionStatistics(net().data);
  assert.deepEqual([st.stations, st.rounds, st.present, st.excluded, st.ncs], [[], [], 0, 0, []]);
  assert.deepEqual(st.totals.timePresent, { ms: 0, quality: 'exact', leftOut: 0 });
  assert.deepEqual(st.totals.speaking, { ms: 0, quality: 'estimated', leftOut: 0 });
  const s = net();
  s.join('a', 'OE0QXA', '18:00');
  assert.deepEqual(row(sessionStatistics(s.data), 'a').speaking, { ms: 0, quality: 'estimated', leftOut: 0 });
});

test('session: a station without any presence record did not attend', () => {
  const s = net();
  s.join('a', 'OE0QXA', '18:00', { presence: [] });
  s.data.events.length = 0;
  const r = row(sessionStatistics(s.data), 'a');
  assert.deepEqual([r.attended, r.timePresent.ms, r.firstCheckin.quality], [false, 0, 'unknown']);
});

// ---------- speaking time (estimate) ----------

test('speaking: a turn lasts to the next turn of the round, the last to the next round start', () => {
  const s = net();
  const r1 = s.round(1, '18:00'), r2 = s.round(2, '18:20');
  s.join('a', 'OE0QXA', '18:00'); s.join('b', 'OE0QXB', '18:00');
  s.turn('a', r1.id, '18:01'); s.turn('b', r1.id, '18:04'); s.turn('a', r1.id, '18:06'); // a: 3 + (to 18:20) 14, b: 2
  s.turn('b', r2.id, '18:21'); // last turn of the last round: no end known
  s.close('19:00');
  const st = sessionStatistics(s.data);
  assert.deepEqual(row(st, 'a').speaking, { ms: 17 * MIN, quality: 'estimated', leftOut: 0 });
  assert.deepEqual(row(st, 'b').speaking, { ms: 2 * MIN, quality: 'estimated', leftOut: 1 }); // 2 min measured, the turn in round 2 not
  assert.deepEqual(row(st, 'b').turns, 2);
  assert.deepEqual(st.totals.speaking, { ms: 19 * MIN, quality: 'estimated', leftOut: 1 });
});

test('speaking: only turns of exact times count; unknown or estimated starts are left out and counted', () => {
  const s = net();
  const r1 = s.round(1, '18:00'), r2 = s.round(2, '18:30');
  s.join('a', 'OE0QXA', '18:00');
  s.turn('a', r1.id, '18:01'); s.turn('a', r1.id, '18:05', 'estimated'); s.turn('a', r1.id, null); s.turn('a', r1.id, '18:10');
  // turns: 18:01->18:05(est) left out, 18:05(est)->unknown left out, unknown->18:10 left out, 18:10->18:30 counted
  const st = sessionStatistics(s.data);
  assert.deepEqual(row(st, 'a').speaking, { ms: 20 * MIN, quality: 'estimated', leftOut: 3 });
  assert.equal(r2.number, 2);
});

test('speaking: nothing measurable is unknown, never zero', () => {
  const s = net();
  const r1 = s.round(1, '18:00');
  s.join('a', 'OE0QXA', '18:00');
  s.turn('a', r1.id, '18:01'); // one turn, no next round
  assert.deepEqual(row(sessionStatistics(s.data), 'a').speaking, { ms: null, quality: 'unknown', leftOut: 1 });
});

test('speaking: a turn out of time order (clock edited) is left out', () => {
  const s = net();
  const r1 = s.round(1, '18:00'); s.round(2, '18:30');
  s.join('a', 'OE0QXA', '18:00');
  s.turn('a', r1.id, '18:10'); s.turn('a', r1.id, '18:05'); // second is recorded later but timed earlier
  const r = row(sessionStatistics(s.data), 'a');
  assert.deepEqual(r.speaking, { ms: 25 * MIN, quality: 'estimated', leftOut: 1 }); // 18:05->18:30 counted, 18:10->18:05 not
});

// ---------- NCS ----------

test('ncs: rotation in time order and time held; before the first handover the station it was taken from', () => {
  const s = net({ ncs: 'b' });
  s.join('a', 'OE0QXA', '18:00'); s.join('b', 'OE0QXB', '18:00'); s.join('c', 'OE0QXC', '18:00');
  s.handover('a', 'b', '18:20'); s.handover('b', 'c', '18:40');
  s.data.session.ncsId = 'c';
  s.close('19:00');
  const st = sessionStatistics(s.data);
  assert.deepEqual(st.ncs.map(r => [r.participantId, r.ms.ms]), [['a', 20 * MIN], ['b', 20 * MIN], ['c', 20 * MIN]]);
  assert.deepEqual([row(st, 'a').ncs, row(st, 'b').ncsTime.ms], [true, 20 * MIN]);
  assert.deepEqual(st.ncs[0].call, 'OE0QXA');
});

test('ncs: a join-late session has no start: the run bounded by it is left out', () => {
  const s = net({ late: true, ncs: 'b' });
  s.join('a', 'OE0QXA', '18:20'); s.join('b', 'OE0QXB', '18:20');
  s.handover('a', 'b', '18:30');
  s.close('19:00');
  const st = sessionStatistics(s.data);
  assert.deepEqual(st.ncs.map(r => [r.participantId, r.ms.ms]), [['a', null], ['b', 30 * MIN]]);
  assert.deepEqual(row(st, 'a').ncsTime, { ms: null, quality: 'unknown', leftOut: 1 });
});

test('ncs: a handover time estimated makes the held time estimated', () => {
  const s = net({ ncs: 'b' });
  s.join('a', 'OE0QXA', '18:00'); s.join('b', 'OE0QXB', '18:00');
  s.handover('a', 'b', '18:30'); s.data.events.at(-1).time.quality = 'estimated';
  s.close('19:00');
  assert.equal(row(sessionStatistics(s.data), 'b').ncsTime.quality, 'estimated');
});

test('ncs: no NCS at all gives no rotation', () => {
  const s = net(); s.join('a', 'OE0QXA', '18:00');
  const st = sessionStatistics(s.data);
  assert.deepEqual([st.ncs, row(st, 'a').ncs, row(st, 'a').ncsTime.ms], [[], false, 0]);
});

// ---------- series ----------

function series() {
  // 3 sessions: a attends all (NCS in 1 and 2), b two (1, 3), c one (3, a profile), d/e ties
  const s1 = net({ date: '2026-10-01', number: 1, ncs: 'a1' });
  s1.round(1, '18:00'); s1.join('a1', 'OE0QXA', '18:00', { name: 'Alex' }); s1.join('b1', 'OE0QXB', '18:10'); s1.close('19:00');
  const s2 = net({ date: '2026-10-08', number: 2, ncs: 'a2' });
  s2.round(1, '18:00'); s2.join('a2', 'OE0QXA/P', '18:00'); s2.close('18:30');
  const s3 = net({ date: '2026-10-15', number: 3, ncs: 'b3' });
  s3.round(1, '18:00'); s3.join('a3', 'OE0QXA', '18:00', { name: 'Alexandra' }); s3.join('b3', 'OE0QXB', '18:00'); s3.join('c3', 'OE0QXC', '18:30', { profileId: 'p-c' });
  s3.join('u3', 'OE0QX?', '18:00'); s3.close('19:00');
  return [s3.data, s1.data, s2.data]; // not in order
}

test('series: leaderboard sorted by sessions attended, then time present, then call', () => {
  const st = seriesStatistics(series());
  assert.equal(st.sessionCount, 3);
  assert.deepEqual(st.sessions.map(s => s.number), [1, 2, 3]); // chronological
  assert.deepEqual(st.leaderboard.map(r => [r.rank, r.call, r.sessionsAttended]), [[1, 'OE0QXA', 3], [2, 'OE0QXB', 2], [3, 'OE0QXC', 1]]);
  const a = st.leaderboard[0];
  assert.equal(a.share, 1);
  assert.equal(a.timePresent.ms, (60 + 30 + 60) * MIN);
  assert.deepEqual([a.ncsSessions, a.lastSeen, a.name, a.key], [2, '2026-10-15', 'Alexandra', 'call:OE0QXA']); // /P is the same station (base); latest name
  assert.equal(st.leaderboard[1].share, 2 / 3);
  assert.deepEqual(st.excluded, { participants: 1, sessions: 1 });
  assert.equal(st.leaderboard[2].key, 'profile:p-c');
});

test('series: attendance matrix aligned with the sessions, null where absent', () => {
  const st = seriesStatistics(series());
  assert.deepEqual(st.matrix.sessions.map(s => s.number), [1, 2, 3]);
  const cells = key => st.matrix.rows.find(r => r.key === key).cells.map(c => c && c.participantId);
  assert.deepEqual(cells('call:OE0QXA'), ['a1', 'a2', 'a3']);
  assert.deepEqual(cells('call:OE0QXB'), ['b1', null, 'b3']);
  assert.deepEqual(cells('profile:p-c'), [null, null, 'c3']);
  assert.deepEqual(st.matrix.rows.map(r => r.key), st.leaderboard.map(r => r.key));
  assert.equal(st.matrix.rows[1].cells[0].checkinOffset.ms, 10 * MIN);
});

test('series: NCS rotation per session, holders keyed to stations', () => {
  const st = seriesStatistics(series());
  assert.deepEqual(st.rotation.map(r => [r.number, r.holders.map(h => h.key)]), [[1, ['call:OE0QXA']], [2, ['call:OE0QXA']], [3, ['call:OE0QXB']]]);
});

test('series: ties on sessions and time are ordered by call, deterministically', () => {
  const mk = order => {
    const s1 = net({ date: '2026-10-01' }), s2 = net({ date: '2026-10-08' });
    for (const [pid, call] of order) { s1.join(`${pid}1`, call, '18:00'); s2.join(`${pid}2`, call, '18:00'); }
    s1.close('19:00'); s2.close('19:00');
    return [s1.data, s2.data];
  };
  const calls = [['z', 'OE0QXZ'], ['y', 'OE0QXB'], ['x', 'OE0QXM']];
  const a = seriesStatistics(mk(calls)).leaderboard.map(r => r.call);
  const b = seriesStatistics(mk([...calls].reverse())).leaderboard.map(r => r.call);
  assert.deepEqual(a, ['OE0QXB', 'OE0QXM', 'OE0QXZ']);
  assert.deepEqual(b, a);
});

test('series: unknown time present sorts after known at equal attendance, and is not counted as zero', () => {
  const s1 = net({ date: '2026-10-01' }), s2 = net({ date: '2026-10-08' });
  s1.join('a1', 'OE0QXA', '18:00'); s1.join('b1', 'OE0QXB', '18:00'); s1.leave('b1', '18:10'); // s1 not closed: a is unknown
  s2.join('a2', 'OE0QXA', '18:00'); s2.join('b2', 'OE0QXB', '18:00'); s2.leave('b2', '18:10'); s2.leave('a2', '18:05');
  const st = seriesStatistics([s1.data, s2.data]);
  assert.deepEqual(st.leaderboard.map(r => r.call), ['OE0QXB', 'OE0QXA']);
  assert.deepEqual(st.leaderboard[1].timePresent, { ms: 5 * MIN, quality: 'estimated', leftOut: 1 });
  assert.deepEqual(st.gaps, { withoutStart: 0, withoutEnd: 2 });
});

test('series: a station whose time is unknown in every session is unknown, not zero', () => {
  const s1 = net({ date: '2026-10-01' });
  s1.join('a1', 'OE0QXA', '18:00');
  const st = seriesStatistics([s1.data]);
  assert.deepEqual(st.leaderboard[0].timePresent, { ms: null, quality: 'unknown', leftOut: 1 });
});

test('series: profile identity joins different calls; base callsign joins without a profile', () => {
  const s1 = net({ date: '2026-10-01' }), s2 = net({ date: '2026-10-08' }), s3 = net({ date: '2026-10-15' });
  s1.join('a1', 'OE0QXA', '18:00', { profileId: 'p1' });
  s2.join('a2', 'OE0QXN', '18:00', { profileId: 'p1' }); // call changed, same profile
  s3.join('a3', 'OE0QXN/M', '18:00'); // no profile: joins on the base callsign
  for (const s of [s1, s2, s3]) s.close('19:00');
  const st = seriesStatistics([s1.data, s2.data, s3.data]);
  assert.equal(st.leaderboard.length, 1);
  assert.deepEqual([st.leaderboard[0].sessionsAttended, st.leaderboard[0].key, st.leaderboard[0].call], [3, 'profile:p1', 'OE0QXN/M']);
});

test('series: the same base callsign with different profiles stays two stations only when marked notSame', () => {
  const mk = notSame => {
    const s1 = net({ date: '2026-10-01' }), s2 = net({ date: '2026-10-08' });
    s1.join('a1', 'OE0QXA', '18:00'); s2.join('a2', 'OE0QXA', '18:00', { notSame }); // reused call, another person
    s1.close('19:00'); s2.close('19:00');
    return seriesStatistics([s1.data, s2.data]).leaderboard;
  };
  assert.equal(mk([]).length, 1);
  assert.equal(mk(['a1']).length, 2);
  // the mark counts from either side
  const s1 = net({ date: '2026-10-01' }), s2 = net({ date: '2026-10-08' });
  s1.join('a1', 'OE0QXA', '18:00', { notSame: ['a2'] }); s2.join('a2', 'OE0QXA', '18:00');
  assert.equal(seriesStatistics([s1.data, s2.data]).leaderboard.length, 2);
});

test('series: notSame holds against a chain (A~B, B~C, but A is not C)', () => {
  const s1 = net({ date: '2026-10-01' }), s2 = net({ date: '2026-10-08' }), s3 = net({ date: '2026-10-15' });
  s1.join('a1', 'OE0QXA', '18:00');
  s2.join('a2', 'OE0QXA', '18:00');
  s3.join('a3', 'OE0QXA', '18:00', { notSame: ['a1'] });
  const lb = seriesStatistics([s1.data, s2.data, s3.data]).leaderboard;
  assert.deepEqual(lb.map(r => r.sessionsAttended).sort(), [1, 2]);
});

test('series: two participants with one callsign in one session are never one station', () => {
  const s1 = net({ date: '2026-10-01' });
  s1.join('a1', 'OE0QXA', '18:00'); s1.join('a2', 'OE0QXA/P', '18:00');
  s1.close('19:00');
  const st = seriesStatistics([s1.data]);
  assert.deepEqual(st.leaderboard.map(r => r.sessionsAttended), [1, 1]);
});

test('series: deleted sessions and deleted participants are ignored', () => {
  const s1 = net({ date: '2026-10-01' }), s2 = net({ date: '2026-10-08' });
  s1.join('a1', 'OE0QXA', '18:00'); s2.join('a2', 'OE0QXA', '18:00');
  s2.data.session.deleted = '2026-10-09T00:00:00.000Z';
  const st = seriesStatistics([s1.data, s2.data]);
  assert.deepEqual([st.sessionCount, st.leaderboard[0].sessionsAttended, st.leaderboard[0].share], [1, 1, 1]);
});

test('series: empty series and a series of one session', () => {
  const e = seriesStatistics([]);
  assert.deepEqual([e.sessionCount, e.leaderboard, e.matrix, e.rotation, e.excluded, e.gaps], [0, [], { sessions: [], rows: [] }, [], { participants: 0, sessions: 0 }, { withoutStart: 0, withoutEnd: 0 }]);
  const s = net({ date: '2026-10-01', ncs: 'a' });
  s.join('a', 'OE0QXA', '18:00'); s.close('18:30');
  const one = seriesStatistics([s.data]);
  assert.deepEqual([one.sessionCount, one.leaderboard.length, one.leaderboard[0].share, one.leaderboard[0].timePresent.ms], [1, 1, 1, 30 * MIN]);
  // sessions without any attendance: share is 0 of N, no rows
  const none = seriesStatistics([net().data, net().data]);
  assert.deepEqual([none.sessionCount, none.leaderboard], [2, []]);
});

test('series: speaking and presence sums keep their quality; nothing is filled in', () => {
  const s1 = net({ date: '2026-10-01' }), s2 = net({ date: '2026-10-08' });
  const r1 = s1.round(1, '18:00'), r2 = s2.round(1, '18:00');
  s1.join('a1', 'OE0QXA', '18:00'); s2.join('a2', 'OE0QXA', '18:00');
  s1.turn('a1', r1.id, '18:01'); s1.turn('a1', r1.id, '18:04'); // 3 min then the last turn: unknown
  s2.turn('a2', r2.id, '18:02'); // unknown
  s1.close('19:00'); s2.close('19:00');
  const a = seriesStatistics([s1.data, s2.data]).leaderboard[0];
  assert.deepEqual(a.speaking, { ms: 3 * MIN, quality: 'estimated', leftOut: 2 });
  assert.equal(a.turns, 3);
  assert.equal(a.timePresent.quality, 'exact');
});
