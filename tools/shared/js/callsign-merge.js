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

import { baseCall, withinOneEdit } from './callbook.js';

export const CALLSIGN_BUILTIN_ID = 'builtin:oe-callbook';

// THE order of the lists, used by the dialog and by the lookup alike: by
// rank, a tie (which the store avoids, but old or restored data may have)
// by id, so both always agree. The first list wins.
export function callsignSourceOrder(a, b) {
  return (a.rank - b.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Sources that count: not deleted, enabled; in that order.
export function callsignActiveSources(sources) {
  return sources
    .filter(s => !s.deleted && s.enabled !== false)
    .sort(callsignSourceOrder);
}

// A note as plain text for display: the simplified GitHub markdown of PoLo
// notes (links, images, bold, italic, inline code) without its syntax.
// Stored notes stay verbatim. Emphasis marks are only taken at word edges,
// so snake_case or 2*3 stay as they are.
export function callsignNoteText(note) {
  const s = String(note ?? '')
    .replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|[^\w*])(\*\*|__)(\S(?:.*?\S)?)\2(?![\w*])/g, '$1$3')
    .replace(/(^|[^\w*])([*_])(\S(?:.*?\S)?)\2(?![\w*])/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim();
  return s || String(note ?? '').trim();
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
    for (const e of entries) if (e.note) out.notes.push({ text: callsignNoteText(e.note), raw: e.note, source: e.source });
    return out;
  }

  // All callsigns of the enabled sources, sorted; and OE calls by suffix.
  let callsCache = null;
  let suffixCache = null;
  function allCalls() {
    if (!callsCache) {
      const all = new Set(byBase.keys());
      if (builtin && callbook) for (const c of callbook.calls) all.add(c[0]);
      callsCache = [...all].sort();
    }
    return callsCache;
  }
  function suffixes() {
    if (!suffixCache) {
      suffixCache = new Map();
      for (const c of allCalls()) {
        const m = /^OE\d([A-Z0-9]+)$/.exec(c);
        if (!m) continue;
        if (!suffixCache.has(m[1])) suffixCache.set(m[1], []);
        suffixCache.get(m[1]).push(c);
      }
    }
    return suffixCache;
  }
  const has = base => byBase.has(base) || !!(builtin && callbook && callbook.byCall.has(base));
  function lowerBound(list, key) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < key) lo = mid + 1; else hi = mid;
    }
    return lo;
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
    callsigns: allCalls,
    // The search of the callsign field, over every list that is switched
    // on: [{ call, name, qth, from }], best first, at most max. A partial
    // callsign with ? or * ("OE0QX?", "?QXB": each run stands for one or
    // more characters) gives the callsigns it fits; otherwise, in this
    // order: the exact callsign, callsigns starting with the input, short
    // forms ("ABC", "1ABC" for OE1ABC…), one-edit typos, then names, places
    // and notes containing the input (3+ letters). Needs 2+ characters.
    search(text, max = 8) {
      const q = String(text || '').trim();
      if (q.length < 2) return [];
      const up = q.toUpperCase().replace(/\s+/g, '');
      const out = [];
      const seen = new Set();
      const add = base => {
        if (!base || seen.has(base) || out.length >= max) return;
        seen.add(base);
        const m = merge(base, entriesFor(base));
        out.push({ call: base, name: m.name, qth: m.qth, from: m.from.name || m.from.qth || '' });
      };
      const calls = allCalls();
      if (/^[A-Z0-9/?*]+$/.test(up) && /[?*]/.test(up)) {
        const src = baseCall(up).split(/[?*]+/).map(s => s.replace(/[^A-Z0-9]/g, '')).join('[A-Z0-9]+');
        const re = new RegExp(`^${src}$`);
        for (const c of calls) { if (re.test(c)) add(c); if (out.length >= max) break; }
        return out;
      }
      if (/^[A-Z0-9/]+$/.test(up)) {
        const call = baseCall(up);
        if (calls.length && has(call)) add(call);
        for (let i = lowerBound(calls, call); i < calls.length && calls[i].startsWith(call); i++) add(calls[i]);
        const short = /^(\d)?([A-Z][A-Z0-9]{0,4})$/.exec(call);
        if (short && !call.startsWith('OE')) {
          const [, digit, suffix] = short;
          if (digit && has(`OE${call}`)) add(`OE${call}`);
          for (const c of suffixes().get(suffix) || []) add(c);
          if (suffix.length >= 2) {
            const wanted = digit ? `OE${call}` : null;
            for (let i = wanted ? lowerBound(calls, wanted) : 0; i < calls.length && out.length < max; i++) {
              const c = calls[i];
              if (wanted && !c.startsWith(wanted)) break;
              const m = /^OE\d(.*)$/.exec(c);
              if (m && m[1].startsWith(suffix)) add(c);
            }
          }
        }
        for (const c of calls) {
          if (out.length >= max) break;
          if (Math.abs(c.length - call.length) <= 1 && withinOneEdit(call, c)) add(c);
        }
      }
      const needle = callsignFold(q);
      if (needle.length >= 3 && /[a-z]/.test(needle)) {
        for (const [base, list] of byBase) {
          if (out.length >= max) break;
          if (list.some(e => callsignFold(e.name).includes(needle) || callsignFold(e.qth).includes(needle) || callsignFold(callsignNoteText(e.note)).includes(needle))) add(base);
        }
        if (builtin && callbook) {
          for (const c of callbook.calls) {
            if (out.length >= max) break;
            if (callsignFold(c[1]).includes(needle) || callsignFold(c[2]).includes(needle)) add(c[0]);
          }
        }
      }
      return out;
    },
  };
}
