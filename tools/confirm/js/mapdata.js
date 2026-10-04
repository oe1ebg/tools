// Pure helpers for the map view (no DOM, no Leaflet) — unit-tested in
// oe1ebg/tests/. Coordinates are [lat, lon] / { lat, lon }.

import { maidenheadToBounds, isValidLocator, latLonToMaidenhead } from './location/maidenhead.js';
import { liveSorted } from './model.js';

// One record per callsign: all live check-ins (oldest first) and the
// latest check-in that has a resolved location.
export function stationsForMap(entries) {
  const byCall = new Map();
  for (const e of liveSorted(entries)) {
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

const GRID_STEP = { 4: [2, 1], 6: [2 / 24, 1 / 24] }; // [lon, lat] degrees per square

// Grid lines and square labels covering bounds [[s, w], [n, e]].
export function maidenheadGridLines(bounds, precision = 6) {
  const [dLon, dLat] = GRID_STEP[precision];
  const [[s, w], [n, e]] = bounds;
  const lon0 = Math.floor((w + 180) / dLon) * dLon - 180;
  const lat0 = Math.floor((s + 90) / dLat) * dLat - 90;
  const lines = [], labels = [];
  const eps = 1e-9;
  for (let lon = lon0; lon <= e + dLon + eps; lon += dLon) lines.push([[s - dLat, lon], [n + dLat, lon]]);
  for (let lat = lat0; lat <= n + dLat + eps; lat += dLat) lines.push([[lat, w - dLon], [lat, e + dLon]]);
  for (let lon = lon0; lon < e + eps; lon += dLon) {
    for (let lat = lat0; lat < n + eps; lat += dLat) {
      const c = [lat + dLat / 2, lon + dLon / 2];
      labels.push({ loc: latLonToMaidenhead(c[0], c[1], precision), lat: c[0], lon: c[1] });
    }
  }
  return { lines, labels };
}
