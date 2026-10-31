// What the roster report is made of (the roster PDF and the roster widget in Net Control show
// the same numbers): the span of the net, one row per station with its in / out / duration and
// notes, and the data of the presence timeline. Pure: no DOM, no text.

import { liveOf, rosterSorted, ncsFirst } from './model.js';
import { ncsRuns } from './ncsruns.js';

const rdIso = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The net's span: from the first check-in to the net closed (else to the last thing recorded).
function rdSpan(app) {
  const stamps = [];
  for (const p of app.sd.participants.filter(x => !x.deleted)) for (const iv of p.presence || []) { if (iv.from && iv.from.iso) stamps.push(iv.from.iso); if (iv.to && iv.to.iso) stamps.push(iv.to.iso); }
  for (const n of liveOf(app.sd.notes)) if (n.time && n.time.iso) stamps.push(n.time.iso);
  for (const e of liveOf(app.sd.events)) if (e.time && e.time.iso) stamps.push(e.time.iso);
  stamps.sort();
  const closedEv = liveOf(app.sd.events).filter(e => e.type === 'round' && e.kind === 'closed' && e.time && e.time.iso).map(e => e.time.iso).sort().at(-1) || null;
  return { start: stamps[0] || null, end: closedEv || stamps.at(-1) || null, closed: !!closedEv };
}

// one station's stretches of presence: [{ status, from, to }] in ms, from its status events
function rdStretches(app, p, span) {
  const t0 = Date.parse(span.start), t1 = Date.parse(span.end);
  const evs = liveOf(app.sd.events).filter(e => e.type === 'status' && e.participantId === p.id && e.time && e.time.iso)
    .sort((a, b) => rdIso(a.time.iso, b.time.iso));
  const first = (p.presence || []).find(iv => iv.from && iv.from.iso);
  let cur = evs.length ? evs[0].from : p.status;
  let at = first ? Math.max(t0, Date.parse(first.from.iso)) : t0;
  const out = [];
  const push = (status, to) => { if (status !== 'out' && to > at) out.push({ status, from: at, to }); };
  for (const e of evs) {
    const ms = Date.parse(e.time.iso);
    push(cur, ms);
    cur = e.to;
    at = Math.max(at, ms);
  }
  push(cur, t1);
  return out;
}

// "00:56", "01:05" (hh:mm) for a span in ms; "-" for none or for more than a day (a net does not
// run that long: the data is then not a continuous session)
export function rosterDur(ms) {
  if (!(ms >= 0) || ms > 24 * 3600000) return '-';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// -> { roster, span, rows, chart }
//   rows: [{ p, inAt, outAt, ms, notes, ncs: 'current' | 'former' | null, me }]
//   chart: null (nothing to draw) or { t0, t1, rows: [{ p, stretches, ncs, notes }] } (ms)
export function rosterData(app) {
  const s = app.s;
  const roster = ncsFirst(rosterSorted(app.sd.participants), s.ncsId);
  const span = rdSpan(app);

  // the last thing recorded for each station (its notes, events, turns)
  const lastSeen = new Map();
  const seen = (pid, iso) => { if (pid && iso && (!lastSeen.get(pid) || iso > lastSeen.get(pid))) lastSeen.set(pid, iso); };
  for (const n of liveOf(app.sd.notes)) seen(n.participantId, n.time && n.time.iso);
  for (const e of liveOf(app.sd.events)) seen(e.participantId, e.time && e.time.iso);
  for (const c of liveOf(app.sd.contributions)) seen(c.participantId, c.time && c.time.iso ? c.time.iso : c.created);

  // one station's time in the net: from the first check-in to the last check-out; a station still
  // in runs to the closing of the net, else to the last thing recorded for it
  const presence = p => {
    const ivs = (p.presence || []).filter(iv => iv.from && iv.from.iso);
    if (!ivs.length) return { inAt: null, outAt: null, ms: 0 };
    const last = ivs.at(-1);
    const end = last.to && last.to.iso ? last.to.iso : span.closed ? span.end : (lastSeen.get(p.id) || ivs[0].from.iso);
    return { inAt: ivs[0].from.iso, outAt: last.to && last.to.iso ? last.to.iso : null, ms: Date.parse(end) - Date.parse(ivs[0].from.iso) };
  };

  const counts = new Map();
  for (const n of liveOf(app.sd.notes)) counts.set(n.participantId, (counts.get(n.participantId) || 0) + 1);
  // stations that held net control before the current one
  const former = new Set(liveOf(app.sd.events).filter(e => e.type === 'ncs' && e.from).map(e => e.from));
  const rows = roster.map(p => ({
    p,
    ...presence(p),
    notes: counts.get(p.id) || 0,
    ncs: s.ncsId === p.id ? 'current' : former.has(p.id) ? 'former' : null,
    me: !!(s.own && s.own.base && p.base === s.own.base),
  }));

  let chart = null;
  if (span.start && span.end && roster.length) {
    const t0 = Date.parse(span.start);
    const t1 = Math.max(Date.parse(span.end), t0 + 60000);
    const runs = ncsRuns(app.sd.events, app.s.ncsId, t0, t1);
    const notes = liveOf(app.sd.notes).filter(n => n.time && n.time.iso);
    chart = {
      t0,
      t1,
      rows: roster.map(p => ({
        p,
        stretches: rdStretches(app, p, span),
        ncs: runs.get(p.id) || [],
        notes: notes.filter(n => n.participantId === p.id).map(n => Date.parse(n.time.iso)).filter(ms => ms >= t0 && ms <= t1),
      })),
    };
  }
  return { roster, span, rows, chart };
}
