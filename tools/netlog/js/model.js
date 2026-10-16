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

// ---------- rounds ----------

// Rounds in session order (explicit order, then number).
export function roundsSorted(rounds) {
  return liveOf(rounds).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.number ?? 0) - (b.number ?? 0) || cmp(a.created, b.created));
}

// The immediately preceding round in session order (also an empty one),
// or null in the first logged round: nothing earlier is made up.
export function previousRound(rounds, roundId) {
  const list = roundsSorted(rounds);
  const i = list.findIndex(r => r.id === roundId);
  return i > 0 ? list[i - 1] : null;
}

export function nextRoundNumber(rounds) {
  let max = 0;
  for (const r of liveOf(rounds)) if (Number.isFinite(r.number) && r.number > max) max = r.number;
  return max + 1;
}

// ---------- chronology ----------

// Notes and contributions share one sequence per session: the stable
// chronological tie-breaker (equal or missing times), never changed by an
// edit. Deleted records keep their number.
export function nextSeq(...lists) {
  let max = 0;
  for (const list of lists) for (const r of list || []) if (Number.isFinite(r.seq) && r.seq > max) max = r.seq;
  return max + 1;
}

export const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0) || cmp(a.created, b.created) || cmp(a.id, b.id);

// A participant's notes in a round, in recorded order.
export function notesOf(notes, participantId, roundId) {
  return liveOf(notes).filter(n => n.participantId === participantId && n.roundId === roundId).sort(bySeq);
}

// The contribution a new note belongs to: the participant's latest one
// in that round, or none (a note never needs a recorded speaking turn).
export function latestContribution(contributions, participantId, roundId) {
  return liveOf(contributions).filter(c => c.participantId === participantId && c.roundId === roundId).sort(bySeq).pop() || null;
}

// ---------- responses, points, tasks ----------

export const QUEUE_KINDS = ['response', 'point'];

// The response item of a note (the active one, else the last one), or null.
export function responseOf(items, noteId, kind = 'response') {
  const list = liveOf(items).filter(i => i.kind === kind && i.noteId === noteId);
  return list.find(i => i.active !== false) || list.sort((a, b) => cmp(a.updated, b.updated)).pop() || null;
}

// In the My Turn checklist: open responses and talking points of the
// session (whatever round they came from), plus those completed during
// the open turn (shown subdued until End Turn). A response whose note was
// deleted is not listed (the item stays, restorable with the note).
export function inQueue(item, notesById, turnId) {
  if (!live(item) || !QUEUE_KINDS.includes(item.kind) || item.active === false) return false;
  if (item.kind === 'response' && !live(notesById.get(item.noteId))) return false;
  return item.state !== 'done' || (!!turnId && item.doneTurnId === turnId);
}

export function queueItems(items, notes, turnId) {
  const byId = new Map(notes.map(n => [n.id, n]));
  return items.filter(i => inQueue(i, byId, turnId)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || cmp(a.created, b.created) || cmp(a.id, b.id));
}

export function openQueueCount(items, notes) {
  const byId = new Map(notes.map(n => [n.id, n]));
  return items.filter(i => inQueue(i, byId, null)).length;
}

// Per round: { notes, open } (open = outstanding on-air responses), for
// one participant (or all with participantId null).
export function roundCounts(notes, items, participantId = null) {
  const out = new Map();
  const byId = new Map();
  for (const n of liveOf(notes)) {
    if (participantId && n.participantId !== participantId) continue;
    byId.set(n.id, n);
    const c = out.get(n.roundId) || { notes: 0, open: 0 };
    c.notes++;
    out.set(n.roundId, c);
  }
  for (const i of liveOf(items)) {
    if (i.kind !== 'response' || i.active === false || i.state === 'done') continue;
    const n = byId.get(i.noteId);
    if (n) out.get(n.roundId).open++;
  }
  return out;
}

// The open My Turn review cycle, or null.
export function openTurn(turns) {
  return liveOf(turns).filter(t => !t.ended).sort((a, b) => cmp(a.started, b.started)).pop() || null;
}

// ---------- round summary (My Turn) ----------

// Every note of a round, grouped by station: stations in first-contribution
// order (a station without a recorded contribution at its first note's
// position), each once; notes by their contribution's position, then in
// recorded order. Stations without notes are left out.
export function roundSummary({ notes, contributions, participants, roundId }) {
  const contrib = new Map(liveOf(contributions).filter(c => c.roundId === roundId).map(c => [c.id, c]));
  const first = new Map();
  for (const c of contrib.values()) {
    if (!first.has(c.participantId) || c.seq < first.get(c.participantId)) first.set(c.participantId, c.seq);
  }
  const groups = new Map();
  for (const n of liveOf(notes).filter(n => n.roundId === roundId)) {
    if (!groups.has(n.participantId)) groups.set(n.participantId, []);
    groups.get(n.participantId).push(n);
  }
  const pos = n => (n.contributionId && contrib.has(n.contributionId) ? contrib.get(n.contributionId).seq : n.seq);
  const out = [];
  for (const [pid, list] of groups) {
    list.sort((a, b) => pos(a) - pos(b) || bySeq(a, b));
    const at = first.has(pid) ? first.get(pid) : Math.min(...list.map(n => n.seq));
    out.push({ participant: participants.find(p => p.id === pid) || { id: pid, call: '?' }, notes: list, at });
  }
  return out.sort((a, b) => a.at - b.at || cmp(a.participant.id, b.participant.id));
}
