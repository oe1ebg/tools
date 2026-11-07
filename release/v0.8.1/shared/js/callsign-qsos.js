// QSOs imported from a logbook (Wavelog, issue #82) for the shared callsign
// store: the mapping of one QSO and the per-callsign summary that the
// merged lookup reads as an ordinary source (kind 'wavelog'). Pure, no DOM,
// no storage. A QSO is not a check-in: nothing here is written back.
//
// Top-level names start with "callsign"/"CALLSIGN_": the single-file
// bundles share one scope with the tools' own modules.

import { baseCall, normalizeCall } from './callbook.js';

// One QSO of GET /api/v2/qso (JSON) -> the stored record, or null without
// a usable id/callsign. date is the ISO date (UTC), time HH:MM:SS.
export function callsignQsoFromWavelog(q, sourceId) {
  if (!q || q.id == null) return null;
  const call = normalizeCall(q.call);
  const base = baseCall(call);
  if (!base) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/.exec(String(q.qso_date || ''));
  const text = v => (v == null ? '' : String(v).trim());
  return {
    id: `${sourceId}:${q.id}`,
    eventId: sourceId,
    source: sourceId,
    wlId: Number(q.id),
    call,
    base,
    date: m ? m[1] : '',
    time: m && m[2] ? (m[2].length === 5 ? `${m[2]}:00` : m[2]) : '',
    band: text(q.band),
    mode: text(q.submode) || text(q.mode),
    name: text(q.name),
    qth: text(q.qth),
    grid: text(q.gridsquare).toUpperCase(),
  };
}

// Per callsign: name/QTH/grid of the most recent QSO that has one, and a
// language-neutral note "<n> QSO, <last date>". Rows for importCallsignSource().
export function summarizeCallsignQsos(qsos) {
  const byBase = new Map();
  for (const q of qsos) {
    let e = byBase.get(q.base);
    if (!e) byBase.set(q.base, e = { call: q.base, base: q.base, n: 0, last: '', name: '', qth: '', grid: '', stamp: { name: '', qth: '', grid: '' } });
    e.n++;
    const when = `${q.date} ${q.time}`;
    if (when > `${e.last}`) e.last = when;
    for (const f of ['name', 'qth', 'grid']) {
      if (q[f] && when >= e.stamp[f]) { e[f] = q[f]; e.stamp[f] = when; }
    }
  }
  return [...byBase.values()].sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0))
    .map(e => ({ call: e.call, base: e.base, name: e.name, qth: e.qth, grid: e.grid, note: `${e.n} QSO, ${e.last.slice(0, 10)}` }));
}
