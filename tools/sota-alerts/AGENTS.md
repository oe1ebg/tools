# AGENTS.md — SOTA Alerts Map

Guidance for AI agents working in this directory. For the full design
rationale, feature list, and the SOTA API Terms-of-Service decision (this
tool was built with AI assistance and talks directly to `api2.sota.org.uk`
— read that section before extending API usage further), see
`oe1ebg/tools/sota-alerts/README.md`. This file is the shorter, agent-facing
complement: a concrete API-call inventory and the constraints to preserve
when touching this code.

## Be gentle on SOTA's API — this is the design's top priority

SOTA is a volunteer-run, low-traffic amateur radio API with no SLA and an
explicit "don't hammer us" expectation. Every change here should be
evaluated against: *does this increase or decrease live requests to
`api2.sota.org.uk`?* Prefer static/build-time/cached sources over live calls
whenever the data doesn't need to be second-by-second fresh.

## API call inventory (as of the static-first summit lookup, added 2026-09-23)

| Endpoint | Called from | Trigger | Frequency | Safeguards |
|---|---|---|---|---|
| `GET api2.sota.org.uk/api/alerts` | `fetchAlerts()` | page load, "refresh alerts" click | 1 + 1/click | None — deliberately live, no cache |
| `GET api2.sota.org.uk/api/summits/{assoc}/{code}` | `fetchSummit()`, called only from inside `resolveSummits()`'s worker pool | fallback when a summit key is missing from **both** the `localStorage` cache **and** the static `data/summit-lookup.json` | ~1 per session in practice (bogus/placeholder codes, or summits created after the last weekly build) — down from "one per distinct summit referenced by alerts" (tens–hundreds on a cold cache) before this change | 30-day `localStorage` cache checked first; static lookup checked second; 6-way concurrency pool (`FETCH_POOL_SIZE`) as a last resort; `force=true` (the "refresh summit data" button) deliberately skips both caches for authoritative fresh data |
| `GET api2.sota.org.uk/api/summits/search/{term}` | `searchSummits()`, from `doSummitSearch()` | typing (debounced 350ms, ≥3 chars), search button, Enter | 1 per distinct term per session | `summitSearchCache` (session `Map`, case-insensitive) skips a repeat of the exact same term; `AbortController` cancels a still-in-flight search when a newer one supersedes it |
| `GET data/summit-lookup.json` (same-origin, not SOTA) | `loadSummitLookup()` | first call to `resolveSummits()` that needs it (in practice, page load) | ≤1 per session, memoized | `lazy()` (in-flight-promise guard), a failed load is kept as an empty map (no retry) |
| `GET data/summits.json` (same-origin, not SOTA) | `loadAllSummits()` | "toggle all summits" overlay click | ≤1 per session, memoized | Lazy — never loaded unless the overlay is turned on |
| `POST overpass-api.de/api/interpreter` (not SOTA) | `searchOsmSummitsInView()`, from `doAreaSearch()` | "find in view" click | 1 per click | Hard-capped to ≤4° viewport span before firing |

Every request is in `js/api.js`; the static-first resolver is `js/lookup.js`
(the functions above: `fetchAlerts`, `fetchSummit`, `searchSummits`,
`searchOsmSummitsInView` in `api.js`; `resolveSummits` from
`createSummitResolver()` in `lookup.js`; `doSummitSearch`, `doAreaSearch`,
`applySharedStateFromUrl` and the two lazy loads `loadSummitLookup` /
`loadAllSummits` in `app.js`). No `setInterval`/polling of any endpoint
anywhere.

## Static-first summit coordinate resolution

`oe1ebg/scripts/fetch_summits.py` downloads SOTA's full summit CSV once at
build time (already required for the "all summits" overlay) and now writes
**two** files instead of one:

- `data/summits.json` — full per-summit records, array (not keyed), used
  only by the lazily-loaded "all summits" overlay.
- `data/summit-lookup.json` — `[key, lat, lon, name, altM, points,
  bonusPoints]` tuples, ~9.8MB (vs ~17.7MB for the same fields as objects),
  fetched eagerly by `resolveSummits()` since it's needed on essentially
  every session, not just when a toggle is switched on.

`resolveSummits(entries, force)` (`js/lookup.js`) resolves in this order,
per entry:

1. `localStorage` cache (`LS_KEY_SUMMIT_CACHE`, 30-day TTL) — skipped
   entirely when `force` is true.
2. The static `summit-lookup.json` map — also skipped when `force` is true.
3. Live `GET api2.sota.org.uk/api/summits/{assoc}/{code}`, through a 6-way
   concurrency pool — the only path taken when `force` is true, and
   otherwise only for entries missing from both of the above.

**If you touch this flow:** keep the `force` bypass going straight to the
live API for *every* entry — it's the user's explicit "give me
authoritative fresh data" escape hatch, and diluting it with the static/
cached paths would be surprising. `applySharedStateFromUrl()` (shared-link
pin resolution) is routed through the same `resolveSummits()` rather than
its own fetch loop — keep it that way rather than reintroducing a
parallel, uncapped `Promise.all` of live calls.

**If you regenerate the summit data:** run `oe1ebg/scripts/fetch_summits.py`
(or `just fetch-summits` from `oe1ebg/`) — it writes both files from one CSV
parse, so there's no separate step to remember.

## Verifying changes to this tool

- `just oe1ebg test` runs `tests/sota-alerts.test.mjs`: the pure modules
  and the resolver's rules (cache → static lookup → live API, `force`
  straight to the live API, at most `FETCH_POOL_SIZE` live requests at
  once). Keep these green when touching the lookup.
- `tests/e2e/sota-alerts.spec.mjs` (Playwright, CI `validate` or `just
  oe1ebg e2e`) stubs the SOTA API and tiles and asserts which SOTA
  requests the page makes on load — a summit from the static lookup must
  not be fetched live.
- For anything else, run it (`just oe1ebg preview`) and watch the Network
  tab, not just the rendered map: the whole point of the static-first
  lookup is *fewer live SOTA requests*, which a screenshot won't show.
