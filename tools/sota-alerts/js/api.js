// Every network request of the tool. Read AGENTS.md (API call inventory)
// before adding one: SOTA's API is volunteer-run, be gentle on it.

import { summitFromApi } from './summits.js';
import { withDeadline, isAbort, ALERTS_TIMEOUT_MS, SUMMIT_TIMEOUT_MS, SEARCH_TIMEOUT_MS, DATA_STALL_MS, readJson } from './request.js';

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

// Every fetch below runs under a deadline (request.js), and the body is
// read inside it too: a request that hangs, or a body that stops arriving,
// rejects with a TimeoutError instead of stalling the page. `signal` (all
// optional) cancels it early with an AbortError.

// Deliberately live, no cache: page load and "refresh alerts" only.
export function fetchAlerts(signal){
  return withDeadline(ALERTS_TIMEOUT_MS, signal, async s => {
    const res = await fetch(ALERTS_URL, { signal: s });
    if (!res.ok) throw new Error(`alerts request failed: HTTP ${res.status}`);
    let data;
    try { data = await res.json(); }
    catch (err) { if (isAbort(err)) throw err; throw new Error('alerts request failed: not a JSON response'); }
    return data; // validated by parseAlerts() (alerts.js)
  });
}

// Only ever called through lookup.js's resolver (cache, static lookup,
// concurrency pool, request budget), never directly.
export function fetchSummit(assoc, code, signal){
  return withDeadline(SUMMIT_TIMEOUT_MS, signal, async s => {
    const res = await fetch(summitUrl(assoc, code), { signal: s });
    if (!res.ok) return null;
    return summitFromApi(await res.json(), assoc, code);
  });
}

export function searchSummits(term, signal){
  return withDeadline(SEARCH_TIMEOUT_MS, signal, async s => {
    const res = await fetch(summitSearchUrl(term), { signal: s });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('unexpected response');
    return data; // each item checked by candidateFromSearchResult()
  });
}

// A same-origin data file (data/…): no total deadline (it is large and
// may take long on a slow link), only a stall timeout.
export function fetchJson(url, signal){
  return withDeadline(DATA_STALL_MS, signal, async (s, touch) => {
    const res = await fetch(url, { signal: s });
    touch();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return readJson(res, touch);
  }, { stall: true });
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
    if (!data || !Array.isArray(data.elements)) throw new Error('Overpass returned an unexpected response (it may be busy — try again shortly)');
    return data.elements; // each element checked by candidateFromOsmElement()
  } finally {
    clearTimeout(timeout);
    overpassBusy = false;
  }
}
