// Persistent storage for the confirmation log: its schema for the shared
// storage layer (tools/shared/js/storage.js — IndexedDB, localStorage
// fallback, same API).
//
// Stores: events, entries, revisions (old versions of edited lines),
// drafts (keyed by eventId: the half-typed line), snapshots (periodic full
// backups of an event), stations (v2; keyed by callsign: last known
// location of a station across events). Nothing user-entered is ever hard-deleted: lines and
// events are soft-deleted via a `deleted` timestamp; only drafts and
// rotated-out snapshots are actually removed.

import { openToolStorage } from '../../shared/js/storage.js';

const DB_NAME = 'oe1ebg-confirm';
const DB_VERSION = 2;
const LS_PREFIX = 'oe1ebg-confirm:v1:';

export const STORES = {
  events: { keyPath: 'id', byEvent: false },
  entries: { keyPath: 'id', byEvent: true },
  revisions: { keyPath: 'id', byEvent: true },
  drafts: { keyPath: 'eventId', byEvent: false },
  snapshots: { keyPath: 'id', byEvent: true },
  stations: { keyPath: 'call', byEvent: false },
};
const V1_STORES = ['events', 'entries', 'revisions', 'drafts', 'snapshots'];

// hooks: see openToolStorage() (onBlocked, onClosed).
// Moving localStorage fallback records into IndexedDB (migrateFallback()):
// a line whose number (event + seq) is taken by another line stays in the
// fallback and is reported, never renumbered; so does whatever belongs to
// a record that isn't there (revision -> line, line/snapshot/draft ->
// event). An event's nextSeq ends above every migrated line.
const evParent = [{ store: 'events', key: r => r.eventId }];
export const CONFIRM_MIGRATION = {
  unique: { entries: r => (r.eventId != null && r.seq != null ? `${r.eventId}:${r.seq}` : null) },
  parents: {
    entries: evParent,
    snapshots: evParent,
    drafts: evParent,
    revisions: [{ store: 'entries', key: r => r.entryId }],
  },
  async fixup({ get, put }, migrated) {
    const top = new Map();
    for (const { store, value: e } of migrated) {
      if (store === 'entries' && e.seq > 0 && !(top.get(e.eventId) >= e.seq)) top.set(e.eventId, e.seq);
    }
    for (const [id, seq] of top) {
      const ev = await get('events', id);
      if (ev && (ev.nextSeq || 1) <= seq) put('events', { ...ev, nextSeq: seq + 1, updated: new Date().toISOString() });
    }
  },
};

export function openStorage(hooks) {
  return openToolStorage({
    name: DB_NAME,
    version: DB_VERSION,
    lsPrefix: LS_PREFIX,
    stores: STORES,
    // Add a branch per version, never drop user data.
    upgrade(oldVersion, create) {
      if (oldVersion < 1) V1_STORES.forEach(create);
      if (oldVersion < 2) create('stations');
    },
    migration: CONFIRM_MIGRATION,
  }, hooks);
}
