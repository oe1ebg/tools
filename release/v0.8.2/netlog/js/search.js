// Offline search over every session on this device: callsigns (also
// partial), names, QTH and locators, notes, prepared replies, talking
// points, after-net tasks and round topics; filtered by series or to one
// station if wanted. Pure (no DOM, no storage, no network):
// app.js hands in the records. Case and accents are ignored; deleted
// records are left out.

import { sameStation } from './history.js';

export const SEARCH_FIELDS = ['all', 'call', 'name', 'place', 'note', 'reply', 'point', 'task', 'topic'];
const MAX_RESULTS = 200;

// Lower case, without accents (NFD minus combining marks), for matching.
export function fold(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Where `query` occurs in `text` ([start, end] in the original text), or
// null. Folding keeps the length for the scripts used here.
export function findMatch(text, query) {
  const q = fold(query).trim();
  if (!q) return null;
  const i = fold(text).indexOf(q);
  return i < 0 ? null : [i, i + q.length];
}

// records: { sessions, series, participants, notes, items, rounds } (all
// sessions). opts: { query, scope: 'session' | 'all', sessionId, field,
// series: 'any' | 'adhoc' | <series id>, station: a participant or null
// (only what belongs to that station, matched like the station history:
// sameStation() of history.js) }.
// Results, best first: { kind, field, sessionId, participantId, noteId,
// itemId, roundId, text, match, session, round, participant }.
export function search(records, { query, scope = 'all', sessionId = null, field = 'all', series = 'any', station = null }) {
  const q = String(query || '').trim();
  if (!q) return [];
  const live = r => r && !r.deleted;
  const inSeries = s => series === 'any' || (series === 'adhoc' ? !s.seriesId : s.seriesId === series);
  const sessions = new Map(records.sessions.filter(s => live(s) && inSeries(s)).map(s => [s.id, s]));
  const inScope = sid => sessions.has(sid) && (scope !== 'session' || sid === sessionId);
  const parts = new Map(records.participants.map(p => [p.id, p]));
  const rounds = new Map(records.rounds.map(r => [r.id, r]));
  const notes = new Map(records.notes.map(n => [n.id, n]));
  const want = f => field === 'all' || field === f;
  const out = [];
  const add = (res, text, f, rank) => {
    const match = findMatch(text, q);
    if (!match) return;
    const s = sessions.get(res.sessionId);
    out.push({
      ...res, field: f, text: String(text), match, rank,
      session: s, round: res.roundId ? rounds.get(res.roundId) || null : null,
      participant: res.participantId ? parts.get(res.participantId) || null : null,
    });
  };
  const callQ = q.toUpperCase().replace(/\s+/g, '');
  for (const p of records.participants) {
    if (!live(p) || !inScope(p.eventId)) continue;
    const base = { kind: 'participant', sessionId: p.eventId, participantId: p.id, roundId: null };
    if (want('call') && p.call && p.call.includes(callQ)) {
      out.push({ ...base, field: 'call', text: p.call, match: [p.call.indexOf(callQ), p.call.indexOf(callQ) + callQ.length], rank: p.call === callQ || p.base === callQ ? 0 : 1, session: sessions.get(p.eventId), round: null, participant: p });
    }
    if (want('name')) add(base, p.name, 'name', 2);
    if (want('place')) { add(base, p.qth, 'qth', 2); add(base, p.locator, 'locator', 2); }
  }
  for (const n of records.notes) {
    if (!live(n) || !inScope(n.eventId) || !want('note')) continue;
    add({ kind: 'note', sessionId: n.eventId, participantId: n.participantId, noteId: n.id, roundId: n.roundId }, n.text, 'note', 3);
  }
  for (const i of records.items) {
    if (!live(i) || !inScope(i.eventId) || i.active === false) continue;
    const n = i.noteId ? notes.get(i.noteId) : null;
    if (n && !live(n)) continue;
    const base = { kind: i.kind, sessionId: i.eventId, itemId: i.id, noteId: i.noteId || null, participantId: n ? n.participantId : null, roundId: n ? n.roundId : null };
    if (i.kind === 'response' && want('reply')) add(base, i.text, 'reply', 3);
    if (i.kind === 'point' && want('point')) add(base, i.text, 'point', 3);
    if (i.kind === 'task' && want('task')) add(base, i.text || (n ? n.text : ''), 'task', 3);
  }
  for (const r of records.rounds) {
    if (!live(r) || !inScope(r.eventId) || !want('topic') || !r.topic) continue;
    add({ kind: 'round', sessionId: r.eventId, roundId: r.id, participantId: null }, r.topic, 'topic', 3);
  }
  // only the station's own records (a talking point or a round topic has
  // no station)
  if (station) {
    for (let i = out.length - 1; i >= 0; i--) {
      const p = out[i].participant;
      if (!p || !(p.id === station.id || sameStation(station, p))) out.splice(i, 1);
    }
  }
  // this session first, then newer sessions, then the rank, then the
  // later records of a session
  const dateOf = r => (r.session && r.session.date) || '';
  out.sort((a, b) => (b.sessionId === sessionId) - (a.sessionId === sessionId)
    || (dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0)
    || a.rank - b.rank
    || ((notes.get(b.noteId) || {}).seq || 0) - ((notes.get(a.noteId) || {}).seq || 0));
  return out.slice(0, MAX_RESULTS);
}
