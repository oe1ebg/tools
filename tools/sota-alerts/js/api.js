// Every network request of the tool. Read AGENTS.md (API call inventory)
// before adding one: SOTA's API is volunteer-run, be gentle on it.

import { summitFromApi } from './summits.js';

export const ALERTS_URL = 'https://api2.sota.org.uk/api/alerts';
export const summitUrl = (assoc, code) => `https://api2.sota.org.uk/api/summits/${encodeURIComponent(assoc)}/${encodeURIComponent(code)}`;
export const summitSearchUrl = term => `https://api2.sota.org.uk/api/summits/search/${encodeURIComponent(term)}`;
// Same-origin, build-time-generated (oe1ebg/scripts/fetch_summits.py):
// the keyed lookup (~9.8MB, fetched on essentially every session, see
// lookup.js) and the full set for the "all summits" overlay (~17.7MB,
// only when that is switched on).
export const SUMMIT_LOOKUP_URL = 'data/summit-lookup.json';
export const ALL_SUMMITS_URL = 'data/summits.json';
// OSM tags some peaks with their SOTA reference (`communication:amateur_
// radio:sota=ASSOC/CODE`, documented at wiki.openstreetmap.org/wiki/Key:
// communication:amateur_radio:sota) — queryable by area via Overpass,
// which SOTA's own API can't do (no bulk/region listing endpoint).
// Coverage is crowd-sourced and sparse (~5% of Austria's summits, ~1.5%
// worldwide, checked live via taginfo/Overpass) — a useful complement to
// search-and-pin for browsing an area, not a complete listing.
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Deliberately live, no cache: page load and "refresh alerts" only.
export async function fetchAlerts(){
  const res = await fetch(ALERTS_URL);
  if (!res.ok) throw new Error(`alerts request failed: HTTP ${res.status}`);
  return res.json();
}

// Only ever called through lookup.js's resolver (cache, static lookup,
// concurrency pool), never directly.
export async function fetchSummit(assoc, code){
  const res = await fetch(summitUrl(assoc, code));
  if (!res.ok) return null;
  return summitFromApi(await res.json(), assoc, code);
}

export async function searchSummits(term, signal){
  const res = await fetch(summitSearchUrl(term), { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// A same-origin data file (data/…).
export async function fetchJson(url){
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// bounds: Leaflet LatLngBounds (getSouth/getWest/getNorth/getEast).
export async function searchOsmSummitsInView(bounds){
  const query = `[out:json][timeout:25];node["communication:amateur_radio:sota"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()});out body;`;
  const res = await fetch(OVERPASS_URL, { method: 'POST', body: query });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // The public Overpass instance occasionally answers a busy/overloaded
  // moment with an HTML error page instead of JSON, even on a 200 — seen
  // live while testing this. Give a clear message rather than an opaque
  // "Unexpected token '<'" JSON-parse crash.
  let data;
  try { data = await res.json(); }
  catch { throw new Error('Overpass returned an unexpected response (it may be busy — try again shortly)'); }
  return Array.isArray(data.elements) ? data.elements : [];
}
