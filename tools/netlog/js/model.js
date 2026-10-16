// Netlog data model: pure functions over plain records (no DOM, no
// storage), node-tested. Records reference each other by stable ids only,
// never by callsign, text or list position. The stores and the fields of
// every record are documented in ../README.md, "Data model".

// Participation states and independent flags of a session participant.
export const STATUSES = ['active', 'paused', 'listening', 'unconfirmed', 'out'];
export const FLAGS = ['speak', 'short', 'reception', 'priority'];
// How sure a time is: typed or taken from the clock, estimated afterwards,
// or not known at all (then `iso` is null).
export const QUALITIES = ['exact', 'estimated', 'unknown'];

export const live = rec => !!rec && !rec.deleted;
export const liveOf = list => list.filter(live);

// Stable display order: explicit order, then creation, then id.
export function byOrder(a, b) {
  return (a.order ?? 0) - (b.order ?? 0) || cmp(a.created, b.created) || cmp(a.id, b.id);
}
export function cmp(a, b) {
  const x = a ?? '', y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

// A time with its quality. An unknown time has no iso; nothing invents
// precision that was not entered.
export function timeOf(iso, quality = 'exact') {
  if (!iso) return { iso: null, quality: 'unknown' };
  return { iso, quality: QUALITIES.includes(quality) && quality !== 'unknown' ? quality : 'exact' };
}

// ---------- callsigns ----------

// What the user typed, as stored: upper case, no blanks. Suffixes (/P, /M,
// /AM) and placeholders (?, *) are kept.
export function normCall(text) {
  return String(text ?? '').toUpperCase().replace(/\s+/g, '');
}

// The identity used for matching: the part of a "prefix/call/suffix" that
// looks like a callsign (letters and a digit, the longest such part),
// placeholders kept. "OE/DL0QXA/P" -> "DL0QXA".
export function baseCall(call) {
  const c = normCall(call);
  const parts = c.split('/').filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  const callish = parts.filter(p => /[A-Z?*]/.test(p) && /[0-9?*]/.test(p));
  const pool = callish.length ? callish : parts;
  return pool.reduce((best, p) => (p.length > best.length ? p : best), '');
}

// An identity still to be resolved: empty, or with a placeholder.
export function isUnresolved(call) {
  const c = normCall(call);
  return !c || /[?*]/.test(c);
}

// "OE0QX?" / "?QXB" / "?" as a pattern over base callsigns: each run of
// placeholders stands for one or more unknown characters. A complete call
// matches only itself. null for an empty call.
export function callPattern(call) {
  const b = baseCall(call);
  if (!b) return null;
  const src = b.split(/[?*]+/).map(s => s.replace(/[^A-Z0-9]/g, '')).join('[A-Z0-9]+');
  return new RegExp(`^${src}$`);
}

// Local identities (profiles or participants of other sessions) that fit
// a partial or complete callsign, best first: never merged by
// themselves, only suggested. `pool` items need `call`.
export function callCandidates(call, pool, limit = 8) {
  const re = callPattern(call);
  if (!re) return [];
  const seen = new Set();
  const out = [];
  for (const p of pool) {
    const b = baseCall(p.call);
    if (!b || isUnresolved(b) || !re.test(b)) continue;
    const key = `${b}|${p.name || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- series and sessions ----------

// The number a new session of a series would get: one above the highest
// number given so far (missed scheduled dates are never counted); 1 for
// the first. Only a suggestion, the field stays editable.
export function nextSessionNumber(sessions, seriesId) {
  let max = 0;
  for (const s of sessions) {
    if (!live(s) || s.seriesId !== seriesId) continue;
    const n = Number(s.number);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

// A session's defaults copied from its series at creation: later series
// edits never rewrite them.
export function seriesDefaults(series) {
  const d = (series && series.defaults) || {};
  return {
    radio: { repeater: d.repeater || '', freq: d.freq || '', mode: d.mode || '' },
    suggestedNcs: d.ncs || '',
  };
}

// "Evening net #437" / "Evening net" / the session's own name.
export function sessionLabel(session, series) {
  const name = session.name || (series ? series.name : '');
  const num = session.number != null && session.number !== '' ? `#${session.number}` : '';
  return [name, num].filter(Boolean).join(' ');
}

// Sessions of a series (or ad-hoc ones, seriesId null), newest first.
export function sessionsOf(sessions, seriesId) {
  return liveOf(sessions)
    .filter(s => (s.seriesId || null) === (seriesId || null))
    .sort((a, b) => cmp(b.date, a.date) || (Number(b.number) || 0) - (Number(a.number) || 0) || cmp(b.created, a.created));
}

// ---------- participants ----------

export function rosterSorted(participants) {
  return liveOf(participants).sort((a, b) => (a.rosterOrder ?? 0) - (b.rosterOrder ?? 0) || cmp(a.created, b.created) || cmp(a.id, b.id));
}

// The order value for a participant added at the end.
export function nextOrder(list, field = 'order') {
  let max = 0;
  for (const r of list) if (live(r) && Number.isFinite(r[field]) && r[field] > max) max = r[field];
  return max + 1;
}

// Swap a record with its neighbour in `sorted` (dir -1 up, +1 down):
// returns [{ id, order }] changes, or [] at an end. Only the given field
// changes (roster or planned order); speaking history stays as it was.
export function moveInOrder(sorted, id, dir, field = 'order') {
  const i = sorted.findIndex(r => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sorted.length) return [];
  // renumber 1..n first, so equal or missing values swap cleanly
  const order = sorted.map((r, k) => ({ id: r.id, order: k + 1 }));
  [order[i].order, order[j].order] = [order[j].order, order[i].order];
  return order.filter((o, k) => sorted[k][field] !== o.order);
}

export function rosterStats(participants) {
  const list = liveOf(participants);
  return {
    total: list.length,
    active: list.filter(p => p.status === 'active').length,
    unresolved: list.filter(p => isUnresolved(p.call)).length,
  };
}

// A status change with its presence bookkeeping. Checking out closes the
// open presence interval; coming back from "checked out" opens a new one
// (a reentry); pause/listening keep the interval open (temporarily away).
// Returns { participant, event } (event: what the session's event log
// records), or null when nothing changes.
export function changeStatus(p, status, at) {
  if (!STATUSES.includes(status) || p.status === status) return null;
  const presence = (p.presence || []).map(iv => ({ ...iv }));
  const open = presence.length && !presence[presence.length - 1].to;
  if (status === 'out' && open) presence[presence.length - 1].to = timeOf(at);
  if (p.status === 'out' && status !== 'out') presence.push({ from: timeOf(at), to: null });
  if (!presence.length && status !== 'out') presence.push({ from: timeOf(at), to: null });
  return {
    participant: { ...p, status, presence },
    event: { type: 'status', participantId: p.id, from: p.status, to: status, time: timeOf(at) },
  };
}

export function presenceOpen(p) {
  const iv = p.presence || [];
  return iv.length > 0 && !iv[iv.length - 1].to;
}
