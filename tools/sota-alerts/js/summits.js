// Summit records: keys, the shapes the different sources deliver (SOTA's
// per-summit and search API, OSM, the build-time lookup), the meta line,
// distance/elevation to the reference summit, points colours and links.
// Pure; the fetching is in api.js, the caching in lookup.js.

import { distanceMeters } from '../../shared/js/geo.js';

// The search endpoint returns a combined "ASSOC/CODE" summitCode (unlike
// the alerts feed, which has associationCode/summitCode as separate
// fields) — split on the first "/" to recover both.
export function splitSummitKey(key){
  const parts = (key || '').split('/');
  const assoc = parts.shift();
  return { assoc, code: parts.join('/') };
}

// GET /api/summits/{assoc}/{code} -> summit record, or null without coordinates.
export function summitFromApi(data, assoc, code, now = Date.now()){
  if (data.latitude == null || data.longitude == null) return null;
  return {
    name: data.name || `${assoc}/${code}`,
    altM: data.altM,
    points: data.points,
    lat: data.latitude,
    lon: data.longitude,
    locator: data.locator || null,
    fetchedAt: now,
  };
}

// GET /api/summits/search/{term} result -> pin candidate.
export function candidateFromSearchResult(r){
  return { key: r.summitCode, ...splitSummitKey(r.summitCode), name: r.name, altM: r.altM, points: r.points, lat: r.latitude, lon: r.longitude, locator: r.locator || null };
}

// An Overpass node tagged communication:amateur_radio:sota -> pin candidate.
export function candidateFromOsmElement(el){
  const key = el.tags && el.tags['communication:amateur_radio:sota'];
  if (!key) return null;
  const pointsRaw = el.tags['communication:amateur_radio:sota:points'];
  return {
    key, ...splitSummitKey(key),
    name: el.tags.name || key,
    altM: el.tags.ele ? Math.round(parseFloat(el.tags.ele)) : null,
    points: pointsRaw ? parseInt(pointsRaw, 10) : null,
    lat: el.lat, lon: el.lon,
  };
}

// data/summit-lookup.json rows ([key, lat, lon, name, altM, points,
// bonusPoints], oe1ebg/scripts/fetch_summits.py) -> Map<key, record>.
export function lookupFromRows(rows){
  const map = new Map();
  for (const [key, lat, lon, name, altM, points, bonusPoints] of rows){
    const rec = { name, lat, lon, locator: null };
    if (altM != null) rec.altM = altM;
    if (points != null) rec.points = points;
    if (bonusPoints != null) rec.bonusPoints = bonusPoints;
    map.set(key, rec);
  }
  return map;
}

// Shared "480m · 8 pts · JN67dn" summary line, used by the marker popup,
// the pinned-summits list, and search-result cards. `locator` (Maidenhead
// grid) comes straight from the SOTA API.
export function summitMetaLine(s){
  let ptsPart = null;
  if (s.points != null){
    ptsPart = `${s.points} pts`;
    // Real per-summit data (a fixed bonus tied to certain summits, not
    // derivable from the points tier alone — checked live, it shows up
    // across every points tier, not just one), only ever present on
    // entries sourced from the build-time bulk data, since the
    // per-summit/search API endpoints used elsewhere don't expose it.
    if (s.bonusPoints) ptsPart += ` (+${s.bonusPoints} bonus)`;
  }
  return [s.altM ? `${s.altM}m` : null, ptsPart, s.locator || null]
    .filter(Boolean).join(' · ');
}

// Great-circle distance in km (haversine, tools/shared/js/geo.js).
export const haversineKm = (lat1, lon1, lat2, lon2) => distanceMeters(lat1, lon1, lat2, lon2) / 1000;

// Distance + elevation delta of `summit` relative to the currently-selected
// reference summit, or null if no reference is set / it isn't resolved.
export function referenceDiff(summit, referenceKey, summitMap){
  if (!referenceKey) return null;
  const ref = summitMap.get(referenceKey);
  if (!ref) return null;
  const distKm = haversineKm(summit.lat, summit.lon, ref.lat, ref.lon);
  const heightDiffM = (summit.altM != null && ref.altM != null) ? (summit.altM - ref.altM) : null;
  return { distKm, heightDiffM, refName: ref.name };
}

// "12.3 km, +250 m from reference (Name)"
export function referenceDiffText(diff){
  if (!diff) return '';
  const height = diff.heightDiffM != null ? `, ${diff.heightDiffM > 0 ? '+' : ''}${diff.heightDiffM} m` : '';
  return `${diff.distKm.toFixed(1)} km${height} from reference (${diff.refName})`;
}

// Matches sotl.as's own summit-dot coloring exactly (its "summits_circles_all"
// map layer, found in its style JSON — e.g. src/assets/basemapat.json in
// manuelkasper/sotlas-frontend): color by SOTA points value rather than a
// single flat color. SOTA's points tiers are always one of these six; the
// fallback only matters for odd data.
export function sotlasPointsColor(points){
  switch (points){
    case 1: return '#4d7a20';
    case 2: return '#6da536';
    case 4: return '#aea727';
    case 6: return '#efa818';
    case 8: return '#dc5d04';
    case 10: return '#c8101e';
    default: return '#000';
  }
}

// Path segments must be encoded individually and rejoined with a literal
// "/" — encoding the combined "ASSOC/CODE" key turns the separator into
// "%2F", which both sites' routers don't treat as a path boundary (e.g.
// sotadata.org.uk/en/summit/OE%2FTI-521 doesn't resolve).
export function summitLinks(assoc, code){
  const path = `${encodeURIComponent(assoc)}/${encodeURIComponent(code)}`;
  return {
    sotadata: `https://www.sotadata.org.uk/en/summit/${path}`,
    sotlas: `https://sotl.as/summits/${path}`,
  };
}

// sotl.as's router (verified against its own source, manuelkasper/
// sotlas-frontend) has a dedicated route for this exact purpose:
// /map/coordinates/{lat},{lon}/{zoom} — "lat,lon" order (it reverses
// this internally for Mapbox GL's [lng,lat] convention), zoom as a plain
// number.
export function sotlasMapUrl(lat, lng, zoom){
  return `https://sotl.as/map/coordinates/${lat.toFixed(5)},${lng.toFixed(5)}/${Math.round(zoom * 10) / 10}`;
}
