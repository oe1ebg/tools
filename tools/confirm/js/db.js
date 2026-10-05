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

export function openStorage() {
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
  });
}
