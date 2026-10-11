# AGENTS.md — SOTA Alerts Map

Apply the root `AGENTS.md` and read `tools/sota-alerts/README.md`, including
its API Terms-of-Service decision, before extending API usage. Paths below
are relative to the repository root. This is the online-only tool.

## Request policy

SOTA's volunteer-run API has no SLA. Evaluate changes by their live request
cost; prefer static/build-time/cached sources for summit metadata. Preserve
user-triggered refresh, no polling, and bounded fallback. Keep this
inventory synchronized with changes to endpoints, triggers, or safeguards.

## API call inventory

| Request | Entry point/trigger | Safeguards to preserve |
| --- | --- | --- |
| `GET api2.sota.org.uk/api/alerts` | `fetchAlerts()`: page load or refresh click | Live, uncached; 20 s deadline; no overlapping refresh; failure retains last-known alerts marked stale |
| `GET api2.sota.org.uk/api/summits/{assoc}/{code}` | `fetchSummit()` only through `resolveSummits()` | Cache → static → live; 6-way pool; 15 s deadline; shared-link and unavailable-static budgets below |
| `GET api2.sota.org.uk/api/summits/search/{term}` | `searchSummits()` via `doSummitSearch()`: ≥3 characters, 350 ms debounce, button/Enter | Case-insensitive session cache; 15 s deadline; abort superseded searches and discard stale results |
| `GET data/summit-lookup.json` (bundled) | `loadSummitLookup()` when resolution needs it | Memoized/in-flight guard; 30 s stall timeout; remember failures; one new attempt allowed per alerts-refresh click |
| `GET data/summits.json` (bundled) | `loadAllSummits()` when all-summits overlay is enabled | Lazy, memoized/in-flight guard; 30 s stall timeout |
| `POST overpass-api.de/api/interpreter` | `searchOsmSummitsInView()` via explicit find-in-view click | Viewport span ≤4°; one in flight; no automatic retry; 35 s timeout; ≥30 s cooldown on 429 respecting exposed `Retry-After`; form-encoded data, no credentials, origin-only Referer |
| Map tiles: OpenTopoMap, OpenStreetMap, basemap.at | Leaflet layers in `tools/sota-alerts/js/map.js` | Requests follow the selected layer/viewport; preserve attribution and the host restrictions in both deployment examples |

Data/API fetches are centralized in `tools/sota-alerts/js/api.js`; Leaflet
makes tile requests from `map.js`. SOTA calls and bundled JSON use shared
helpers in `tools/sota-alerts/js/request.js`; Overpass has its own timeout
and cooldown.
Keep body reading inside deadlines. Bundled datasets have stall timeouts,
not total deadlines, so slow links can finish. Do not replace the manual
signal composition with APIs outside the root browser floor.

## Static-first summit coordinate resolution

`createSummitResolver()` in `tools/sota-alerts/js/lookup.js` resolves each
summit in this order:

1. `localStorage` cache, subject to `SUMMIT_CACHE_TTL_MS` (30 days).
2. The bundled `data/summit-lookup.json` map.
3. Live per-summit API through `FETCH_POOL_SIZE` (6) workers.

Preserve explicit `force=true` refresh: skip both cache and static data to
request authoritative metadata, still through the worker pool. Ordinary
cache misses must not bypass static lookup. Failed/unlocated summits stay
unresolved rather than receiving guessed coordinates.

Shared links use this same resolver, never an independent fetch loop.
`parseShareSearch()` validates references, deduplicates, and caps pins at
`MAX_SHARED_PINS` (50). Resolve the reference first and pass
`maxLive: MAX_SHARED_LIVE_LOOKUPS` (10). When the static lookup fails,
`FALLBACK_LIVE_BUDGET` (20) caps live fallback across the session, shared
with other non-forced resolver calls. Preserve warnings and `overBudget`
reporting. `lazyRetryOnDemand()` remembers lookup failures until explicit
refresh allows another attempt; do not reload on every use.

`createLatest()` guards the summit-search panel. New searches, cache hits,
area searches, and input shorter than three characters must supersede old
work; late responses must not replace the newer panel state.

## Data and rendering

- `just fetch-summits` runs `scripts/fetch_summits.py`, producing both
  `tools/sota-alerts/data/summits.json` (full records for the lazy overlay)
  and `summit-lookup.json` (compact tuples for resolution) from one CSV.
  Keep tuple parsing in sync with `lookupFromRows()` and rebuild the bundle
  after a refresh. Data shapes and rationale are in the tool README.
- Build popups/lists with shared `el()` and text nodes; API and URL input
  must not become HTML. Follow shared HTML/accessibility rules and root
  relative-asset/CSP requirements. Host changes require both deployment
  examples to be updated and verified.

## Verification

- `tests/sota-alerts.test.mjs` covers pure modules, cache/static/live order,
  force bypass, concurrency/budgets, deadlines, stale results, and share
  limits. `tests/sota-alerts-api.test.mjs` covers API/Overpass behaviour.
  Run the affected Node tests (or `just test`).
- After building, run `just e2e sota-alerts` for
  `tests/e2e/sota-alerts.spec.mjs` in the supported projects. Its stubs
  assert request counts/absence as well as rendered state: static hits
  must not fetch live; hung requests, failed refresh, out-of-order search,
  and oversized shared links must retain their safeguards.
- Use `just build` and `just serve` for manual checks. Inspect the Network
  panel when changing request flows; a correct-looking map does not prove
  request budgets or lookup order. Use stubs for automated checks, and
  preserve the root browser fixture's foreign-request/error checks.
