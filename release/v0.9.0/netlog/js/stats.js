// Netlog statistics (#83): pure functions over a session's records and over a series of
// sessions. No DOM, no storage, no text; the stores' records go in as they are, plain numbers
// and ISO strings come out. Nothing invents precision (tools/netlog/AGENTS.md): estimated stays
// estimated, an unknown time is left out of every sum and counted in `leftOut`.
//
// ---------- Input ----------
//   SessionData = { session, participants, rounds, contributions, notes, events }
//     the session record and the records of the stores of the same names that belong to it
//     (`eventId` = session id), deleted ones included: soft-deleted records are ignored here.
//
// ---------- Shared shapes ----------
//   Time = { iso: string | null, quality: 'exact' | 'estimated' | 'unknown' }   (as in the stores)
//   Qty  = { ms: number | null, quality: 'exact' | 'estimated' | 'unknown', leftOut: number }
//     a duration in ms. quality 'unknown': ms is null (nothing could be measured). 'estimated':
//     built from an estimated time, or `leftOut` > 0 (then ms is at least what is shown).
//     `leftOut`: items (presence intervals, turns, sessions, NCS runs) not measurable and so
//     not in `ms`. Speaking times are always 'estimated' (see below).
//
// ---------- sessionStatistics(data) -> SessionStats ----------
//   { sessionId, seriesId, date, number, name,
//     start: Time, end: Time,        // session.start; session.end, else the latest "net closed"
//                                    // event, else unknown (a session joined late: unknown start)
//     length: Qty,                   // start -> end; unknown when either is unknown
//     rounds: [{ id, number, topic, start: Time, end: Time, duration: Qty, turns, notes }],
//                                    // in session order; end = next round's start (last round:
//                                    // the session end)
//     stations: [StationRow],        // one per live participant with a resolved callsign, in
//                                    // roster order
//     present: number,               // stations that attended
//     excluded: number,              // live participants with an unresolved call (? * or empty)
//     ncs: [{ participantId, call, name, from: iso|null, to: iso|null, ms: Qty }],
//                                    // the NCS rotation in time order (also for unresolved calls)
//     totals: { timePresent: Qty, speaking: Qty, turns, notes } }   // timePresent: attended stations
//   StationRow = { participantId, profileId, call, base, name,
//     attended,                      // a presence interval, a check-in or a status event (any)
//     firstCheckin: Time,            // earliest check-in event, else earliest interval start
//     checkinOffset: Qty,            // firstCheckin - session start; unknown without a known
//                                    // start (joined late) or when it would be negative
//     timePresent: Qty,              // sum of presence intervals; an open interval ends at the
//                                    // session end (unknown if that is unknown)
//     ncs: boolean, ncsTime: Qty,    // held net control (any time), and for how long
//     turns, notes,                  // live contributions / notes
//     speaking: Qty }                // ESTIMATE, an upper bound (it includes pauses): a turn
//                                    // lasts until the next turn in the same round starts, the
//                                    // last turn of a round until the next round's start; else
//                                    // not measurable. Only turns whose both bounding times are
//                                    // exact count; others are in leftOut. No turns: 0 ms.
//
// ---------- seriesStatistics(list) -> SeriesStats ----------
//   list: SessionData[] of a series (any order; deleted sessions ignored).
//   Station identity across sessions: profileId, else base callsign, joined greedily in
//   chronological order. Never joined: a participant marked `notSame` against the other, two
//   stations that both took part in one session, unresolved calls (excluded, counted).
//   { sessionCount,
//     sessions: [SessionStats],      // oldest first (date, number, created, id)
//     leaderboard: [{ rank, key, call, name, sessionsAttended, share, timePresent: Qty,
//                     speaking: Qty, ncsSessions, turns, notes, lastSeen }],
//                                    // share = sessionsAttended / sessionCount (0..1); lastSeen
//                                    // = ISO date (YYYY-MM-DD) of the latest attended session;
//                                    // sorted by sessionsAttended desc, timePresent.ms desc
//                                    // (unknown last), call, key. rank = position, from 1
//     matrix: { sessions: [{ sessionId, date, number }],
//               rows: [{ key, call, name, cells }] },  // rows as the leaderboard; cells[i]
//                                    // aligned with matrix.sessions: null (absent) or
//                                    // { participantId, timePresent: Qty, checkinOffset: Qty, ncs }
//     rotation: [{ sessionId, date, number, holders: [{ participantId, key, call, name,
//                                    from, to, ms: Qty }] }],  // key null: unresolved call
//     excluded: { participants, sessions },  // unresolved participants, sessions having some
//     gaps: { withoutStart, withoutEnd }     // sessions with unknown start / end
//   }
//   key: 'profile:<profileId>' when any joined participant has a profile, else
//   'call:<base callsign>'; '#2', '#3' ... is added when that key is taken by a different
//   station (a reused call marked notSame). Unique within one result, not a stored identifier.

import { liveOf, live, cmp, bySeq, roundsSorted, isUnresolved, callBase } from './model.js';
import { ncsRunList } from './ncsruns.js';

// ---------- times and quantities ----------

const stNoTime = () => ({ iso: null, quality: 'unknown' });

// a stored time as a Time: no (or unparsable) iso -> unknown
function stTime(t) {
  if (!t || !t.iso || Number.isNaN(Date.parse(t.iso))) return stNoTime();
  return { iso: t.iso, quality: t.quality === 'estimated' ? 'estimated' : 'exact' };
}
const stMs = t => (t.iso ? Date.parse(t.iso) : null);

const stQty = (ms, quality, leftOut = 0) => ({ ms, quality, leftOut });
const stUnknown = (leftOut = 0) => stQty(null, 'unknown', leftOut);

// b - a as a Qty; unknown unless both are known and b is not before a
function stSpan(a, b) {
  const x = stMs(a), y = stMs(b);
  if (x == null || y == null || y < x) return stUnknown();
  return stQty(y - x, a.quality === 'estimated' || b.quality === 'estimated' ? 'estimated' : 'exact');
}

// the sum of Qtys. Unknown members add nothing and count as left out (at least one each). The
// sum of nothing is 0. `always`: label a known sum 'estimated' (speaking time).
function stSum(list, always = false) {
  let ms = 0, known = 0, left = 0, est = always;
  for (const q of list) {
    if (q.ms == null) { left += Math.max(1, q.leftOut); continue; }
    ms += q.ms; known++; left += q.leftOut;
    if (q.quality === 'estimated') est = true;
  }
  if (!known && list.length) return stUnknown(left);
  return stQty(ms, est || left > 0 ? 'estimated' : 'exact', left);
}

const stIso = ms => (ms == null ? null : new Date(ms).toISOString());
const stByIso = (a, b) => cmp(a.time.iso, b.time.iso);

// ---------- one session ----------

export function sessionStatistics(data) {
  const session = data.session;
  const participants = liveOf(data.participants || []);
  const events = liveOf(data.events || []);
  const rounds = roundsSorted(data.rounds || []);
  const contribs = liveOf(data.contributions || []).sort(bySeq);
  const notes = liveOf(data.notes || []);

  const start = stTime(session.start);
  const closed = events.filter(e => e.type === 'round' && e.kind === 'closed' && e.time && e.time.iso).sort(stByIso).pop();
  const end = session.end && session.end.iso ? stTime(session.end) : closed ? stTime(closed.time) : stNoTime();

  // rounds: a round lasts until the next one starts (the last until the session end)
  const roundStart = i => (i < rounds.length ? stTime(rounds[i].start) : null);
  const roundStats = rounds.map((r, i) => {
    const stop = i + 1 < rounds.length ? roundStart(i + 1) : end;
    const from = stTime(r.start);
    return {
      id: r.id, number: r.number ?? null, topic: r.topic || '',
      start: from, end: stop, duration: stSpan(from, stop),
      turns: contribs.filter(c => c.roundId === r.id).length,
      notes: notes.filter(n => n.roundId === r.id).length,
    };
  });

  // speaking time, estimated from the turn sequence (all live turns bound each other)
  const speak = new Map();
  const byRound = new Map();
  for (const c of contribs) byRound.set(c.roundId, [...(byRound.get(c.roundId) || []), c]);
  for (const [rid, turns] of byRound) {
    const at = rounds.findIndex(r => r.id === rid);
    const after = at >= 0 && at + 1 < rounds.length ? roundStart(at + 1) : stNoTime();
    turns.forEach((c, k) => {
      const from = stTime(c.time);
      const to = k + 1 < turns.length ? stTime(turns[k + 1].time) : after;
      const e = speak.get(c.participantId) || { ms: 0, measured: 0 };
      if (from.quality === 'exact' && to.quality === 'exact' && Date.parse(to.iso) >= Date.parse(from.iso)) {
        e.ms += Date.parse(to.iso) - Date.parse(from.iso);
        e.measured++;
      }
      speak.set(c.participantId, e);
    });
  }

  // net control: the runs, time in order
  const t0 = stMs(start), t1 = stMs(end);
  const quality = [start, end, ...events.filter(e => e.type === 'ncs').map(e => stTime(e.time))].some(t => t.quality === 'estimated') ? 'estimated' : 'exact';
  const everyone = new Map((data.participants || []).map(p => [p.id, p]));
  const ncsRuns = ncsRunList(events, session.ncsId, t0, t1).map(r => {
    const p = everyone.get(r.id);
    return {
      participantId: r.id, call: p ? p.call || '' : '', name: p ? p.name || '' : '',
      from: stIso(r.from), to: stIso(r.to),
      ms: r.from == null || r.to == null ? stUnknown() : stQty(r.to - r.from, quality),
    };
  });

  const stations = [];
  let excluded = 0;
  for (const p of participants.sort((a, b) => (a.rosterOrder ?? 0) - (b.rosterOrder ?? 0) || cmp(a.created, b.created) || cmp(a.id, b.id))) {
    if (isUnresolved(p.call)) { excluded++; continue; }
    const ivs = p.presence || [];
    const mine = events.filter(e => e.participantId === p.id);
    const checkins = mine.filter(e => e.type === 'presence' && e.kind === 'checkin' && e.time && e.time.iso).sort(stByIso);
    const attended = ivs.length > 0 || mine.some(e => e.type === 'presence' || e.type === 'status');

    // time present: the intervals that can be measured
    const parts = [];
    let left = 0;
    for (const iv of ivs) {
      const from = stTime(iv.from);
      const to = iv.to && iv.to.iso ? stTime(iv.to) : iv.to ? stNoTime() : end;
      const q = from.iso && to.iso ? stSpan(from, to) : stUnknown();
      if (q.ms == null) left++; else parts.push(q);
    }
    let timePresent;
    if (!ivs.length) timePresent = attended ? stUnknown() : stQty(0, 'exact');
    else if (!parts.length) timePresent = stUnknown(left);
    else timePresent = stQty(parts.reduce((s, q) => s + q.ms, 0), left || parts.some(q => q.quality === 'estimated') ? 'estimated' : 'exact', left);

    const firstIv = ivs.map(iv => stTime(iv.from)).filter(t => t.iso).sort((a, b) => cmp(a.iso, b.iso))[0];
    const firstCheckin = checkins.length ? stTime(checkins[0].time) : firstIv || stNoTime();
    const runs = ncsRuns.filter(r => r.participantId === p.id);
    const sp = speak.get(p.id);
    const turns = contribs.filter(c => c.participantId === p.id).length;
    let speaking = stQty(0, 'estimated');
    if (turns) speaking = sp && sp.measured ? stQty(sp.ms, 'estimated', turns - sp.measured) : stUnknown(turns);

    stations.push({
      participantId: p.id, profileId: p.profileId || null, call: p.call, base: p.base || callBase(p.call), name: p.name || '',
      attended, firstCheckin, checkinOffset: stSpan(start, firstCheckin), timePresent,
      ncs: runs.length > 0 || session.ncsId === p.id, ncsTime: runs.length ? stSum(runs.map(r => r.ms)) : stQty(0, 'exact'),
      turns, notes: notes.filter(n => n.participantId === p.id).length, speaking,
    });
  }
  const here = stations.filter(r => r.attended);

  return {
    sessionId: session.id, seriesId: session.seriesId || null, date: session.date || '', number: session.number ?? null, name: session.name || '',
    start, end, length: stSpan(start, end), rounds: roundStats,
    stations, present: here.length, excluded, ncs: ncsRuns,
    totals: { timePresent: stSum(here.map(r => r.timePresent)), speaking: stSum(stations.map(r => r.speaking), true), turns: contribs.length, notes: notes.length },
  };
}

// ---------- identity across sessions ----------

// Groups of participant records that are one station: [[participant]] (each with `sid`).
// Greedy in the given (chronological) order; see the header for what never joins.
function stGroups(all) {
  const comps = [];
  const compOf = new Map();
  const byProfile = new Map(), byBase = new Map();
  const push = (m, k, id) => m.set(k, [...(m.get(k) || []), id]);
  const compatible = (a, b) => {
    for (const s of b.sessions) if (a.sessions.has(s)) return false;
    for (const id of a.notSame) if (b.members.has(id)) return false;
    for (const id of b.notSame) if (a.members.has(id)) return false;
    return true;
  };
  for (const p of all) {
    let mine = { members: new Set([p.id]), sessions: new Set([p.sid]), notSame: new Set(p.notSame || []), list: [p] };
    comps.push(mine);
    compOf.set(p.id, mine);
    const near = [...(p.profileId ? byProfile.get(p.profileId) || [] : []), ...(byBase.get(p.base) || [])];
    for (const id of near) {
      const other = compOf.get(id);
      if (other === mine || !compatible(mine, other)) continue;
      other.list.push(...mine.list);
      for (const x of mine.members) { other.members.add(x); compOf.set(x, other); }
      for (const x of mine.sessions) other.sessions.add(x);
      for (const x of mine.notSame) other.notSame.add(x);
      comps.splice(comps.indexOf(mine), 1);
      mine = other;
    }
    if (p.profileId) push(byProfile, p.profileId, p.id);
    push(byBase, p.base, p.id);
  }
  return comps.map(c => c.list);
}

// ---------- a series ----------

export function seriesStatistics(list) {
  const datas = list.filter(d => d.session && live(d.session)).sort((a, b) => (
    cmp(a.session.date, b.session.date) || (Number(a.session.number) || 0) - (Number(b.session.number) || 0)
    || cmp(a.session.created, b.session.created) || cmp(a.session.id, b.session.id)));
  const sessions = datas.map(sessionStatistics);
  const sessionCount = sessions.length;

  // identity: every live participant with a resolved call
  const all = [];
  datas.forEach(d => {
    for (const p of liveOf(d.participants || [])) {
      if (!isUnresolved(p.call)) all.push({ id: p.id, sid: d.session.id, profileId: p.profileId || null, base: p.base || callBase(p.call), notSame: p.notSame || [] });
    }
  });
  const station = new Map(); // participant id -> { key }
  const used = new Set();
  const keyOf = group => {
    const withProfile = group.find(p => p.profileId);
    const base = withProfile ? `profile:${withProfile.profileId}` : `call:${group[0].base}`;
    let key = base;
    for (let k = 2; used.has(key); k++) key = `${base}#${k}`; // another person with a reused call
    used.add(key);
    return key;
  };
  for (const g of stGroups(all)) {
    const key = keyOf(g);
    for (const p of g) station.set(p.id, key);
  }

  // the attended rows per station, in session order
  const perStation = new Map();
  sessions.forEach((s, i) => {
    for (const r of s.stations) {
      if (!r.attended) continue;
      const key = station.get(r.participantId);
      const e = perStation.get(key) || [];
      e.push({ i, s, r });
      perStation.set(key, e);
    }
  });

  const rows = [...perStation].map(([key, hits]) => {
    const last = hits[hits.length - 1];
    const named = [...hits].reverse().find(h => h.r.name);
    return {
      key, call: last.r.call, name: named ? named.r.name : '',
      sessionsAttended: hits.length, share: sessionCount ? hits.length / sessionCount : 0,
      timePresent: stSum(hits.map(h => h.r.timePresent)),
      speaking: stSum(hits.map(h => h.r.speaking), true),
      ncsSessions: hits.filter(h => h.r.ncs).length,
      turns: hits.reduce((n, h) => n + h.r.turns, 0), notes: hits.reduce((n, h) => n + h.r.notes, 0),
      lastSeen: last.s.date, hits,
    };
  });
  rows.sort((a, b) => (
    b.sessionsAttended - a.sessionsAttended
    || (b.timePresent.ms ?? -1) - (a.timePresent.ms ?? -1)
    || cmp(a.call, b.call) || cmp(a.key, b.key)));

  const leaderboard = rows.map((r, k) => {
    const { hits, ...row } = r;
    return { rank: k + 1, ...row };
  });
  const matrix = {
    sessions: sessions.map(s => ({ sessionId: s.sessionId, date: s.date, number: s.number })),
    rows: rows.map(r => {
      const cells = sessions.map(() => null);
      for (const h of r.hits) cells[h.i] = { participantId: h.r.participantId, timePresent: h.r.timePresent, checkinOffset: h.r.checkinOffset, ncs: h.r.ncs };
      return { key: r.key, call: r.call, name: r.name, cells };
    }),
  };
  const rotation = sessions.map(s => ({
    sessionId: s.sessionId, date: s.date, number: s.number,
    holders: s.ncs.map(h => ({ ...h, key: station.get(h.participantId) || null })),
  }));

  return {
    sessionCount, sessions, leaderboard, matrix, rotation,
    excluded: { participants: sessions.reduce((n, s) => n + s.excluded, 0), sessions: sessions.filter(s => s.excluded > 0).length },
    gaps: { withoutStart: sessions.filter(s => s.start.iso == null).length, withoutEnd: sessions.filter(s => s.end.iso == null).length },
  };
}
