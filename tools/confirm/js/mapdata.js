// Pure helpers for the map view (no DOM, no Leaflet) — unit-tested in
// oe1ebg/tests/. Coordinates are [lat, lon] / { lat, lon }.

import { maidenheadToBounds, isValidLocator, latLonToMaidenhead } from '../../shared/js/maidenhead.js';
import { liveCheckins } from './model.js';
import { latLonToUtm, utmToLatLon, utmZoneOf, latLonToMgrs } from '../../shared/js/utm.js';

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

// UTM grid lines (every `step` metres, every 10 km `major`) and the 10 km
// squares' UTMREF labels ("XP 0 4") covering bounds [[s, w], [n, e]], in the
// zone of the bounds' centre. Lines are polylines of [lat, lon] (grid lines
// are not parallel to meridians). At most `maxLines` lines: a finer grid
// over a bigger area falls back to 10 km.
export function utmGridLines(bounds, step = 1000, maxLines = 400) {
  const [[s, w], [n, e]] = bounds;
  const zone = utmZoneOf((s + n) / 2, (w + e) / 2);
  const corners = [[s, w], [s, e], [n, w], [n, e], [s, (w + e) / 2], [n, (w + e) / 2]].map(([la, lo]) => latLonToUtm(la, lo, zone));
  if (corners.some(c => !c)) return { lines: [], labels: [], zone, step };
  const hemi = corners[0].hemisphere;
  const minE = Math.min(...corners.map(c => c.easting)), maxE = Math.max(...corners.map(c => c.easting));
  const minN = Math.min(...corners.map(c => c.northing)), maxN = Math.max(...corners.map(c => c.northing));
  if (((maxE - minE) + (maxN - minN)) / step > maxLines) step = 10000;
  const e0 = Math.floor(minE / step) * step, n0 = Math.floor(minN / step) * step;
  const e1 = Math.ceil(maxE / step) * step, n1 = Math.ceil(maxN / step) * step;
  const toLL = (x, y) => {
    const p = utmToLatLon(zone, hemi, x, y);
    return [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6];
  };
  const SEG = 8;
  const lines = [];
  for (let x = e0; x <= e1; x += step) {
    const p = [];
    for (let k = 0; k <= SEG; k++) p.push(toLL(x, n0 + (n1 - n0) * k / SEG));
    lines.push({ p, major: x % 10000 === 0 });
  }
  for (let y = n0; y <= n1; y += step) {
    const p = [];
    for (let k = 0; k <= SEG; k++) p.push(toLL(e0 + (e1 - e0) * k / SEG, y));
    lines.push({ p, major: y % 10000 === 0 });
  }
  const labels = [];
  for (let x = Math.floor(e0 / 10000) * 10000; x < e1; x += 10000) {
    for (let y = Math.floor(n0 / 10000) * 10000; y < n1; y += 10000) {
      const [lat, lon] = toLL(x + 5000, y + 5000);
      if (lat < s || lat > n || lon < w || lon > e) continue;
      labels.push({ text: latLonToMgrs(lat, lon, 2).replace(/^\d+[A-Z] /, ''), lat, lon });
    }
  }
  return { lines, labels, zone, step };
}
