// Netlog storage schema (IndexedDB `oe1ebg-netlog`) on the shared
// ../../shared/js/storage.js. IndexedDB only: without it Netlog says that
// nothing is stored durably (no localStorage fallback, which could not
// keep two tabs apart without Web Locks). Session-owned records carry
// `eventId` = their session's id for the shared `eventId` index.
// Bump NETLOG_SCHEMA.version for a schema change and extend upgrade();
// keep older stores and migration branches (../README.md, "Storage").

import { openToolStorage } from '../../shared/js/storage.js';

export const NETLOG_STORES = {
  series: { keyPath: 'id' },
  sessions: { keyPath: 'id' },
  profiles: { keyPath: 'id' },
  meta: { keyPath: 'id' },
  participants: { keyPath: 'id', byEvent: true },
  rounds: { keyPath: 'id', byEvent: true },
  contributions: { keyPath: 'id', byEvent: true },
  notes: { keyPath: 'id', byEvent: true },
  items: { keyPath: 'id', byEvent: true },
  events: { keyPath: 'id', byEvent: true },
  turns: { keyPath: 'id', byEvent: true },
  revisions: { keyPath: 'id', byEvent: true },
  undo: { keyPath: 'id', byEvent: true },
  drafts: { keyPath: 'id', byEvent: true },
};

// Stores whose records belong to one session (eventId).
export const SESSION_STORES = Object.keys(NETLOG_STORES).filter(s => NETLOG_STORES[s].byEvent);

export const NETLOG_SCHEMA = {
  name: 'oe1ebg-netlog',
  version: 1,
  // unused (no fallback), but part of the storage contract
  lsPrefix: 'oe1ebg-netlog:v1:',
  stores: NETLOG_STORES,
  upgrade(oldVersion, create) {
    if (oldVersion < 1) Object.keys(NETLOG_STORES).forEach(create);
  },
};

// hooks: those of openToolStorage() (onBlocked, onClosed, onUnavailable,
// openTimeout). Resolves to the IndexedDB backend or null.
export function openNetlogStorage(hooks = {}) {
  return openToolStorage(NETLOG_SCHEMA, { ...hooks, fallback: false });
}
