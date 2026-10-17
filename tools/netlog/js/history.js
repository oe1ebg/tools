// A station's history across the sessions on this device: earlier
// participations with what was recorded there, open follow-ups, and
// possible matches that need a decision. Pure (no DOM, no storage):
// app.js hands in the records of all sessions.
//
// Matching (the same station automatically):
//   - the same station profile (profileId), or
//   - the same complete base callsign (OE1ABC = OE1ABC/P = HB9/OE1ABC).
// Never automatic: partial callsigns ("OE1AB?"), different callsigns. Those
// are offered as possible matches (a pattern fits, or the same name) and
// only become the same station by an explicit link (a shared profile).
// Historical snapshots (call, name, ... as recorded) are never rewritten.

import { liveOf, isUnresolved, callPattern, sessionLabel, bySeq, cmp } from './model.js';

// Is participant `b` (another session's) the same station as `a`?
export function sameStation(a, b) {
  if (!a || !b || a.id === b.id) return false;
  if (a.profileId && a.profileId === b.profileId) return true;
  return !isUnresolved(a.call) && !isUnresolved(b.call) && !!a.base && a.base === b.base;
}

// Sessions whose records count: live ones (a deleted session's history is
// hidden until it is restored).
function liveSessions(records) {
  return new Map(liveOf(records.sessions).map(s => [s.id, s]));
}

// The station's participations in other sessions, newest first:
// [{ session, series, label, participant, notes: [{ note, round, response, task }] }]
// records: { sessions, series, participants, rounds, notes, items }.
export function stationHistory(records, p, currentSessionId) {
  if (!p) return [];
  const sessions = liveSessions(records);
  const seriesById = new Map(records.series.map(s => [s.id, s]));
  const rounds = new Map(records.rounds.map(r => [r.id, r]));
  const parts = liveOf(records.participants).filter(x => x.eventId !== currentSessionId && sessions.has(x.eventId) && sameStation(p, x));
  if (!parts.length) return [];
  const pids = new Set(parts.map(x => x.id));
  const itemsByNote = new Map();
  for (const i of liveOf(records.items)) {
    if (!i.noteId || i.active === false || (i.kind !== 'response' && i.kind !== 'task')) continue;
    const e = itemsByNote.get(i.noteId) || {};
    e[i.kind] = i;
    itemsByNote.set(i.noteId, e);
  }
  const notesBy = new Map();
  for (const n of liveOf(records.notes)) {
    if (!pids.has(n.participantId)) continue;
    if (!notesBy.has(n.participantId)) notesBy.set(n.participantId, []);
    notesBy.get(n.participantId).push(n);
  }
  const out = parts.map(x => {
    const session = sessions.get(x.eventId);
    const series = session.seriesId ? seriesById.get(session.seriesId) || null : null;
    const notes = (notesBy.get(x.id) || []).sort(bySeq).map(note => ({
      note, round: rounds.get(note.roundId) || null, ...(itemsByNote.get(note.id) || {}),
    }));
    return { session, series, label: sessionLabel(session, series), participant: x, notes };
  });
  return out.sort((a, b) => cmp(b.session.date, a.session.date) || cmp(b.session.created, a.session.created));
}

// Open follow-ups from the history: after-net tasks and on-air responses
// still open, oldest first. [{ item, note, entry }]
export function openFollowUps(history) {
  const out = [];
  for (const entry of history) {
    for (const n of entry.notes) {
      for (const kind of ['response', 'task']) {
        const item = n[kind];
        if (item && item.state !== 'done') out.push({ item, note: n.note, entry });
      }
    }
  }
  return out.sort((a, b) => cmp(a.entry.session.date, b.entry.session.date) || bySeq(a.note, b.note));
}

// Participants of other sessions that may be the same station but are not
// matched automatically: a partial callsign on either side that fits the
// other, or the same name with another callsign. Excludes those already
// matched and those the user said are different (p.notSame). Newest first,
// one per callsign and name.
export function possibleMatches(records, p, currentSessionId) {
  if (!p) return [];
  const sessions = liveSessions(records);
  const notSame = new Set(p.notSame || []);
  const mine = callPattern(p.call);
  const name = String(p.name || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  const cands = liveOf(records.participants)
    .filter(x => x.eventId !== currentSessionId && sessions.has(x.eventId) && x.id !== p.id && !notSame.has(x.id) && !sameStation(p, x))
    .sort((a, b) => cmp(sessions.get(b.eventId).date, sessions.get(a.eventId).date));
  for (const x of cands) {
    if (!x.call) continue;
    const theirs = callPattern(x.call);
    const fits = (isUnresolved(p.call) && !isUnresolved(x.call) && mine && mine.test(x.base))
      || (isUnresolved(x.call) && !isUnresolved(p.call) && theirs && theirs.test(p.base));
    const sameName = name && String(x.name || '').trim().toLowerCase() === name;
    if (!fits && !sameName) continue;
    const key = `${x.call}|${x.name || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ participant: x, session: sessions.get(x.eventId), why: fits ? 'call' : 'name' });
  }
  return out;
}

// For the collapsed panel heading: { sessions, open }.
export function historySummary(history) {
  return { sessions: history.length, open: openFollowUps(history).length };
}

// The stores history reads (all sessions; the functions above filter).
export const HISTORY_STORES = ['sessions', 'series', 'participants', 'rounds', 'notes', 'items'];
