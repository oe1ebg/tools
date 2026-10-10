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
let overpassBusy = false;
let overpassRetryAt = 0;

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
  if (overpassBusy) throw new Error('an OSM search is already running');
  if (Date.now() < overpassRetryAt) throw new Error('Overpass is rate-limiting requests — wait at least 30 seconds before searching again');
  const query = `[out:json][timeout:25];node["communication:amateur_radio:sota"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()});out body;`;
  overpassBusy = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    let res;
    try {
      // Overpass requires a Referer for browser clients. Send only the
      // origin, never the page path or shared-link query parameters. The
      // browser still controls this header (privacy settings may omit it).
      res = await fetch(OVERPASS_URL, {
        method: 'POST', body: new URLSearchParams({ data: query }),
        credentials: 'omit', referrerPolicy: 'origin', signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Overpass timed out — try again later');
      // A rejected response without CORS headers is hidden by the browser;
      // JavaScript cannot distinguish it from other network failures.
      throw new Error('Overpass could not be reached (network, CORS or a server refusal). It requires a browser Referer; privacy settings may suppress it. Try summit search by name/code instead');
    }
    if (res.status === 429){
      const retryAfter = res.headers.get('Retry-After');
      const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
      const date = retryAfter && !/^\d+$/.test(retryAfter) ? Date.parse(retryAfter) : NaN;
      overpassRetryAt = Math.max(Date.now() + Math.max(30, seconds) * 1000, Number.isFinite(date) ? date : 0);
      throw new Error('Overpass is rate-limiting requests (HTTP 429) — wait at least 30 seconds before searching again');
    }
    if (res.status === 406) throw new Error('Overpass refused the request (HTTP 406). It requires a browser Referer and may block clients; try summit search by name/code instead');
    if (res.status === 504 || res.status === 503) throw new Error(`Overpass is busy or unavailable (HTTP ${res.status}) — try again later`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The public Overpass instance occasionally answers a busy/overloaded
    // moment with an HTML error page instead of JSON, even on a 200 — seen
    // live while testing this. Give a clear message rather than an opaque
    // "Unexpected token '<'" JSON-parse crash.
    let data;
    try { data = await res.json(); }
    catch { throw new Error('Overpass returned an unexpected response (it may be busy — try again shortly)'); }
    return Array.isArray(data.elements) ? data.elements : [];
  } finally {
    clearTimeout(timeout);
    overpassBusy = false;
  }
}
