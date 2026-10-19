// Persistence of the shared callsign store (IndexedDB `oe1ebg-callsigns`),
// one database for Confirm, Notfunk and Netlog on the same origin, so its
// schema lives here and nowhere else. IndexedDB only: without it the
// callsign lists are unavailable (the tools work as before with the
// bundled Austrian list). Every write is one atomic transaction.
//
//   sources  { id, kind: 'builtin'|'polo'|'csv'|…, name, fileName, enabled,
//              rank, gen, prevGen, count, importedAt, updated, deleted }
//   records  { id, eventId: source id, source, gen, base, call, name, qth,
//              grid, note }
//   meta     reserved
//
// A source's records belong to generations. Re-importing a source writes a
// new generation and keeps the one before it, so the replacement can be
// undone; older generations are erased (the file can be imported again).
// Deleting a source hides it (soft delete); erasing it removes its records.
// Bump CALLSIGN_SCHEMA.version for a schema change and extend upgrade().
//
// Top-level names start with "callsign"/"CALLSIGN_": the single-file
// bundles share one scope with the tools' own modules.

import { openToolStorage } from './storage.js';
import { CALLSIGN_BUILTIN_ID } from './callsign-merge.js';

export const CALLSIGN_STORES = {
  sources: { keyPath: 'id' },
  records: { keyPath: 'id', byEvent: true },
  meta: { keyPath: 'id' },
};

export const CALLSIGN_SCHEMA = {
  name: 'oe1ebg-callsigns',
  version: 1,
  lsPrefix: 'oe1ebg-callsigns:v1:',
  stores: CALLSIGN_STORES,
  upgrade(oldVersion, create) {
    if (oldVersion < 1) Object.keys(CALLSIGN_STORES).forEach(create);
  },
};

export function openCallsignStorage(hooks = {}) {
  return openToolStorage(CALLSIGN_SCHEMA, { ...hooks, fallback: false });
}

const CALLSIGN_BUILTIN_RANK = 1000;
const callsignNow = () => new Date().toISOString();

function callsignNewId() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// The next rank after every user source and before the bundled list.
function callsignNextRank(sources) {
  const ranks = sources.filter(s => s.id !== CALLSIGN_BUILTIN_ID && !s.deleted).map(s => s.rank);
  return (ranks.length ? Math.max(...ranks) : 0) + 1;
}

// The bundled Austrian list as a source row (created once).
export async function ensureBuiltinSource(store, name) {
  return store.atomic(['sources'], async api => {
    const cur = await api.get('sources', CALLSIGN_BUILTIN_ID);
    if (cur) return cur;
    const row = { id: CALLSIGN_BUILTIN_ID, kind: 'builtin', name, fileName: '', enabled: true, rank: CALLSIGN_BUILTIN_RANK, gen: 1, prevGen: null, count: 0, importedAt: null, updated: callsignNow(), deleted: false };
    api.put('sources', row);
    return row;
  });
}

export async function loadCallsignStore(store) {
  const [sources, records] = await Promise.all([store.getAll('sources'), store.getAll('records')]);
  return { sources, records };
}

function callsignRecordRows(sourceId, gen, rows) {
  return rows.map((r, i) => ({
    id: `${sourceId}:${gen}:${i}`,
    eventId: sourceId,
    source: sourceId,
    gen,
    base: r.base,
    call: r.call,
    name: r.name || '',
    qth: r.qth || '',
    grid: r.grid || '',
    note: r.note || '',
  }));
}

// Imports rows ({ call, base, name?, qth?, grid?, note? }) as a new
// source, or, with replaceId, as the new generation of that source.
// Resolves to the source row.
export async function importCallsignSource(store, { kind, name, fileName = '', rows, replaceId = null }) {
  return store.atomic(['sources', 'records'], async api => {
    const stamp = callsignNow();
    if (replaceId) {
      const src = await api.get('sources', replaceId);
      if (!src || src.deleted) throw new Error('Quelle nicht gefunden');
      const gen = src.gen + 1;
      for (const r of await api.getByEvent('records', replaceId)) {
        if (r.gen < src.gen) api.del('records', r.id);
      }
      for (const r of callsignRecordRows(replaceId, gen, rows)) api.put('records', r);
      const next = { ...src, name: name || src.name, fileName, gen, prevGen: src.gen, count: rows.length, importedAt: stamp, updated: stamp };
      api.put('sources', next);
      return next;
    }
    const sources = await api.getAll('sources');
    const id = callsignNewId();
    for (const r of callsignRecordRows(id, 1, rows)) api.put('records', r);
    const row = { id, kind, name, fileName, enabled: true, rank: callsignNextRank(sources), gen: 1, prevGen: null, count: rows.length, importedAt: stamp, updated: stamp, deleted: false };
    api.put('sources', row);
    return row;
  });
}

// Back to the generation before the last re-import (and again forward):
// swaps gen and prevGen. Resolves to the source row, or null when none.
export async function swapCallsignGeneration(store, id) {
  return store.atomic(['sources', 'records'], async api => {
    const src = await api.get('sources', id);
    if (!src || src.prevGen == null) return null;
    const recs = (await api.getByEvent('records', id)).filter(r => r.gen === src.prevGen);
    const next = { ...src, gen: src.prevGen, prevGen: src.gen, count: recs.length, updated: callsignNow() };
    api.put('sources', next);
    return next;
  });
}

async function callsignPatchSource(store, id, patch) {
  return store.atomic(['sources'], async api => {
    const src = await api.get('sources', id);
    if (!src) return null;
    const next = { ...src, ...patch, updated: callsignNow() };
    api.put('sources', next);
    return next;
  });
}

export const setCallsignSourceEnabled = (store, id, enabled) => callsignPatchSource(store, id, { enabled: !!enabled });
// Soft delete: hidden everywhere, records kept until erased.
export const deleteCallsignSource = (store, id) => callsignPatchSource(store, id, { deleted: true });
export const restoreCallsignSource = (store, id) => callsignPatchSource(store, id, { deleted: false });

// Moves a source one place up (-1) or down (+1) among the visible ones.
export async function moveCallsignSource(store, id, delta) {
  return store.atomic(['sources'], async api => {
    const all = (await api.getAll('sources')).filter(s => !s.deleted).sort((a, b) => a.rank - b.rank);
    const i = all.findIndex(s => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= all.length) return false;
    [all[i], all[j]] = [all[j], all[i]];
    const stamp = callsignNow();
    all.forEach((s, k) => api.put('sources', { ...s, rank: k + 1, updated: stamp }));
    return true;
  });
}

// Permanent: the source and every generation of its records.
export async function eraseCallsignSource(store, id) {
  return store.atomic(['sources', 'records'], async api => {
    if (id === CALLSIGN_BUILTIN_ID) throw new Error('Die eingebaute Liste kann nicht gelöscht werden');
    for (const r of await api.getByEvent('records', id)) api.del('records', r.id);
    api.del('sources', id);
  });
}
