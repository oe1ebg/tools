// The texts of the series statistics view (#83): durations, estimated / left-out / unknown
// marks, the leaderboard, matrix and session rows. Synthetic callsigns only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useLang } from '../tools/netlog/js/i18n.js';
import { seriesStatistics } from '../tools/netlog/js/stats.js';
import { callBase } from '../tools/netlog/js/model.js';
import { smDuration, smQty, smShare, smSummary, smLeaderboard, smMatrix, smSessions, smRotation } from '../tools/netlog/js/statsmodel.js';

useLang('en');
const T = (d, hm, quality = 'exact') => ({ iso: `${d}T${hm}:00.000Z`, quality });
const NONE = { iso: null, quality: 'unknown' };

function net(sid, date, number, { start = '18:00', end = '19:00', startQ = 'exact', late = false, ncs = null } = {}, stations = []) {
  const session = { id: sid, seriesId: 'ser', number, name: '', date, created: `${date}T00:00:00.000Z`, start: late ? NONE : T(date, start, startQ), end: late ? NONE : T(date, end), ncsId: ncs, deleted: null };
  const data = { session, participants: [], rounds: [{ id: `${sid}r1`, eventId: sid, number: 1, order: 1, topic: '', start: late ? NONE : T(date, start), deleted: null }], contributions: [], notes: [], events: [] };
  stations.forEach(([call, from, to], i) => {
    const id = `${sid}p${i}`;
    data.participants.push({ id, eventId: sid, call, base: callBase(call), name: '', profileId: null, status: 'active', rosterOrder: i + 1, created: `${date}T00:00:0${i}.000Z`, presence: [{ from: T(date, from), to: to ? T(date, to) : null }], deleted: null });
    data.events.push({ id: `${id}e`, eventId: sid, type: 'presence', kind: 'checkin', participantId: id, time: T(date, from), deleted: null });
  });
  return data;
}

test('smDuration: hh:mm, hours unbounded, minutes floored, no value is a dash', () => {
  assert.equal(smDuration(0), '00:00');
  assert.equal(smDuration(59999), '00:00');
  assert.equal(smDuration(60000), '00:01');
  assert.equal(smDuration(3600000 + 29 * 60000), '01:29');
  assert.equal(smDuration(100 * 3600000), '100:00');
  assert.equal(smDuration(null), '–');
  assert.equal(smDuration(-1), '–');
});

test('smQty: exact plain, estimated with ≈, left-out with ≥ and a count, unknown a dash', () => {
  assert.deepEqual(smQty({ ms: 5400000, quality: 'exact', leftOut: 0 }), { text: '01:30', note: '', level: 'exact' });
  assert.deepEqual(smQty({ ms: 5400000, quality: 'estimated', leftOut: 0 }), { text: '≈ 01:30', note: '', level: 'estimated' });
  assert.deepEqual(smQty({ ms: 5400000, quality: 'estimated', leftOut: 2 }), { text: '≥ 01:30', note: '(+2 without time)', level: 'estimated' });
  assert.deepEqual(smQty({ ms: null, quality: 'unknown', leftOut: 0 }), { text: '–', note: '', level: 'unknown' });
  assert.deepEqual(smQty({ ms: null, quality: 'unknown', leftOut: 1 }), { text: '–', note: '(+1 without time)', level: 'unknown' });
  useLang('de');
  assert.equal(smQty({ ms: 60000, quality: 'estimated', leftOut: 3 }).note, '(+3 ohne Zeit)');
  useLang('en');
});

test('smShare: attended of the series, a rounded percentage, an empty series is 0 %', () => {
  assert.equal(smShare(3, 4), '3/4 (75 %)');
  assert.equal(smShare(1, 3), '1/3 (33 %)');
  assert.equal(smShare(0, 0), '0/0 (0 %)');
});

const list = () => [
  net('a', '2026-10-01', 1, {}, [['OE0TEST', '18:00', '19:00'], ['DL0XYZ', '18:10', '18:40']]),
  net('b', '2026-10-08', 2, { late: true }, [['OE0TEST', '18:05', null]]),
  net('c', '2026-10-15', 3, {}, [['OE0TEST', '18:00', '18:30']]),
];

test('summary, leaderboard, matrix and session rows of a series with an unknown-time session', () => {
  const stats = seriesStatistics(list());
  assert.deepEqual(smSummary(stats), { sessions: 3, unknownTimes: 1, stations: 2, excluded: 0, excludedSessions: 0, withoutStart: 1, withoutEnd: 1 });
  const lb = smLeaderboard(stats);
  assert.deepEqual(lb.map(r => [r.rank, r.call, r.attendedText, r.lastSeen]), [[1, 'OE0TEST', '3/3 (100 %)', '2026-10-15'], [2, 'DL0XYZ', '1/3 (33 %)', '2026-10-01']]);
  assert.equal(lb[0].timePresent.text.startsWith('≥ 01:30'), true, 'the session without times is left out and counted');
  assert.equal(lb[0].timePresent.note, '(+1 without time)');
  assert.match(lb[0].speaking.text, /^(≈ 00:00|≥ 00:00|–)/);
  const m = smMatrix(stats);
  assert.deepEqual(m.sessions.map(s => [s.date, s.number]), [['2026-10-01', '#1'], ['2026-10-08', '#2'], ['2026-10-15', '#3']]);
  assert.deepEqual(m.rows[1].cells.map(c => c.text), ['✓ 00:30', '–', '–']);
  assert.equal(m.rows[0].cells[1].text, '✓', 'attended without a known time: a check mark alone');
  const sessions = smSessions(stats);
  assert.equal(sessions[1].span, '');
  assert.equal(sessions[1].length.text, '–');
  assert.equal(sessions[0].span, '18:00–19:00 UTC');
  assert.deepEqual(sessions[0].rounds.map(r => [r.number, r.duration.text]), [[1, '01:00']]);
  assert.equal(sessions[0].present, 2);
});

test('empty series: nothing counted, no rows', () => {
  const stats = seriesStatistics([]);
  assert.equal(smSummary(stats).sessions, 0);
  assert.deepEqual(smLeaderboard(stats), []);
  assert.deepEqual(smMatrix(stats).rows, []);
  assert.deepEqual(smSessions(stats), []);
  assert.deepEqual(smRotation(stats), []);
});
