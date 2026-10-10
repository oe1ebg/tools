// The storage operations of the Notfunk-Meldebuch that must not lose or
// duplicate anything: each one is a single store.atomic() (all or nothing)
// and, where it changes a stored message, a compare-and-set on `updated`
// (storage.js getUnchanged()): a message changed since the caller read it
// (another tab, a handover) is not overwritten but reported as a
// ConflictError, and nothing is written. Pure apart from the store, so the
// node tests run them on the real storage layer.

import { saveNumbered } from './numbering.js';
import { newMessage, setStatus, currentStatus, STATUS_FLOW } from './model.js';
import { mergeBackup } from './export.js';

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
      put('messages', setStatus(orig, 'answered', { operator: meta.operator, now: meta.now, note: saved.number }));
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
    const { next, revision } = change(cur);
    put('messages', next);
    if (revision) put('revisions', revision);
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
    await getUnchanged('drafts', opId, seen);
    put('drafts', { ...draft, eventId: opId, updated: draft.saved });
    return draft.saved;
  });
}

// Removes the draft if it is still the one this tab saw; true when there is
// none now. (atomic() has no delete: the check and the delete are two steps,
// and the window is the time between them.)
export async function clearDraft(store, opId, seen) {
  const cur = await store.get('drafts', opId);
  if (!cur) return true;
  if ((cur.updated ?? null) !== seen) return false;
  await store.tx([{ store: 'drafts', del: opId }]);
  return true;
}
// TODO(#22): with atomic() del(), make this one getUnchanged + del.
