// The merged view of the shared callsign store: several sources side by
// side (the bundled Austrian list, uploaded lists, Hams-of-Note style
// notes), each source's records kept apart, combined only when looking
// one up. Pure, no DOM, no storage. See callsign-store.js for persistence.
//
// Order: the sources by `rank` (ascending); per field (name, qth, grid) the
// first non-empty value of an enabled source wins and the answer says which
// source it came from. Notes are not merged: every note of every enabled
// source is listed. The bundled Austrian list is a source of kind
// 'builtin' (rank like the others, can be switched off).
//
// Top-level names start with "callsign"/"CALLSIGN_": the single-file
// bundles share one scope with the tools' own modules.

import { baseCall } from './callbook.js';

export const CALLSIGN_BUILTIN_ID = 'builtin:oe-callbook';

// Sources that count: not deleted, enabled; by rank, then name.
export function callsignActiveSources(sources) {
  return sources
    .filter(s => !s.deleted && s.enabled !== false)
    .sort((a, b) => (a.rank - b.rank) || String(a.name).localeCompare(String(b.name), 'de'));
}

function callsignFold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
}

// sources: source rows; records: rows { source, gen, base, call, name, qth,
// grid, note } (only those of the source's current generation count);
// callbook: the bundled Austrian list (buildCallbook()) or null.
export function buildCallsignDirectory({ sources = [], records = [], callbook = null } = {}) {
  const active = callsignActiveSources(sources);
  const rank = new Map(active.map((s, i) => [s.id, i]));
  const byId = new Map(active.map(s => [s.id, s]));
  const byBase = new Map();
  const put = (base, entry) => {
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(entry);
  };
  for (const r of records) {
    const src = byId.get(r.source);
    if (!src || r.gen !== src.gen) continue;
    put(r.base, { sourceId: src.id, source: src.name, kind: src.kind, call: r.call, name: r.name || '', qth: r.qth || '', grid: r.grid || '', note: r.note || '' });
  }
  const builtin = byId.get(CALLSIGN_BUILTIN_ID);

  function entriesFor(base) {
    const list = (byBase.get(base) || []).slice();
    if (builtin && callbook) {
      const c = callbook.byCall.get(base);
      if (c) list.push({ sourceId: builtin.id, source: builtin.name, kind: 'builtin', call: c[0], name: c[1] || '', qth: c[2] || '', grid: '', note: '' });
    }
    // stable: by source rank, then import order
    return list.map((e, i) => [e, i]).sort((a, b) => (rank.get(a[0].sourceId) - rank.get(b[0].sourceId)) || (a[1] - b[1])).map(x => x[0]);
  }

  function merge(base, entries) {
    const out = { base, listed: true, name: '', qth: '', grid: '', from: {}, notes: [], entries };
    for (const f of ['name', 'qth', 'grid']) {
      const e = entries.find(x => x[f]);
      if (e) { out[f] = e[f]; out.from[f] = e.source; }
    }
    for (const e of entries) if (e.note) out.notes.push({ text: e.note, source: e.source });
    return out;
  }

  return {
    sources: active,
    // The merged answer for a callsign (portable parts ignored), or null.
    lookup(call) {
      const base = baseCall(call);
      const entries = base ? entriesFor(base) : [];
      return entries.length ? merge(base, entries) : null;
    },
    // Every callsign of an enabled source, sorted.
    callsigns() {
      const all = new Set(byBase.keys());
      if (builtin && callbook) for (const c of callbook.calls) all.add(c[0]);
      return [...all].sort();
    },
    // Callsigns starting with the text, or whose name/QTH contain it
    // (3+ letters): [{ call, name, qth, from }] by callsign, at most max.
    search(text, max = 8) {
      const q = String(text || '').trim();
      if (!q) return [];
      const up = q.toUpperCase().replace(/\s+/g, '');
      const needle = callsignFold(q);
      const bases = new Set();
      const matches = [];
      const consider = base => {
        if (bases.has(base)) return;
        bases.add(base);
        const m = merge(base, entriesFor(base));
        matches.push({ call: base, name: m.name, qth: m.qth, from: m.from.name || m.from.qth || '' });
      };
      const calls = new Set(byBase.keys());
      if (builtin && callbook) for (const c of callbook.calls) calls.add(c[0]);
      if (/^[A-Z0-9/]+$/.test(up)) for (const b of calls) if (b.startsWith(up)) consider(b);
      if (needle.length >= 3 && /[a-z]/.test(needle)) {
        for (const [base, list] of byBase) {
          if (list.some(e => callsignFold(e.name).includes(needle) || callsignFold(e.qth).includes(needle))) consider(base);
        }
        if (builtin && callbook) {
          for (const c of callbook.calls) if (callsignFold(c[1]).includes(needle) || callsignFold(c[2]).includes(needle)) consider(c[0]);
        }
      }
      return matches.sort((a, b) => (a.call < b.call ? -1 : a.call > b.call ? 1 : 0)).slice(0, max);
    },
  };
}
