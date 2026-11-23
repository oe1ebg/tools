// Who held net control when, from a session's events (pure: no DOM, no storage). The roster
// report (rosterdata.js) and the statistics (stats.js) use the same runs.

import { liveOf, cmp } from './model.js';

// -> [{ id, from, to }] in time order, ms or null for a boundary not known. Before the first
// handover the holder is the station it was taken from; without handovers it is `ncsId`. A run
// spans [t0, t1] at most (handovers outside are clamped; a null bound is not clamped and stays
// null where a run reaches it); empty runs are left out. Handovers without a time are ignored.
export function ncsRunList(events, ncsId, t0, t1) {
  const hands = liveOf(events).filter(e => e.type === 'ncs' && e.time && e.time.iso).sort((a, b) => cmp(a.time.iso, b.time.iso));
  const runs = [];
  let holder = hands.length ? hands[0].from : ncsId, since = t0;
  const end = to => { if (holder && (since == null || to == null || to > since)) runs.push({ id: holder, from: since, to }); };
  for (const e of hands) {
    let ms = Date.parse(e.time.iso);
    if (t0 != null) ms = Math.max(ms, t0);
    if (t1 != null) ms = Math.min(ms, t1);
    end(ms);
    holder = e.to;
    since = ms;
  }
  end(t1);
  return runs;
}

// Map id -> [[from, to]] (ms), the runs of ncsRunList() per station
export function ncsRuns(events, ncsId, t0, t1) {
  const runs = new Map();
  for (const r of ncsRunList(events, ncsId, t0, t1)) runs.set(r.id, [...(runs.get(r.id) || []), [r.from, r.to]]);
  return runs;
}
