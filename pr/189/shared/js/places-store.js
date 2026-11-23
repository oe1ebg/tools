// Persistence of the user's named places (issue #181): IndexedDB
// `oe1ebg-places`, one database for every tool on the same origin, so its
// schema lives here and nowhere else. IndexedDB only (no localStorage
// fallback): without it there are no own places, the address lookup works
// as before. Every write is one atomic transaction.
//
//   lists   { id, name, fileName, gen, prevGen, count, importedAt, updated,
//             deleted }
//   places  { id, eventId: list id, list, gen, name, type, address, lat,
//             lon, aliases: [] }
//   meta    reserved
//
// Like the callsign lists (callsign-store.js): re-importing a list writes a
// new generation and keeps the one before, so the replacement can be
// undone (swap); older generations are erased (the file can be imported
// again). Deleting a list hides it (soft delete, restorable); erasing
// removes it and its places. Bump PLACES_SCHEMA.version for a schema
// change and extend upgrade(); never rename the database.
//
// Top-level names start with "places"/"PLACES_" (single-file bundles).

import { openToolStorage } from './storage.js';
import { PLACES_MAX_TOTAL } from './places.js';

export const PLACES_STORES = {
  lists: { keyPath: 'id' },
  places: { keyPath: 'id', byEvent: true },
  meta: { keyPath: 'id' },
};

export const PLACES_SCHEMA = {
  name: 'oe1ebg-places',
  version: 1,
  lsPrefix: 'oe1ebg-places:v1:',
  stores: PLACES_STORES,
  upgrade(oldVersion, create) {
    if (oldVersion < 1) ['lists', 'places', 'meta'].forEach(create);
  },
};

export function openPlacesStorage(hooks = {}) {
  return openToolStorage(PLACES_SCHEMA, { ...hooks, fallback: false });
}

const placesNow = () => new Date().toISOString();

function placesNewId() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function loadPlacesStore(store) {
  const [lists, places] = await Promise.all([store.getAll('lists'), store.getAll('places')]);
  return { lists, places };
}

// The places a lookup uses: the current generation of every list that is
// not deleted, with the list's name; lists in import order.
export function placesActive(lists, places) {
  const live = new Map(lists.filter(l => !l.deleted).map(l => [l.id, l]));
  const order = [...live.values()].sort((a, b) => String(a.importedAt).localeCompare(String(b.importedAt)) || a.id.localeCompare(b.id));
  const rank = new Map(order.map((l, i) => [l.id, i]));
  return places
    .filter(p => live.has(p.list) && p.gen === live.get(p.list).gen)
    .map(p => ({ ...p, listName: live.get(p.list).name }))
    .sort((a, b) => rank.get(a.list) - rank.get(b.list) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

export class PlacesLimitError extends Error {
  constructor(total) {
    super(`Zu viele Orte: zusammen höchstens ${PLACES_MAX_TOTAL.toLocaleString('de-AT')} in allen Listen (es wären ${total.toLocaleString('de-AT')})`);
    this.name = 'PlacesLimitError';
    this.total = total;
  }
}

// Imports rows ({ name, type, address, lat, lon, aliases }) as a new list,
// or, with replaceId, as the new generation of that list. Refused (nothing
// written) when all lists together would hold more than PLACES_MAX_TOTAL
// places. Resolves to the list row.
export async function importPlacesList(store, { name, fileName = '', rows, replaceId = null }) {
  return store.atomic(['lists', 'places'], async api => {
    const lists = await api.getAll('lists');
    const others = lists.filter(l => !l.deleted && l.id !== replaceId).reduce((n, l) => n + (l.count || 0), 0);
    if (others + rows.length > PLACES_MAX_TOTAL) throw new PlacesLimitError(others + rows.length);
    const stamp = placesNow();
    let row;
    if (replaceId) {
      const cur = lists.find(l => l.id === replaceId);
      if (!cur || cur.deleted) throw new Error('Liste nicht gefunden');
      // keep the current version for "Rückgängig"; any other is erased
      // (after an undo the newer one is the other: a new number for this)
      for (const p of await api.getByEvent('places', replaceId)) if (p.gen !== cur.gen) api.del('places', p.id);
      const gen = Math.max(cur.gen, cur.prevGen ?? 0) + 1;
      row = { ...cur, name: name || cur.name, fileName, gen, prevGen: cur.gen, count: rows.length, importedAt: stamp, updated: stamp };
    } else {
      row = { id: placesNewId(), name, fileName, gen: 1, prevGen: null, count: rows.length, importedAt: stamp, updated: stamp, deleted: false };
    }
    rows.forEach((r, i) => api.put('places', {
      id: `${row.id}:${row.gen}:${i}`, eventId: row.id, list: row.id, gen: row.gen,
      name: r.name, type: r.type || '', address: r.address || '', lat: r.lat, lon: r.lon, aliases: r.aliases || [],
    }));
    api.put('lists', row);
    return row;
  });
}

// Back to the version before the last replacement (and forward again).
export async function swapPlacesGeneration(store, id) {
  return store.atomic(['lists', 'places'], async api => {
    const cur = await api.get('lists', id);
    if (!cur || cur.prevGen == null) return null;
    const count = (await api.getByEvent('places', id)).filter(p => p.gen === cur.prevGen).length;
    const next = { ...cur, gen: cur.prevGen, prevGen: cur.gen, count, updated: placesNow() };
    api.put('lists', next);
    return next;
  });
}

async function placesPatchList(store, id, patch) {
  return store.atomic(['lists'], async api => {
    const cur = await api.get('lists', id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updated: placesNow() };
    api.put('lists', next);
    return next;
  });
}

// Soft delete: hidden everywhere, the places kept until erased.
export const deletePlacesList = (store, id) => placesPatchList(store, id, { deleted: true });
// Restoring is refused like an import when it would pass PLACES_MAX_TOTAL.
export async function restorePlacesList(store, id) {
  return store.atomic(['lists'], async api => {
    const lists = await api.getAll('lists');
    const cur = lists.find(l => l.id === id);
    if (!cur) return null;
    const total = lists.filter(l => !l.deleted || l.id === id).reduce((n, l) => n + (l.count || 0), 0);
    if (total > PLACES_MAX_TOTAL) throw new PlacesLimitError(total);
    const next = { ...cur, deleted: false, updated: placesNow() };
    api.put('lists', next);
    return next;
  });
}

// Permanent: the list and every generation of its places.
export async function erasePlacesList(store, id) {
  return store.atomic(['lists', 'places'], async api => {
    for (const p of await api.getByEvent('places', id)) api.del('places', p.id);
    api.del('lists', id);
  });
}
