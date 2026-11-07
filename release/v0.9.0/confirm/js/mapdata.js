// Pure helpers for the map view (no DOM, no Leaflet) — unit-tested in
// oe1ebg/tests/. Coordinates are [lat, lon] / { lat, lon }.

import { maidenheadToBounds, isValidLocator } from '../../shared/js/maidenhead.js';
import { liveCheckins } from './model.js';

// One record per callsign: all live check-ins (oldest first) and the
// latest check-in that has a resolved location. Operator comments are no
// stations and never appear here (nor in the KML built from this).
export function stationsForMap(entries) {
  const byCall = new Map();
  for (const e of liveCheckins(entries)) {
    if (!byCall.has(e.call)) byCall.set(e.call, { call: e.call, checkins: [], loc: null, locEntry: null });
    const s = byCall.get(e.call);
    s.checkins.push(e);
    if (e.loc && Number.isFinite(e.loc.lat) && Number.isFinite(e.loc.lon)) {
      s.loc = e.loc;
      s.locEntry = e;
    }
  }
  const all = [...byCall.values()];
  return { placed: all.filter(s => s.loc), unplaced: all.filter(s => !s.loc) };
}

// Own position: the header's QTH if it resolved confidently (qthResult =
// a lookup result or null), else the centre of the header's locator.
export function ownPosition(header, qthResult) {
  if (qthResult && Number.isFinite(qthResult.lat)) {
    return { lat: qthResult.lat, lon: qthResult.lon, label: qthResult.label, source: 'qth' };
  }
  const grid = String(header?.myGrid || '').trim();
  if (grid && isValidLocator(grid)) {
    const b = maidenheadToBounds(grid);
    return { lat: b.centerLat, lon: b.centerLon, label: grid, source: 'locator', bounds: b };
  }
  return null;
}
