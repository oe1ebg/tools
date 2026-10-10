// Summit coordinate lookup: static-first, the live API only as a fallback,
// cached in localStorage. The order and the `force` bypass are the rules in
// AGENTS.md ("Static-first summit coordinate resolution"); the dependencies
// are passed in, so tests/sota-alerts.test.mjs checks them without a
// network.

export const SUMMIT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // summit metadata rarely changes; 30 days is generous
export const FETCH_POOL_SIZE = 6; // small concurrency cap for per-summit lookups, be a polite API citizen

// Memoized lazy load with an in-flight guard, so concurrent callers can't
// trigger duplicate fetches. `fallback(err)`: the value to keep when the
// load fails (then it is never retried); without it the error is thrown
// and the next call tries again.
export function lazy(load, fallback){
  let value = null, loading = null;
  const get = async () => {
    if (value) return value;
    if (loading) return loading;
    loading = load();
    try {
      value = await loading;
    } catch (err) {
      if (!fallback) throw err;
      value = fallback(err);
    } finally {
      loading = null;
    }
    return value;
  };
  get.loaded = () => value;
  return get;
}

// deps:
//   loadCache()      -> { key: record } (localStorage, see store.js)
//   saveCache(cache)
//   loadLookup()     -> Promise<Map<key, record>> (data/summit-lookup.json)
//   fetchSummit(assoc, code) -> Promise<record|null> (the live API)
//   now()            -> ms, default Date.now
//
// Returns resolveSummits(entries, force): {key, assoc, code} entries ->
// Map<key, record>, in this order per entry:
//   1. the localStorage cache (TTL-based),
//   2. the static build-time lookup (same-origin, loaded once),
//   3. the live per-summit API, through a small concurrency pool so a busy
//      day doesn't fire 100+ requests at once.
// `force` (the "refresh summit data" button) skips 1 and 2 and goes to the
// live API for every entry — it exists precisely to get authoritative
// fresh data, not whatever the last weekly build happened to have.
// Entries with no coordinates or a failed lookup are simply absent from
// the result — never guessed at.
// `maxLive` (default unlimited) caps the number of live requests of this
// call — a shared link passes one, so a crafted URL can't make the page
// fetch a long list of summits; the entries over it are left out and
// listed in the result's `overBudget` (keys, an array).
export function createSummitResolver({ loadCache, saveCache, loadLookup, fetchSummit, now = Date.now, poolSize = FETCH_POOL_SIZE, ttlMs = SUMMIT_CACHE_TTL_MS }){
  return async function resolveSummits(entries, force, { maxLive = Infinity } = {}){
    const cache = loadCache();
    const t = now();
    const result = new Map();
    const toFetch = [];
    for (const e of entries){
      const cached = cache[e.key];
      if (!force && cached && (t - cached.fetchedAt) < ttlMs){
        result.set(e.key, cached);
      } else {
        toFetch.push(e);
      }
    }

    let cacheChanged = false;
    let stillMissing = toFetch;
    if (!force && toFetch.length){
      const lookup = await loadLookup();
      stillMissing = [];
      for (const e of toFetch){
        const found = lookup.get(e.key);
        if (found){
          const record = { ...found, fetchedAt: t };
          result.set(e.key, record);
          cache[e.key] = record;
          cacheChanged = true;
        } else {
          stillMissing.push(e);
        }
      }
    }

    result.overBudget = stillMissing.slice(maxLive).map(e => e.key);
    stillMissing = stillMissing.slice(0, maxLive);

    let idx = 0;
    async function worker(){
      while (idx < stillMissing.length){
        const e = stillMissing[idx++];
        try {
          const summit = await fetchSummit(e.assoc, e.code);
          if (summit){
            result.set(e.key, summit);
            cache[e.key] = summit;
            cacheChanged = true;
          }
        } catch (err) {
          // a warning, not an error: the page shows it too (checkMissingSummits)
          console.warn(`summit lookup failed for ${e.key}:`, err);
        }
      }
    }
    const workers = Array.from({ length: Math.min(poolSize, stillMissing.length) }, worker);
    await Promise.all(workers);
    if (cacheChanged) saveCache(cache);
    return result;
  };
}
