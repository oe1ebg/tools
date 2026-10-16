// Netlog's writes (tools/netlog/js/ops.js) against the in-memory backend
// (js/memstore.js, the storage API of shared/js/storage.js): each op one
// transaction with revisions and an undo step; a failing write changes
// nothing; a tab without the session's lease cannot write; undo/redo
// refuse when a record changed since. Synthetic callsigns only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../tools/netlog/js/memstore.js';
import { NETLOG_STORES, NETLOG_SCHEMA } from '../tools/netlog/js/db.js';
import {
  createSession, createSeries, assignSeries, addParticipant, updateParticipant, setStatus, setFlag,
  moveParticipant, deleteParticipant, claimSession, undo, undoStep, LeaseError, UndoConflictError, UNDO_MAX, writeDraft,
} from '../tools/netlog/js/ops.js';

const TAB = 'tab-1';

async function fresh() {
  const store = memoryStore(NETLOG_STORES);
  const s = await createSession(store, { tab: TAB }, { own: 'oe0qxa', round: 1 });
  const ctx = { sessionId: s.id, tab: TAB };
  return { store, s, ctx };
}

const dump = async store => Object.fromEntries(await Promise.all(Object.keys(NETLOG_STORES).map(async n => [n, await store.getAll(n)])));

test('schema: stable name, every session store indexed by eventId', () => {
  assert.equal(NETLOG_SCHEMA.name, 'oe1ebg-netlog');
  assert.equal(NETLOG_SCHEMA.version, 1);
  for (const s of ['participants', 'rounds', 'contributions', 'notes', 'items', 'events', 'turns', 'revisions', 'undo', 'drafts']) {
    assert.equal(NETLOG_STORES[s].byEvent, true, s);
  }
  const created = [];
  NETLOG_SCHEMA.upgrade(0, n => created.push(n));
  assert.deepEqual(created.sort(), Object.keys(NETLOG_STORES).sort());
});

test('a session joined in round 4 starts there, without invented earlier rounds or start time', async () => {
  const store = memoryStore(NETLOG_STORES);
  const s = await createSession(store, { tab: TAB }, { round: 4, joined: true, own: 'OE0QXA/P' });
  const rounds = await store.getByEvent('rounds', s.id);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].number, 4);
  assert.equal(s.currentRoundId, rounds[0].id);
  assert.deepEqual(s.start, { iso: null, quality: 'unknown' });
  assert.deepEqual(s.own, { call: 'OE0QXA/P', base: 'OE0QXA' });
  assert.equal(s.lease, TAB);
});

test('series: number suggested, defaults copied; an ad-hoc session joins later unchanged', async () => {
  const store = memoryStore(NETLOG_STORES);
  const series = await createSeries(store, { tab: TAB }, { name: 'Evening net', defaults: { repeater: 'OE0XRA' } });
  const a = await createSession(store, { tab: TAB }, { seriesId: series.id });
  assert.equal(a.number, 1);
  assert.equal(a.radio.repeater, 'OE0XRA');
  const adhoc = await createSession(store, { tab: TAB }, {});
  const p = await addParticipant(store, { sessionId: adhoc.id, tab: TAB }, { call: 'OE0QXB' });
  const moved = await assignSeries(store, { tab: TAB, sessionId: adhoc.id }, adhoc.id, series.id);
  assert.equal(moved.id, adhoc.id);
  assert.equal(moved.number, 2);
  assert.equal(moved.currentRoundId, adhoc.currentRoundId);
  assert.deepEqual((await store.getByEvent('participants', adhoc.id)).map(x => x.id), [p.id]);
});

test('check-in with a partial callsign, corrected later: same id, history kept', async () => {
  const { store, ctx } = await fresh();
  const p = await addParticipant(store, ctx, { call: 'OE0QX?', name: '' });
  assert.equal(p.unresolved, true);
  assert.equal(p.presence.length, 1);
  await setStatus(store, ctx, p.id, 'out');
  await setStatus(store, ctx, p.id, 'active');
  const fixed = await updateParticipant(store, ctx, p.id, { call: 'oe0qxc/p', name: 'Lea' });
  assert.equal(fixed.id, p.id);
  assert.equal(fixed.call, 'OE0QXC/P');
  assert.equal(fixed.base, 'OE0QXC');
  assert.equal(fixed.unresolved, false);
  assert.equal(fixed.presence.length, 2, 'reentry kept');
  const events = await store.getByEvent('events', ctx.sessionId);
  assert.deepEqual(events.filter(e => e.participantId === p.id).map(e => e.type).sort(), ['presence', 'status', 'status']);
  const revs = (await store.getByEvent('revisions', ctx.sessionId)).filter(r => r.recordId === p.id);
  assert.ok(revs.some(r => r.record.call === 'OE0QX?'), 'the replaced version is a revision');
});

test('roster and planned order change only order fields', async () => {
  const { store, ctx } = await fresh();
  const a = await addParticipant(store, ctx, { call: 'OE0QXA' });
  const b = await addParticipant(store, ctx, { call: 'OE0QXB' });
  await moveParticipant(store, ctx, b.id, -1, 'rosterOrder');
  let ps = await store.getByEvent('participants', ctx.sessionId);
  const order = Object.fromEntries(ps.map(p => [p.call, p.rosterOrder]));
  assert.ok(order.OE0QXB < order.OE0QXA);
  await moveParticipant(store, ctx, a.id, -1, 'plannedOrder');
  ps = await store.getByEvent('participants', ctx.sessionId);
  assert.ok(ps.every(p => Number.isInteger(p.plannedOrder)));
  assert.equal(await moveParticipant(store, ctx, b.id, -1, 'rosterOrder'), false, 'already first');
});

test('a failing write changes nothing and rejects with the original error', async () => {
  const { store, ctx } = await fresh();
  const before = await dump(store);
  const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  store.failWrites = s => (s === 'events' ? quota : null);
  await assert.rejects(addParticipant(store, ctx, { call: 'OE0QXB' }), e => e === quota);
  store.failWrites = null;
  assert.deepEqual(await dump(store), before);
});

test('a tab without the lease cannot write; claiming takes it over', async () => {
  const { store, ctx } = await fresh();
  const other = { ...ctx, tab: 'tab-2' };
  await assert.rejects(addParticipant(store, other, { call: 'OE0QXB' }), LeaseError);
  await claimSession(store, ctx.sessionId, 'tab-2');
  await assert.rejects(addParticipant(store, ctx, { call: 'OE0QXB' }), LeaseError);
  const p = await addParticipant(store, other, { call: 'OE0QXB' });
  assert.equal(p.call, 'OE0QXB');
});

test('undo and redo restore the previous state; a changed record refuses', async () => {
  const { store, ctx } = await fresh();
  const p = await addParticipant(store, ctx, { call: 'OE0QXB' });
  await updateParticipant(store, ctx, p.id, { name: 'Jonas' });
  await setFlag(store, ctx, p.id, 'speak', true);
  assert.equal((await undoStep(store, ctx.sessionId)).label, 'undo.flag');
  await undo(store, ctx);
  let cur = await store.get('participants', p.id);
  assert.equal(cur.flags.speak, false);
  assert.equal(cur.name, 'Jonas');
  await undo(store, ctx);
  cur = await store.get('participants', p.id);
  assert.equal(cur.name, '');
  await undo(store, { ...ctx, redo: true });
  cur = await store.get('participants', p.id);
  assert.equal(cur.name, 'Jonas');
  // undo of the check-in soft-deletes the participant (and its event)
  await undo(store, ctx);
  await undo(store, ctx);
  cur = await store.get('participants', p.id);
  assert.ok(cur.deleted, 'soft-deleted, not erased');
  await undo(store, { ...ctx, redo: true });
  cur = await store.get('participants', p.id);
  assert.equal(cur.deleted, null);
  // a new change ends redo; a record changed outside the step refuses undo
  const q = await addParticipant(store, ctx, { call: 'OE0QXC' });
  assert.equal(await undoStep(store, ctx.sessionId, true), null);
  await setFlag(store, ctx, q.id, 'priority', true);
  const raw = await store.get('participants', q.id);
  await store.tx([{ store: 'participants', put: { ...raw, name: 'changed elsewhere', updated: '2099-01-01T00:00:00.000Z' } }]);
  await assert.rejects(undo(store, ctx), UndoConflictError);
  assert.equal((await store.get('participants', q.id)).flags.priority, true, 'nothing changed');
});

test('undo history is capped per session', async () => {
  const { store, ctx } = await fresh();
  const p = await addParticipant(store, ctx, { call: 'OE0QXB' });
  for (let i = 0; i < UNDO_MAX + 5; i++) await setFlag(store, ctx, p.id, 'speak', i % 2 === 0);
  assert.equal((await store.getByEvent('undo', ctx.sessionId)).length, UNDO_MAX);
});

test('deleting a participant is a soft delete, restorable', async () => {
  const { store, ctx } = await fresh();
  const p = await addParticipant(store, ctx, { call: 'OE0QXB' });
  await deleteParticipant(store, ctx, p.id);
  assert.ok((await store.get('participants', p.id)).deleted);
  await deleteParticipant(store, ctx, p.id, true);
  assert.equal((await store.get('participants', p.id)).deleted, null);
});

test('drafts: kept with selection, removed when empty, not undoable', async () => {
  const { store, ctx } = await fresh();
  await writeDraft(store, ctx, 'new:p1', { text: 'Antenna chang', selStart: 13, selEnd: 13 });
  const d = await store.get('drafts', `${ctx.sessionId}|new:p1`);
  assert.equal(d.text, 'Antenna chang');
  assert.equal(d.selStart, 13);
  assert.equal(await undoStep(store, ctx.sessionId), null);
  await writeDraft(store, ctx, 'new:p1', { text: '' });
  assert.equal(await store.get('drafts', `${ctx.sessionId}|new:p1`), undefined);
});
