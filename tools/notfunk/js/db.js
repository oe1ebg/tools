// Persistent storage of the Notfunk-Meldebuch: its schema for the shared
// storage layer (tools/shared/js/storage.js: IndexedDB, localStorage
// fallback, same API, atomic() for numbering).
//
// Stores: operations (Einsätze), messages, revisions (earlier versions of
// edited messages), counters (last message number per operation and
// station prefix, numbering.js), drafts (keyed by operation: the half-typed
// message), stations (keyed by operation + name: who was heard, for
// completion). Nothing user-entered is ever hard-deleted: messages and
// operations get a `deleted` timestamp; only drafts are removed.

import { openToolStorage } from '../../shared/js/storage.js';
import { counterKey } from './numbering.js';

export const NOTFUNK_STORES = {
  operations: { keyPath: 'id', byEvent: false },
  messages: { keyPath: 'id', byEvent: true },
  revisions: { keyPath: 'id', byEvent: true },
  counters: { keyPath: 'id', byEvent: true },
  drafts: { keyPath: 'eventId', byEvent: false },
  stations: { keyPath: 'id', byEvent: true },
};

// Moving localStorage fallback records into IndexedDB (migrateFallback()):
// a message whose number (operation + prefix + seq, or its text) is taken
// by another message stays in the fallback and is reported, never
// renumbered; so does whatever belongs to a record that isn't there
// (revision -> message, message/counter/station/draft -> operation).
// Counters end at least at the highest migrated number.
const opParent = [{ store: 'operations', key: r => r.eventId }];
export const NOTFUNK_MIGRATION = {
  unique: {
    messages: r => [
      r.eventId != null && r.prefix && r.seq != null ? `seq:${r.eventId}:${r.prefix}:${r.seq}` : null,
      r.eventId != null && r.number ? `number:${r.eventId}:${r.number}` : null,
    ],
  },
  parents: {
    messages: opParent,
    counters: opParent,
    stations: opParent,
    drafts: opParent,
    revisions: [{ store: 'messages', key: r => r.messageId }],
  },
  async fixup({ get, put }, migrated) {
    const top = new Map();
    for (const { store, value: m } of migrated) {
      if (store !== 'messages' || !m.prefix || !(m.seq > 0)) continue;
      const id = counterKey(m.eventId, m.prefix);
      if (!(top.get(id)?.last >= m.seq)) top.set(id, { id, eventId: m.eventId, prefix: m.prefix, last: m.seq });
    }
    for (const c of top.values()) {
      const cur = await get('counters', c.id);
      if (!cur || (cur.last || 0) < c.last) put('counters', { ...(cur || c), last: c.last });
    }
  },
};

// hooks: see openToolStorage() (onBlocked, onClosed).
export function openNotfunkStorage(hooks) {
  return openToolStorage({
    name: 'oe1ebg-notfunk',
    version: 1,
    lsPrefix: 'oe1ebg-notfunk:v1:',
    stores: NOTFUNK_STORES,
    // Add a branch per version, never drop user data.
    upgrade(oldVersion, create) {
      if (oldVersion < 1) Object.keys(NOTFUNK_STORES).forEach(create);
    },
    // Moving localStorage fallback records into IndexedDB: a counter that
    // differs keeps the higher number (numbers are never handed out twice);
    // anything else that differs stays in the fallback and is reported.
    merge(store, current, incoming) {
      if (store !== 'counters') return undefined;
      return { ...current, last: Math.max(current.last || 0, incoming.last || 0) };
    },
    migration: NOTFUNK_MIGRATION,
  }, hooks);
}
