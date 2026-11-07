// The storage operations of the Notfunk-Meldebuch that must not lose or
// duplicate anything: each one is a single store.atomic() (all or nothing)
// and, where it changes a stored message, a compare-and-set on `updated`
// (storage.js getUnchanged()): a message changed since the caller read it
// (another tab, a handover) is not overwritten but reported as a
// ConflictError, and nothing is written. Pure apart from the store, so the
// node tests run them on the real storage layer.

import { saveNumbered } from './numbering.js';
import { newMessage, setStatus, currentStatus, messageFields, STATUS_FLOW } from './model.js';
import { mergeBackup } from './export.js';

// The compare-and-set token of a record is its `updated`. A wall clock is not
// unique (two writes in one millisecond, a clock set back), so every write
// of an existing record stores a strictly greater value: the clock, or the
// previous one + 1 ms. Same format as before; a stale writer's token never
// matches again.
export function bumpUpdated(prev, now) {
  const p = Date.parse(prev || '');
  return Number.isNaN(p) || Date.parse(now) > p ? now : new Date(p + 1).toISOString();
}

// What an edit is based on (state of the form page, also kept in the draft):
// base = { id, updated, fields }: the message as it was opened (its token and
// field values). Restoring a draft rebuilds the message from storage, but the
// token and the fields stay those of the opened version, so a change made
// meanwhile (another tab) is a conflict, not silently reverted.
export function editBaseOf(msg, saved = null) {
  return saved && saved.id === msg.id ? saved : { id: msg.id, updated: msg.updated ?? null, fields: messageFields(msg) };
}

// What a stored edit draft is an edit of, given the message it names (as
// stored now, or undefined): { editing, base, stale, gone }.
// - the draft has its base: that (a change made since is a conflict at save)
// - an older draft without one (before bases were kept): the version it was
//   opened on is unknown, and no timestamp can tell (another tab may have
//   changed the message after it was opened and before the form autosaved).
//   Always stale: the draft text must not be applied without a review
//   (the caller skips that when the draft's fields equal the message).
//   base = the current version, used once the user has chosen.
// - the message is gone: editing null, gone true (the draft is not an edit).
export function draftEditState(msg, draft) {
  if (!draft?.editingId) return { editing: null, base: null, stale: false, gone: false };
  if (!msg) return { editing: null, base: null, stale: false, gone: true };
  if (draft.base && draft.base.id === msg.id) return { editing: msg, base: draft.base, stale: false, gone: false };
  return { editing: msg, base: editBaseOf(msg), stale: true, gone: false };
}

// The message to hand updateMessage() for an edit: current content, token of the opened version.
export function editTarget(current, base) {
  return { ...current, updated: base.updated };
}

// A new message: number, message and (for a reply) the "answered" status of
// the message it answers in ONE transaction. messageId is kept for as long
// as the entry is the same, so a retry returns the committed message.
// meta: { operator, stationCall, now }.
export function saveNewMessage(store, { op, fields, messageId, meta }) {
  return saveNumbered(store, { opId: op.id, prefix: op.prefix, recordStore: 'messages', id: messageId },
    numbered => newMessage(fields, numbered, { id: messageId, opId: op.id, ...meta }),
    async ({ get, put }, saved) => {
      if (saved.refKind !== 'antwort' || !saved.replyTo) return;
      const orig = await get('messages', saved.replyTo);
      if (!orig || orig.eventId !== op.id || STATUS_FLOW.indexOf(currentStatus(orig)) >= STATUS_FLOW.indexOf('answered')) return;
      const next = setStatus(orig, 'answered', { operator: meta.operator, now: meta.now, note: saved.number });
      put('messages', { ...next, updated: bumpUpdated(orig.updated, next.updated) });
    });
}

// Changes a stored message that the caller has read as msg: change(cur)
// gets the message as stored (equal to msg, or the call throws) and returns
// { next, revision? } (editMessage() shape; a revision holds the actual
// replaced record). Rejects with a ConflictError when the message changed
// since msg was read.
export function updateMessage(store, msg, change) {
  return store.atomic(['messages', 'revisions'], async ({ getUnchanged, put }) => {
    const cur = await getUnchanged('messages', msg.id, msg.updated ?? null);
    const made = change(cur);
    const next = { ...made.next, updated: bumpUpdated(cur.updated, made.next.updated) };
    put('messages', next);
    if (made.revision) put('revisions', made.revision);
    return next;
  });
}

// The fields of an edit that differ from base (the fields of the version the
// user opened). Only these are sent as changes, so what another tab changed
// in other fields is kept when the edit is applied to the current version.
export function changedFields(fields, base) {
  return Object.fromEntries(Object.entries(fields).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(base[k])));
}

// Restores a backup: the merge decision and its writes in one transaction,
// with the records as they are stored now (ids are global, numbers per
// operation). Resolves to mergeBackup()'s result.
export function applyBackup(store, backup) {
  const opId = backup.operation.id;
  return store.atomic(['operations', 'messages', 'revisions', 'counters'], async ({ get, getAll, getByEvent, put }) => {
    const existing = {
      operation: await get('operations', opId),
      messages: await getByEvent('messages', opId),
      revisions: await getByEvent('revisions', opId),
      counters: await getByEvent('counters', opId),
      allMessages: await getAll('messages'),
      allRevisions: await getAll('revisions'),
    };
    const r = mergeBackup(backup, existing);
    for (const o of r.ops) put(o.store, o.put);
    return r;
  });
}

// An operation changed (archived, backup time): the patch is applied to the
// operation as stored now, so another tab's change to other fields stays.
export function patchOperation(store, opId, patch, now) {
  return store.atomic(['operations'], async ({ get, put }) => {
    const cur = await get('operations', opId);
    if (!cur) throw new Error('Einsatz nicht gefunden');
    const next = { ...cur, ...patch, updated: now };
    put('operations', next);
    return next;
  });
}

// The draft of an operation (the half-typed message). seen: the `updated`
// of the draft this tab last read or wrote (undefined: there was none). A
// draft that is not that one any more was written by another tab: nothing is
// overwritten (ConflictError, e.current = the other draft).
export function writeDraft(store, opId, draft, seen) {
  return store.atomic(['drafts'], async ({ getUnchanged, put }) => {
    const cur = await getUnchanged('drafts', opId, seen);
    const updated = bumpUpdated(cur?.updated, draft.saved);
    put('drafts', { ...draft, eventId: opId, updated });
    return updated;
  });
}

// Removes the draft if it is still the one this tab saw (check and delete in
// one transaction: a newer draft of another tab survives); true when there
// is none now, false when it is another one.
export function clearDraft(store, opId, seen) {
  return store.atomic(['drafts'], async ({ get, del }) => {
    const cur = await get('drafts', opId);
    if (!cur) return true;
    if ((cur.updated ?? null) !== seen) return false;
    del('drafts', opId);
    return true;
  });
}
