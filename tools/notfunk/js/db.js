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

export const NOTFUNK_STORES = {
  operations: { keyPath: 'id', byEvent: false },
  messages: { keyPath: 'id', byEvent: true },
  revisions: { keyPath: 'id', byEvent: true },
  counters: { keyPath: 'id', byEvent: true },
  drafts: { keyPath: 'eventId', byEvent: false },
  stations: { keyPath: 'id', byEvent: true },
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
  }, hooks);
}
