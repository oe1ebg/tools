// A station's history across sessions (tools/netlog/js/history.js) and
// the explicit identity decisions (ops.js linkSameStation / markNotSame).
// Synthetic callsigns: recurring OE0QXA in two sessions of one series, an
// ad-hoc net and another series; an ambiguous OE0QX?; a corrected identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../tools/netlog/js/memstore.js';
import { NETLOG_STORES } from '../tools/netlog/js/db.js';
import {
  createSeries, createSession, addParticipant, updateParticipant, createNote, toggleResponse, toggleTask, setItemDone,
  deleteNote, deleteSession, linkSameStation, markNotSame, saveProfile, undo,
} from '../tools/netlog/js/ops.js';
import { sameStation, stationHistory, openFollowUps, possibleMatches, historySummary, HISTORY_STORES } from '../tools/netlog/js/history.js';

const TAB = 'tab-h';
const all = async store => Object.fromEntries(await Promise.all(HISTORY_STORES.map(async s => [s, await store.getAll(s)])));

async function fixture() {
  const store = memoryStore(NETLOG_STORES);
  const series = await createSeries(store, { tab: TAB }, { name: 'Wiener Runde' });
  const other = await createSeries(store, { tab: TAB }, { name: 'Bergrunde' });
  const mk = async (fields) => {
    const s = await createSession(store, { tab: TAB }, { own: 'OE0QXZ', round: 1, ...fields });
    return { s, ctx: { sessionId: s.id, tab: TAB } };
  };
  const s1 = await mk({ seriesId: series.id, date: '2026-10-02' });
  const s2 = await mk({ seriesId: series.id, date: '2026-10-09' });
  const s3 = await mk({ date: '2026-10-05' }); // ad hoc
  const s4 = await mk({ seriesId: other.id, date: '2026-10-07' });
  const now = await mk({ seriesId: series.id, date: '2026-10-16' });
  // OE0QXA: s1 (as OE0QXA/P, name Anna), s2, s4; partial OE0QX? in s3
  const a1 = await addParticipant(store, s1.ctx, { call: 'OE0QXA/P', name: 'Anna' });
  const n1 = await createNote(store, s1.ctx, { participantId: a1.id, text: 'new antenna, 7 el yagi' });
  await toggleTask(store, s1.ctx, n1.id, true); // after-net task, open
  const a2 = await addParticipant(store, s2.ctx, { call: 'OE0QXA', name: 'Anna' });
  const n2 = await createNote(store, s2.ctx, { participantId: a2.id, text: 'asks about the QSL' });
  await toggleResponse(store, s2.ctx, n2.id, true); // reply, open
  const n2b = await createNote(store, s2.ctx, { participantId: a2.id, text: 'already answered' });
  await toggleResponse(store, s2.ctx, n2b.id, true);
  const done = (await store.getAll('items')).find(i => i.noteId === n2b.id);
  await setItemDone(store, s2.ctx, done.id, true);
  const gone = await createNote(store, s2.ctx, { participantId: a2.id, text: 'deleted note' });
  await deleteNote(store, s2.ctx, gone.id);
  const q3 = await addParticipant(store, s3.ctx, { call: 'OE0QX?', name: '' });
  await createNote(store, s3.ctx, { participantId: q3.id, text: 'weak, maybe OE0QXA' });
  const a4 = await addParticipant(store, s4.ctx, { call: 'OE0QXA', name: 'Anna' });
  const b4 = await addParticipant(store, s4.ctx, { call: 'OE0QXB', name: 'Anna' }); // same name, other call
  const cur = await addParticipant(store, now.ctx, { call: 'OE0QXA', name: 'Anna' });
  return { store, series, s1, s2, s3, s4, now, a1, a2, q3, a4, b4, cur, n1, n2 };
}

test('the same station: profile or the same complete base call; never partial ones', () => {
  const p = (id, call, extra = {}) => ({ id, call, base: call.replace(/\/P$/, ''), ...extra });
  assert.equal(sameStation(p('a', 'OE0QXA'), p('b', 'OE0QXA/P')), true);
  assert.equal(sameStation(p('a', 'OE0QXA'), p('b', 'OE0QXB')), false);
  assert.equal(sameStation(p('a', 'OE0QX?'), p('b', 'OE0QX?')), false, 'two partial calls are not matched');
  assert.equal(sameStation(p('a', 'OE0QXA', { profileId: 'x' }), p('b', 'OE0QXC', { profileId: 'x' })), true, 'a shared profile');
  assert.equal(sameStation(p('a', 'OE0QXA'), p('a', 'OE0QXA')), false, 'not itself');
});

test('history: earlier sessions newest first, across series and nets, with notes, replies, tasks; deleted left out', async () => {
  const f = await fixture();
  const recs = await all(f.store);
  const h = stationHistory(recs, f.cur, f.now.s.id);
  assert.deepEqual(h.map(e => e.session.date), ['2026-10-09', '2026-10-07', '2026-10-02'], 'not the partial one in the ad-hoc net, not today');
  assert.deepEqual(h.map(e => e.label), ['Wiener Runde #2', 'Bergrunde #1', 'Wiener Runde #1']);
  const [e2, e4, e1] = h;
  assert.equal(e1.participant.call, 'OE0QXA/P', 'the identity as recorded then');
  assert.deepEqual(e2.notes.map(n => n.note.text), ['asks about the QSL', 'already answered'], 'no deleted note');
  assert.equal(e2.notes[0].response.state, 'open');
  assert.equal(e2.notes[1].response.state, 'done');
  assert.equal(e1.notes[0].task.state, 'open');
  assert.equal(e4.notes.length, 0);
  const open = openFollowUps(h);
  assert.deepEqual(open.map(o => [o.item.kind, o.note.text]), [['task', 'new antenna, 7 el yagi'], ['response', 'asks about the QSL']]);
  assert.deepEqual(historySummary(h), { sessions: 3, open: 2 });
  // a deleted session disappears from history
  await deleteSession(f.store, { tab: TAB }, f.s2.s.id);
  const h2 = stationHistory(await all(f.store), f.cur, f.now.s.id);
  assert.deepEqual(h2.map(e => e.session.date), ['2026-10-07', '2026-10-02']);
});

test('possible matches: a partial call that fits, the same name with another call; never automatic', async () => {
  const f = await fixture();
  const recs = await all(f.store);
  const m = possibleMatches(recs, f.cur, f.now.s.id);
  assert.deepEqual(m.map(x => [x.participant.call, x.why]), [['OE0QXB', 'name'], ['OE0QX?', 'call']]);
  // from the partial side: the complete ones that fit
  const fromPartial = possibleMatches(recs, f.q3, f.s3.s.id);
  assert.ok(fromPartial.some(x => x.participant.call === 'OE0QXA' && x.why === 'call'));
  assert.equal(stationHistory(recs, f.q3, f.s3.s.id).length, 0, 'a partial call has no automatic history');
});

test('"same station" links both by a profile without touching the snapshots; undo takes it back', async () => {
  const f = await fixture();
  const before = await f.store.get('participants', f.q3.id);
  await linkSameStation(f.store, f.now.ctx, f.cur.id, f.q3.id);
  const cur = await f.store.get('participants', f.cur.id);
  const q3 = await f.store.get('participants', f.q3.id);
  assert.ok(cur.profileId);
  assert.equal(q3.profileId, cur.profileId);
  assert.equal(q3.call, 'OE0QX?', 'the old snapshot stays as recorded');
  assert.equal(q3.name, before.name);
  const prof = await f.store.get('profiles', cur.profileId);
  assert.equal(prof.call, 'OE0QXA');
  // now the ad-hoc participation is part of the history
  let h = stationHistory(await all(f.store), cur, f.now.s.id);
  assert.ok(h.some(e => e.session.id === f.s3.s.id));
  assert.ok(!possibleMatches(await all(f.store), cur, f.now.s.id).some(x => x.participant.id === f.q3.id));
  await undo(f.store, f.now.ctx);
  assert.equal((await f.store.get('participants', f.q3.id)).profileId, null);
  h = stationHistory(await all(f.store), await f.store.get('participants', f.cur.id), f.now.s.id);
  assert.ok(!h.some(e => e.session.id === f.s3.s.id));
});

test('an existing profile is reused; a corrected identity keeps its history through the profile', async () => {
  const f = await fixture();
  await saveProfile(f.store, f.s4.ctx, f.a4.id);
  const prof = (await f.store.get('participants', f.a4.id)).profileId;
  await linkSameStation(f.store, f.now.ctx, f.cur.id, f.a4.id);
  assert.equal((await f.store.get('participants', f.cur.id)).profileId, prof);
  // corrected later to another call: still the same station by its profile
  await updateParticipant(f.store, f.now.ctx, f.cur.id, { call: 'OE0QXC' });
  const cur = await f.store.get('participants', f.cur.id);
  const h = stationHistory(await all(f.store), cur, f.now.s.id);
  assert.deepEqual(h.map(e => e.session.id), [f.s4.s.id], 'by the profile only (the base no longer matches)');
});

test('"not the same" hides a suggestion for good; undoable', async () => {
  const f = await fixture();
  await markNotSame(f.store, f.now.ctx, f.cur.id, f.b4.id);
  let cur = await f.store.get('participants', f.cur.id);
  assert.deepEqual(possibleMatches(await all(f.store), cur, f.now.s.id).map(x => x.participant.call), ['OE0QX?']);
  await markNotSame(f.store, f.now.ctx, f.cur.id, f.b4.id); // twice: no change
  assert.deepEqual((await f.store.get('participants', f.cur.id)).notSame, [f.b4.id]);
  await undo(f.store, f.now.ctx);
  cur = await f.store.get('participants', f.cur.id);
  assert.equal(possibleMatches(await all(f.store), cur, f.now.s.id).length, 2);
});

test('backup: "not the same" ids are remapped with the participants they name', async () => {
  const { remapRecord } = await import('../tools/netlog/js/backup.js');
  const map = { participants: new Map([['old1', 'new1']]), sessions: new Map() };
  const r = remapRecord('participants', { id: 'p', eventId: 's', notSame: ['old1', 'other'] }, map);
  assert.deepEqual(r.notSame, ['new1', 'other']);
});
