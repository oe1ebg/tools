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
  nextSeq, nextRoundNumber, latestContribution, responseOf, queueItems, openTurn, QUEUE_KINDS,
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

// ---------- rounds ----------

// A new round, made the current one: only ever by this explicit action
// (a note, a reorder or a return to the NCS never starts one).
export function createRound(store, ctx, { number, topic = '' } = {}) {
  return runOp(store, { ...ctx, label: 'undo.newRound' }, async w => {
    const session = await w.get('sessions', ctx.sessionId);
    const rounds = await w.all('rounds');
    const no = Number.isInteger(number) && number > 0 ? number : nextRoundNumber(rounds);
    const order = Math.max(0, ...rounds.filter(live).map(r => r.order ?? 0)) + 1;
    const round = w.create('rounds', { number: no, order, topic: String(topic || '').trim(), start: timeOf(w.now), deleted: null });
    w.create('events', { type: 'round', kind: 'new', from: session.currentRoundId, to: round.id, time: timeOf(w.now), deleted: null });
    w.put('sessions', { ...session, currentRoundId: round.id }, session);
    return round;
  });
}

// Select another round as the current one (a correction, or going back).
export function setCurrentRound(store, ctx, roundId) {
  return runOp(store, { ...ctx, label: 'undo.currentRound' }, async w => {
    const session = await w.get('sessions', ctx.sessionId);
    if (session.currentRoundId === roundId) return session;
    w.create('events', { type: 'round', kind: 'select', from: session.currentRoundId, to: roundId, time: timeOf(w.now), deleted: null });
    return w.put('sessions', { ...session, currentRoundId: roundId }, session);
  });
}

// Correct a round's number or topic (its notes stay where they are).
export function updateRound(store, ctx, id, patch) {
  return runOp(store, { ...ctx, label: 'undo.editRound' }, w => w.update('rounds', id, r => {
    const next = { ...r };
    if ('topic' in patch) next.topic = String(patch.topic || '').trim();
    if ('number' in patch && Number.isInteger(patch.number) && patch.number > 0) next.number = patch.number;
    return next;
  }));
}

// ---------- contributions (who spoke, in which order) ----------

// Record that a station spoke now (repeated and interrupted turns are just
// more contributions). Optional: notes never need one.
export function addContribution(store, ctx, participantId, { roundId = null, time = null } = {}) {
  return runOp(store, { ...ctx, label: 'undo.spoke' }, async w => {
    const session = await w.get('sessions', ctx.sessionId);
    const [notes, contributions] = await Promise.all([w.all('notes'), w.all('contributions')]);
    return w.create('contributions', {
      participantId, roundId: roundId || session.currentRoundId, seq: nextSeq(notes, contributions),
      time: time || timeOf(w.now), deleted: null,
    });
  });
}

// ---------- notes ----------

// A new observation of a station in a round (default: the current one),
// at the end of the recorded order. flagged: also an on-air reminder.
export function createNote(store, ctx, { participantId, roundId = null, text, flagged = false, id = null, draftKey = null }) {
  return runOp(store, { ...ctx, label: 'undo.newNote' }, async w => {
    dropDraft(w, draftKey);
    // the editor's id makes a retried save idempotent
    if (id) {
      const done = await w.get('notes', id);
      if (done) return done;
    }
    const session = await w.get('sessions', ctx.sessionId);
    const [notes, contributions] = await Promise.all([w.all('notes'), w.all('contributions')]);
    const rid = roundId || session.currentRoundId;
    const c = latestContribution(contributions, participantId, rid);
    const note = w.put('notes', {
      id: id || newId(), eventId: ctx.sessionId, participantId, roundId: rid, contributionId: c ? c.id : null,
      text: String(text), seq: nextSeq(notes, contributions), time: timeOf(w.now), deleted: null,
    }, null);
    if (flagged) await flagNote(w, note, true);
    return note;
  });
}

export function updateNote(store, ctx, id, text, draftKey = null) {
  return runOp(store, { ...ctx, label: 'undo.editNote' }, w => {
    dropDraft(w, draftKey);
    return w.update('notes', id, n => (n.text === text ? null : { ...n, text }));
  });
}

export function deleteNote(store, ctx, id, restore = false) {
  return runOp(store, { ...ctx, label: restore ? 'undo.restoreNote' : 'undo.deleteNote' },
    w => w.update('notes', id, n => ({ ...n, deleted: restore ? null : w.now })));
}

// A saved record replaces its draft in the same transaction, so a reload
// never shows the saved text again as unsaved input.
function dropDraft(w, key) {
  if (key && w.sessionId) w.raw.del('drafts', `${w.sessionId}|${key}`);
}

// ---------- on-air responses, talking points, after-net tasks ----------

async function nextItemOrder(w) {
  const items = await w.all('items');
  return Math.max(0, ...items.filter(i => live(i) && QUEUE_KINDS.includes(i.kind)).map(i => i.order ?? 0)) + 1;
}

function stateChange(item, state, at, turnId) {
  return {
    ...item,
    state,
    doneTurnId: state === 'done' ? turnId || null : null,
    history: [...(item.history || []), { state, at, turnId: turnId || null }],
  };
}

// Flag (on) or unflag a note for an on-air response. One response item per
// note: reflagging reactivates it (with its prepared text), never a
// duplicate; unflagging only takes it out of the queue.
async function flagNote(w, note, on) {
  const items = await w.all('items');
  const cur = responseOf(items, note.id);
  if (on) {
    if (cur && cur.active !== false && cur.state !== 'done') return cur;
    const order = await nextItemOrder(w);
    if (cur) {
      const reopened = cur.state === 'done' ? stateChange(cur, 'open', w.now, null) : cur;
      return w.put('items', { ...reopened, active: true, order }, cur);
    }
    return w.create('items', { kind: 'response', noteId: note.id, text: '', state: 'open', active: true, order, history: [{ state: 'open', at: w.now, turnId: null }], doneTurnId: null, deleted: null });
  }
  if (!cur || cur.active === false) return cur;
  return w.put('items', { ...cur, active: false }, cur);
}

// Toggle the on-air flag of a note; resolves to the response item.
export function toggleResponse(store, ctx, noteId, on = null) {
  return runOp(store, { ...ctx, label: 'undo.flagNote' }, async w => {
    const note = await w.get('notes', noteId);
    const cur = responseOf(await w.all('items'), noteId);
    const want = on === null ? !(cur && cur.active !== false && cur.state !== 'done') : on;
    return flagNote(w, note, want);
  });
}

// The prepared reply / point text / task text.
export function setItemText(store, ctx, id, text, draftKey = null) {
  return runOp(store, { ...ctx, label: 'undo.editReply' }, w => {
    dropDraft(w, draftKey);
    return w.update('items', id, i => (i.text === text ? null : { ...i, text }));
  });
}

// Complete or reopen an item; the history keeps every change. Completion
// during an open My Turn cycle belongs to it (shown subdued until End
// Turn). Never advances the round.
// done null: toggle, decided on the stored state (not a stale copy).
export function setItemDone(store, ctx, id, done) {
  return runOp(store, { ...ctx, label: done === false ? 'undo.reopen' : 'undo.complete' }, async w => {
    const item = await w.get('items', id);
    const state = done === null ? (item.state === 'done' ? 'open' : 'done') : (done ? 'done' : 'open');
    if (item.state === state) return item;
    const turn = openTurn(await w.all('turns'));
    return w.put('items', stateChange(item, state, w.now, turn ? turn.id : null), item);
  });
}

// A personal talking point: no station, no note needed.
export function addPoint(store, ctx, text, draftKey = null) {
  return runOp(store, { ...ctx, label: 'undo.addPoint' }, async w => {
    dropDraft(w, draftKey);
    return w.create('items', {
      kind: 'point', noteId: null, text: String(text), state: 'open', active: true, order: await nextItemOrder(w),
      history: [{ state: 'open', at: w.now, turnId: null }], doneTurnId: null, deleted: null,
    });
  });
}

export function deleteItem(store, ctx, id, restore = false) {
  return runOp(store, { ...ctx, label: restore ? 'undo.restoreItem' : 'undo.deleteItem' },
    w => w.update('items', id, i => ({ ...i, deleted: restore ? null : w.now })));
}

// Move an item up/down in the My Turn checklist (manual order).
export function moveItem(store, ctx, id, dir) {
  return runOp(store, { ...ctx, label: 'undo.reorderItems' }, async w => {
    const [items, notes, turns] = await Promise.all([w.all('items'), w.all('notes'), w.all('turns')]);
    const turn = openTurn(turns);
    const queue = queueItems(items, notes, turn ? turn.id : null);
    const changes = moveInOrder(queue, id, dir, 'order');
    for (const c of changes) {
      const it = items.find(x => x.id === c.id);
      w.put('items', { ...it, order: c.order }, it);
    }
    return changes.length > 0;
  });
}

// An after-net follow-up task for a note (separate from its on-air
// response; completing one never completes the other), toggled like the
// flag. Without a note: a task of its own.
export function toggleTask(store, ctx, noteId, on = null) {
  return runOp(store, { ...ctx, label: 'undo.task' }, async w => {
    const cur = responseOf(await w.all('items'), noteId, 'task');
    const want = on === null ? !(cur && cur.active !== false) : on;
    if (want) {
      if (cur && cur.active !== false) return cur;
      if (cur) return w.put('items', { ...cur, active: true }, cur);
      return w.create('items', { kind: 'task', noteId, text: '', state: 'open', active: true, order: 0, history: [{ state: 'open', at: w.now, turnId: null }], doneTurnId: null, deleted: null });
    }
    if (!cur || cur.active === false) return cur;
    return w.put('items', { ...cur, active: false }, cur);
  });
}

export function addTask(store, ctx, text) {
  return runOp(store, { ...ctx, label: 'undo.task' }, w => w.create('items', {
    kind: 'task', noteId: null, text: String(text), state: 'open', active: true, order: 0,
    history: [{ state: 'open', at: w.now, turnId: null }], doneTurnId: null, deleted: null,
  }));
}

// ---------- My Turn review cycles ----------

// The open cycle, started when My Turn is opened and none is open; it
// survives navigation and reloads until End Turn.
export function startTurn(store, ctx) {
  return runOp(store, { ...ctx, label: null }, async w => {
    const cur = openTurn(await w.all('turns'));
    return cur || w.create('turns', { started: w.now, ended: null, deleted: null });
  });
}

// End Turn: completed items leave the checklist (their history stays),
// open ones carry over. The round does not change.
export function endTurn(store, ctx) {
  return runOp(store, { ...ctx, label: 'undo.endTurn' }, async w => {
    const cur = openTurn(await w.all('turns'));
    if (!cur) return null;
    return w.put('turns', { ...cur, ended: w.now }, cur);
  });
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
