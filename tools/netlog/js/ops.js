// Every Netlog write, each one store.atomic() transaction: read the
// current records, change them, keep the replaced versions as revisions
// and the undo step, all or nothing. "Saved" in the UI means this promise
// resolved (the transaction committed). No DOM.
//
// A writing tab holds its session's lease (session.lease = the tab's id,
// claimSession()): every write of that session first checks it, so a tab
// that lost the session to another one (Web Locks steal, or a tab without
// Web Locks) gets a LeaseError and goes read-only instead of overwriting.

import { newId, nowIso, laterIso } from '../../shared/js/time.js';
import { NETLOG_STORES } from './db.js';
import {
  normCall, baseCall, isUnresolved, timeOf, changeStatus, nextOrder, moveInOrder,
  rosterSorted, nextSessionNumber, seriesDefaults, live, FLAGS,
} from './model.js';

export const ALL_STORES = Object.keys(NETLOG_STORES);
// Stores whose replaced records are kept as revisions.
const REVISED = new Set(['series', 'sessions', 'profiles', 'participants', 'rounds', 'contributions', 'notes', 'items', 'events']);
// Undo steps kept per session (oldest dropped first).
export const UNDO_MAX = 200;

export class LeaseError extends Error {
  constructor(sessionId) {
    super('lease');
    this.name = 'LeaseError';
    this.sessionId = sessionId;
  }
}
export class UndoConflictError extends Error {
  constructor(store, id) {
    super('undo-conflict');
    this.name = 'UndoConflictError';
    this.store = store;
    this.id = id;
  }
}

const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

// The writer handed to an op: reads go to the transaction, writes record
// the before-image (once per record) for undo and a revision of the
// replaced version.
function writer(api, sessionId, now) {
  const before = new Map();
  const written = new Map();
  const remember = (store, id, prev) => {
    const k = `${store}\u0000${id}`;
    if (!before.has(k)) before.set(k, { store, id, value: clone(prev ?? null) });
  };
  const w = {
    now,
    sessionId,
    get: (store, id) => api.get(store, id),
    all: (store, sid = sessionId) => (NETLOG_STORES[store].byEvent ? api.getByEvent(store, sid) : api.getAll(store)),
    // Store `next` replacing `prev` (the record as read in this
    // transaction, or null for a new one).
    put(store, next, prev, { revise = true } = {}) {
      const rec = { ...next };
      rec.created = prev ? prev.created : (rec.created || now);
      rec.updated = laterIso(prev ? prev.updated : null, now);
      remember(store, rec.id, prev);
      if (prev && revise && REVISED.has(store)) {
        api.put('revisions', { id: newId(), eventId: prev.eventId || sessionId || '', store, recordId: prev.id, at: now, record: clone(prev) });
      }
      api.put(store, rec);
      written.set(`${store}\u0000${rec.id}`, { store, id: rec.id, updated: rec.updated });
      return rec;
    },
    async update(store, id, change) {
      const prev = await api.get(store, id);
      if (!prev) throw new Error(`${store} ${id} not found`);
      const next = typeof change === 'function' ? change(clone(prev)) : { ...prev, ...change };
      if (!next) return prev;
      return w.put(store, next, prev);
    },
    create(store, fields) {
      const rec = { id: newId(), ...fields };
      if (NETLOG_STORES[store].byEvent && !rec.eventId) rec.eventId = sessionId;
      return w.put(store, rec, null);
    },
    raw: api,
    changes: () => [...written.values()],
    before: () => [...before.values()],
  };
  return w;
}

// Run `fn(w)` as one transaction. opts:
//   sessionId   the session the op belongs to (lease check, undo history)
//   tab         this tab's id; with sessionId the lease must be this tab's
//   label       the undo step's name (a translation key); null: not undoable
// Resolves to fn's result after the commit.
export async function runOp(store, { sessionId = null, tab = null, label = null } = {}, fn) {
  return store.atomic(ALL_STORES, async api => {
    const now = nowIso();
    if (sessionId && tab) {
      const s = await api.get('sessions', sessionId);
      if (s && s.lease && s.lease !== tab) throw new LeaseError(sessionId);
    }
    const w = writer(api, sessionId, now);
    const result = await fn(w);
    if (label && w.changes().length) await pushUndo(api, sessionId, label, w, now);
    return result;
  });
}

async function pushUndo(api, sessionId, label, w, now) {
  const eventId = sessionId || '';
  const steps = (await api.getByEvent('undo', eventId)).sort((a, b) => a.seq - b.seq);
  // a new change ends what could be redone
  for (const s of steps.filter(s => s.undone)) api.del('undo', s.id);
  const kept = steps.filter(s => !s.undone);
  const seq = (steps.length ? steps[steps.length - 1].seq : 0) + 1;
  api.put('undo', { id: newId(), eventId, seq, label, at: now, undone: false, before: w.before(), after: w.changes() });
  for (const s of kept.slice(0, Math.max(0, kept.length + 1 - UNDO_MAX))) api.del('undo', s.id);
}

// The step undo() (or redo()) would apply, or null.
export async function undoStep(store, sessionId, redo = false) {
  const steps = (await store.getByEvent('undo', sessionId || '')).filter(s => !!s.undone === redo);
  if (!steps.length) return null;
  steps.sort((a, b) => a.seq - b.seq);
  return redo ? steps[0] : steps[steps.length - 1];
}

// Undo the latest step of a session (redo: the oldest undone one). Only
// when every record it changed is still as that step left it; otherwise
// an UndoConflictError and nothing changes. Restoring writes new versions
// (with revisions), so the undone state stays in the history too. A
// record the step created is soft-deleted.
export async function undo(store, { sessionId, tab = null, redo = false }) {
  return store.atomic(ALL_STORES, async api => {
    const now = nowIso();
    if (sessionId && tab) {
      const s = await api.get('sessions', sessionId);
      if (s && s.lease && s.lease !== tab) throw new LeaseError(sessionId);
    }
    const steps = (await api.getByEvent('undo', sessionId || '')).filter(s => !!s.undone === redo).sort((a, b) => a.seq - b.seq);
    if (!steps.length) return null;
    const step = redo ? steps[0] : steps[steps.length - 1];
    const expect = redo ? step.redoExpect : step.after;
    const target = redo ? step.redoValues : step.before;
    const w = writer(api, sessionId, now);
    for (const e of expect) {
      const cur = await api.get(e.store, e.id);
      if ((cur ? cur.updated : null) !== e.updated) throw new UndoConflictError(e.store, e.id);
    }
    // what redo would put back
    const redoValues = [];
    for (const b of target) {
      const cur = await api.get(b.store, b.id);
      redoValues.push({ store: b.store, id: b.id, value: clone(cur ?? null) });
      if (b.value) w.put(b.store, { ...b.value }, cur);
      else if (cur && !cur.deleted) w.put(b.store, { ...cur, deleted: now }, cur);
    }
    const after = w.changes();
    if (redo) api.put('undo', { ...step, undone: false, after, redoExpect: undefined, redoValues: undefined });
    else api.put('undo', { ...step, undone: true, redoExpect: after, redoValues });
    // The restored records have new `updated` stamps: the neighbouring step
    // that expects such a record (the next undo, or the next redo) now
    // expects the new stamp, so a chain of undos (or redos) goes on.
    const all = await api.getByEvent('undo', sessionId || '');
    const stamp = new Map(after.map(a => [`${a.store}\u0000${a.id}`, a.updated]));
    const chain = redo
      ? all.filter(s => s.undone && s.seq > step.seq).sort((a, b) => a.seq - b.seq)
      : all.filter(s => !s.undone && s.seq < step.seq).sort((a, b) => b.seq - a.seq);
    for (const s of chain) {
      const field = redo ? 'redoExpect' : 'after';
      let touched = false;
      const list = (s[field] || []).map(e => {
        const k = `${e.store}\u0000${e.id}`;
        if (!stamp.has(k)) return e;
        touched = true;
        const v = { ...e, updated: stamp.get(k) };
        stamp.delete(k); // only the nearest step expects it
        return v;
      });
      if (touched) api.put('undo', { ...s, [field]: list });
      if (!stamp.size) break;
    }
    return step;
  });
}

// ---------- lease (one writing tab per session) ----------

// Make this tab the session's writer (opening it, or "Edit here").
export function claimSession(store, sessionId, tab) {
  return runOp(store, {}, async w => {
    const s = await w.get('sessions', sessionId);
    if (!s || s.lease === tab) return s;
    return w.put('sessions', { ...s, lease: tab }, s, { revise: false });
  });
}

// ---------- series ----------

export function createSeries(store, ctx, fields) {
  return runOp(store, { ...ctx, sessionId: null, label: 'undo.createSeries' }, async w => w.create('series', {
    name: String(fields.name || '').trim(),
    description: fields.description || '',
    schedule: fields.schedule || '',
    defaults: { repeater: '', freq: '', mode: '', ncs: '', ...(fields.defaults || {}) },
    numbering: fields.numbering === 'none' ? 'none' : 'sequential',
    deleted: null,
  }));
}

export function updateSeries(store, ctx, id, patch) {
  return runOp(store, { ...ctx, sessionId: null, label: 'undo.editSeries' }, w => w.update('series', id, s => ({
    ...s, ...patch, defaults: { ...s.defaults, ...(patch.defaults || {}) },
  })));
}

// ---------- sessions ----------

// A new session, ready for logging: its first round is `round` (default
// 1; joining a running net in round 4 starts there, with no invented
// earlier rounds). The series' defaults are copied, not linked.
export function createSession(store, ctx, fields) {
  return runOp(store, { ...ctx, sessionId: null, label: null }, async w => {
    const series = fields.seriesId ? await w.get('series', fields.seriesId) : null;
    const defs = seriesDefaults(series);
    let number = fields.number;
    if (number === undefined && series && series.numbering !== 'none') {
      number = nextSessionNumber(await w.all('sessions'), series.id);
    }
    const id = newId();
    const roundNo = Number.isInteger(fields.round) && fields.round > 0 ? fields.round : 1;
    const round = w.create('rounds', { eventId: id, number: roundNo, order: roundNo, topic: '', start: timeOf(fields.joined ? null : w.now, 'exact'), deleted: null });
    const own = normCall(fields.own || '');
    const session = w.put('sessions', {
      id,
      seriesId: series ? series.id : null,
      number: number === '' || number == null ? null : Number(number),
      name: String(fields.name || '').trim(),
      date: fields.date || w.now.slice(0, 10),
      own: { call: own, base: baseCall(own) },
      radio: { ...defs.radio, ...(fields.radio || {}) },
      suggestedNcs: defs.suggestedNcs,
      start: fields.joined ? timeOf(null) : timeOf(w.now),
      end: timeOf(null),
      joinedLate: !!fields.joined,
      currentRoundId: round.id,
      ncsId: null,
      lease: ctx.tab || null,
      deleted: null,
    }, null);
    return session;
  });
}

const SESSION_FIELDS = ['name', 'date', 'number', 'radio', 'own', 'start', 'end', 'seriesId'];

export function updateSession(store, ctx, id, patch) {
  return runOp(store, { ...ctx, sessionId: id, label: 'undo.editSession' }, w => w.update('sessions', id, s => {
    const next = { ...s };
    for (const k of SESSION_FIELDS) if (k in patch) next[k] = patch[k];
    if ('own' in patch) {
      const call = normCall(patch.own && patch.own.call !== undefined ? patch.own.call : patch.own);
      next.own = { call, base: baseCall(call) };
    }
    if ('number' in patch) next.number = patch.number === '' || patch.number == null ? null : Number(patch.number);
    return next;
  }));
}

// Put an ad-hoc session into a series later (or take it out: null). Its
// identity, notes and history stay; number suggested if not given.
export function assignSeries(store, ctx, id, seriesId, number) {
  return runOp(store, { ...ctx, sessionId: id, label: 'undo.assignSeries' }, async w => {
    const all = await w.all('sessions');
    return w.update('sessions', id, s => ({
      ...s,
      seriesId: seriesId || null,
      number: number !== undefined ? (number === '' || number == null ? null : Number(number))
        : (seriesId ? (s.seriesId === seriesId ? s.number : nextSessionNumber(all, seriesId)) : s.number),
    }));
  });
}

export function deleteSession(store, ctx, id, restore = false) {
  return runOp(store, { ...ctx, sessionId: id, label: restore ? 'undo.restoreSession' : 'undo.deleteSession' },
    w => w.update('sessions', id, s => ({ ...s, deleted: restore ? null : w.now })));
}

// ---------- participants ----------

const DETAIL_FIELDS = ['name', 'qth', 'locator', 'rst', 'echolink', 'member', 'note'];

function participantRecord(fields, w, order, roundId) {
  const call = normCall(fields.call);
  const rec = {
    eventId: w.sessionId,
    call,
    base: baseCall(call),
    unresolved: isUnresolved(call),
    profileId: fields.profileId || null,
    status: 'active',
    flags: { speak: false, short: false, reception: false, priority: false },
    presence: [{ from: timeOf(w.now), to: null }],
    rosterOrder: order,
    plannedOrder: null,
    checkinRoundId: roundId || null,
    deleted: null,
  };
  for (const k of DETAIL_FIELDS) rec[k] = k === 'echolink' ? !!fields[k] : String(fields[k] || '');
  return rec;
}

// Check a station in (also partial or unknown callsigns: "OE0QX?", "?").
// Late check-ins join the current round; nothing about earlier rounds is
// assumed.
export function addParticipant(store, ctx, fields) {
  return runOp(store, { ...ctx, label: 'undo.addParticipant' }, async w => {
    const session = await w.get('sessions', ctx.sessionId);
    const list = await w.all('participants');
    let fromProfile = {};
    if (fields.profileId) {
      const prof = await w.get('profiles', fields.profileId);
      if (prof && live(prof)) fromProfile = { call: prof.call, name: prof.name, qth: prof.qth, locator: prof.locator, echolink: prof.echolink, member: prof.member };
    }
    const rec = w.create('participants', participantRecord({ ...fromProfile, ...fields }, w, nextOrder(list, 'rosterOrder'), session && session.currentRoundId));
    w.create('events', { type: 'presence', kind: 'checkin', participantId: rec.id, roundId: session && session.currentRoundId, time: timeOf(w.now), deleted: null });
    return rec;
  });
}

// Correct identity or details. A callsign correction keeps the
// participant's id, so its notes, responses, intervals and events stay.
export function updateParticipant(store, ctx, id, patch) {
  return runOp(store, { ...ctx, label: 'call' in patch ? 'undo.correctCall' : 'undo.editParticipant' }, w => w.update('participants', id, p => {
    const next = { ...p };
    if ('call' in patch) {
      next.call = normCall(patch.call);
      next.base = baseCall(next.call);
      next.unresolved = isUnresolved(next.call);
    }
    for (const k of DETAIL_FIELDS) if (k in patch) next[k] = k === 'echolink' ? !!patch[k] : String(patch[k] ?? '');
    if ('profileId' in patch) next.profileId = patch.profileId || null;
    if ('presence' in patch) next.presence = patch.presence;
    return next;
  }));
}

export function setStatus(store, ctx, id, status) {
  return runOp(store, { ...ctx, label: 'undo.status' }, async w => {
    const p = await w.get('participants', id);
    const ch = changeStatus(p, status, w.now);
    if (!ch) return p;
    const session = await w.get('sessions', ctx.sessionId);
    w.create('events', { ...ch.event, roundId: session && session.currentRoundId, deleted: null });
    return w.put('participants', ch.participant, p);
  });
}

export function setFlag(store, ctx, id, flag, on) {
  if (!FLAGS.includes(flag)) throw new Error(`flag ${flag}`);
  return runOp(store, { ...ctx, label: 'undo.flag' }, w => w.update('participants', id, p => (
    !!p.flags[flag] === !!on ? null : { ...p, flags: { ...p.flags, [flag]: !!on } })));
}

// Move a station up/down in the roster (field 'rosterOrder') or the
// planned speaking order ('plannedOrder'). Never touches contributions.
export function moveParticipant(store, ctx, id, dir, field = 'rosterOrder') {
  return runOp(store, { ...ctx, label: 'undo.reorder' }, async w => {
    const list = await w.all('participants');
    const sorted = field === 'rosterOrder' ? rosterSorted(list)
      : rosterSorted(list).sort((a, b) => (a.plannedOrder ?? Infinity) - (b.plannedOrder ?? Infinity));
    const changes = moveInOrder(sorted.map(p => ({ ...p, order: p[field] })), id, dir, 'order');
    for (const c of changes) {
      const p = list.find(x => x.id === c.id);
      w.put('participants', { ...p, [field]: c.order }, p);
    }
    return changes.length > 0;
  });
}

export function deleteParticipant(store, ctx, id, restore = false) {
  return runOp(store, { ...ctx, label: restore ? 'undo.restoreParticipant' : 'undo.deleteParticipant' },
    w => w.update('participants', id, p => ({ ...p, deleted: restore ? null : w.now })));
}

// ---------- drafts ----------

// The unfinished text of one editor (key: 'new:<participantId>' for a new
// note, 'note:<id>' / 'item:<id>' for an edit), with its selection. Not
// undoable and not revised: a draft is not a saved record.
export function writeDraft(store, ctx, key, draft) {
  return runOp(store, { ...ctx, label: null }, async w => {
    const id = `${ctx.sessionId}|${key}`;
    const prev = await w.get('drafts', id);
    if (!draft || (!draft.text && !draft.keep)) {
      if (prev) w.raw.del('drafts', id);
      return null;
    }
    return w.put('drafts', { id, eventId: ctx.sessionId, key, text: draft.text, selStart: draft.selStart ?? null, selEnd: draft.selEnd ?? null, base: draft.base ?? null }, prev, { revise: false });
  });
}
