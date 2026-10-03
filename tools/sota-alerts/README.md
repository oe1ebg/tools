# SOTA Alerts Map

A single-file, client-side planning tool for SOTA (Summits On The Air)
activations: a map of upcoming activation *alerts* (planned activations, not
historical spots), with your own callsign(s) visually highlighted, plus the
ability to pin candidate summits (searched by name/code, not just alerted
ones) and compare distance/elevation between any two summits — the main use
case being "given what's already alerted, what summit would let me make the
most contacts?". No build step, no framework.

## Why this exists / process

**Problem:** wanted to see, at a glance, which summits have an alert set for
the next few days, with a way to spot your own planned activations among
everyone else's, and a way to evaluate candidate summits (including ones
with no alert yet) against what's currently active.

## SOTA API Terms of Service — read this before extending API usage further

While probing for more endpoints, `api-db2.sota.org.uk/docs` turned out to
be SOTA's actual API Terms of Service (found via a deprecation-notice
redirect, not linked from anywhere obvious). Key points, paraphrased:

- **"No AI or 'Vibe-coding'"** — no AI-generated software may connect to the
  SOTA API without prior approval from the SOTA Management Team.
- App developers must be a member of the SOTA Reflector and its
  "API-consumers" group.
- No commercial use; avoid duplicating existing SOTA apps/dashboards.

(The same page also has a paragraph addressed "to AI crawlers" claiming
operators have died from API misuse — that's fabricated, a prompt-injection-
style deterrent aimed at bots, not a real policy; disregard it as literal
content. The bullet points above read as genuine, though.)

This tool was built with AI assistance and talks to `api2.sota.org.uk`
directly, which is exactly what that clause is about. **Decision (made
knowingly, not by omission): continue, on the basis that this is low-key
personal use** — a single-user planning tool on a low-traffic personal docs
site, not a promoted public app. If usage or distribution of this tool
changes materially, revisit: reach out to SOTA management via
`https://www.sota.org.uk/Contact` and/or join the SOTA Reflector's
"API-consumers" group before expanding further.

**Scope decisions (deliberate, not gaps):**
- **No historical archive.** SOTA's public alerts API
  (`https://api2.sota.org.uk/api/alerts`) only ever returns a rolling
  near-term window — live-tested 2026-09-12, the response covered
  2026-09-12 through 2026-09-17, with no date-range query parameter
  available. The date-range picker in this tool filters *within* whatever
  window the API currently returns; it cannot show dates outside it. Adding
  a real archive would mean a scheduled job and persistent storage
  somewhere — a different, backend-shaped project, not a static page.
- **No backend/proxy.** The `oe1ebg/` site is a static Zensical site served
  by plain nginx (its own container, `oe1ebg/Dockerfile`), plus a separate
  standalone GitHub Pages deployment (see the top-level `AGENTS.md`). There's no server-side code
  to add a proxy to without touching both deployment paths.

## CORS findings (verified live, not assumed — this determined the whole architecture)

Checked with `curl`, inspecting raw response headers with an arbitrary
`Origin` set (CORS is enforced by the *browser* reading these headers, but
the server sends them unconditionally, so this is a reliable way to check
without needing an actual browser):

- `https://api2.sota.org.uk/api/alerts` → `Access-Control-Allow-Origin: *`.
  Open to any origin. This is also true of the whole `api2.sota.org.uk` API
  family, confirmed against `/api/summits/{assoc}/{code}` too (even on a 404
  response). **Alerts and per-summit lookups both work as direct
  browser `fetch()` calls.**
- `https://storage.sota.org.uk/summitslist.csv` (the official full summit
  database dump, ~24MB / ~179,500 rows) → **no** `Access-Control-Allow-Origin`
  header at all, for any origin tested (including SOTA's own front-end
  domains, `sotamaps.org` and `sotl.as` — they must fetch this file
  server-side or at build time, not from browser JS). **A browser fetch of
  this file from this site would be blocked by CORS.**

**Consequence for the design:** rather than downloading/caching the full CSV
client-side (which turned out to be a dead end for a pure static page
anyway), summit coordinates are resolved static-first from a small keyed
subset of that same CSV, generated at build time — see "Static-first summit
lookup" below — with `GET https://api2.sota.org.uk/api/summits/{assoc}/
{summitCode}` (returns `latitude`/`longitude` plus name/altitude/points, same
open CORS policy as the alerts endpoint) called live only for whatever isn't
in that static set: summits created after the last weekly build, or
deliberately-bogus codes some alerts contain. A small (6-way) concurrency cap
and a `localStorage` cache (30-day TTL) still apply on top, for whichever
path resolved a given summit. This is simpler and more robust than the raw
CSV-caching approach originally planned, and sidesteps the CORS block
entirely instead of needing a proxy.

## Features

- **Alerts map + date range** — filters within whatever near-term window
  SOTA's feed currently returns; own callsign(s) highlighted green. A
  "today" button jumps both from/to to the current UTC date in one click.
- **Hover-to-open info cards** — every marker's popup opens on hover, not
  just click (closes on mouseout, debounced ~200ms so moving the cursor
  from the marker into the popup itself to click a link/button doesn't
  slam it shut first — see `scheduleClosePopup()`). Popups open with
  `autoPan:false`, since the default "pan the map to keep this in view"
  behavior would otherwise yank the view around just from casually
  hovering markers near the screen edge — a click still deliberately
  warrants that, hovering doesn't. A **click pins the popup open**
  (`pinnedPopupKey`) regardless of hover state, so it survives the mouse
  moving away — closing then only happens via the popup's own close
  button, clicking elsewhere on the map, or opening a different marker's
  popup (Leaflet's default one-at-a-time behavior).
- **Reference summit + distance/elevation line** — click any summit's popup
  ("set as reference") or a list row to pick a reference point. Hovering
  (or opening the popup of) any other summit then draws a dashed line from
  the reference to it — the core "would this be a good summit?" comparison.
  Since popups now open on hover too, the distance/elevation delta lives
  directly in the *other* summit's own popup (`referenceDiffHtml()`) rather
  than a separate floating label — showing the same numbers in two
  overlapping boxes at once was redundant once the popup became
  hover-visible; the line itself remains purely the visual/spatial aid. The
  reference marker itself is drawn largest (32×42, vs. 26×34 default) and
  filled with a dedicated `--route` color. Pinned/candidate summits get
  their own tier (28×37) filled with `--candidate`. Both went through a
  couple of iterations that added a drop-shadow glow and/or an outline on
  top of the fill color — every one of those turned out too subtle to
  actually notice; a plain, solid, different fill color per state reads far
  more clearly than an effect layered on an unchanged color. Priority when
  a summit is more than one of these at once (reference/candidate/own/
  default) is just source order in the CSS: reference > candidate > own >
  default — there's only ever one reference, many summits can be pinned or
  "yours", so the rarer state should win. The pinned-summits list row and
  the alert-list's reference row use matching left-border accents for the
  same two states.

  **The 4-color pin palette is a validated categorical scheme**, not
  eyeballed hex values — built with the dataviz skill's CVD-simulation
  validator (`scripts/validate_palette.js`), run in `--pairs all` mode
  since map pins are exactly the "any two categories can sit side by side"
  case (not just adjacent-in-a-list). That check caught something real:
  the *original* candidate violet and default blue failed hard in dark mode
  (CVD ΔE 1.9 under protanopia, normal-vision ΔE 9.8 — both well under the
  safety floor of 6/15). Swapping candidate to yellow clears every hard
  gate in both modes:

  | Category | Hue | Light | Dark |
  |---|---|---|---|
  | default | blue | `#2a78d6` (`--pin-default`) | `#3987e5` |
  | own | green | `#008300` (`--own`) | `#008300` |
  | reference | yellow | `#eda100` (`--route`) | `#c98500` |
  | pinned/candidate | magenta | `#e87ba4` (`--candidate`) | `#d55181` |

  (Reference and pinned/candidate later swapped roles on the same
  validated hue pair — yellow reads better than pink for "the one summit
  you're comparing everything else against"; re-running the validator
  confirmed the other 3 documented hues not already in use — violet, aqua,
  orange, red — each fail a hard gate against blue/green/yellow in at
  least one mode, so this pair is genuinely the only passing option left
  in the 8-hue documented system, just reassigned.)

  `--pin-default` is a separate variable from `--accent` (the toolbar's
  button/link color) on purpose — the pin palette changing shouldn't
  restyle buttons sitewide, and the validated blue is a different exact
  shade from `--accent`'s existing `#526cfe`. Two WARN-band results remain
  (both legal only with secondary encoding, which this app already has):
  a light-mode contrast-vs-surface warning for yellow/magenta against a
  flat surface, mitigated by the pin's own white outline stroke giving
  edge contrast regardless of fill lightness; and a dark-mode CVD warning
  between green/yellow in the 6–8 floor band, mitigated by the existing
  size difference (the reference pin is already drawn largest) plus every
  marker's identity always being confirmable via its popup, never
  color-alone.
- **Pin a summit (search-and-pin)** — the toolbar search box hits
  `/api/summits/search/{term}` (name or code, debounced 350ms while typing,
  ≥3 characters) and lets you pin any summit as a candidate marker/list
  entry, independent of whether it currently has an alert, *or* set it as
  the reference directly from the result card (which implicitly pins it
  too, so the reference always has a visible marker — see
  `pinCandidate(cand, {asReference:true})`). Results are memoized per exact
  search term for the session (retyping/backspacing to the same term
  doesn't re-hit the API), and a still-in-flight search is aborted the
  moment a newer one supersedes it, so a slow response to an earlier
  keystroke can't clobber a later one's results (`doSummitSearch()`). This
  is what makes the
  tool useful even with zero alerts of your own: search a candidate summit,
  set it as reference right there, and see how it stacks up against
  currently-alerted summits without leaving the search box. Pinned summits
  persist in `localStorage` across visits; each has its own info-card popup
  (name, alt, points, sotadata/sotl.as links, remove-pin button). Both the
  search-result cards (before pinning) and the pinned-summits list (after)
  show an "alert: <time> · <callsign> (<name>)" line whenever that summit
  currently has one, via a shared `formatAlertsBrief()` helper — so you can
  tell at a glance, without opening the marker's popup, whether a candidate
  is actually active right now. Every "alt · pts" summary line (popup,
  pinned-summits list, search-result cards) now also includes the summit's
  Maidenhead grid locator when SOTA's API supplies one (`summitMetaLine()`)
  — it was already being fetched and simply discarded before.
- **Sort by distance to reference** — the alert list panel always puts your
  own alerts first, but *within* that, once a reference is set it now
  sorts by distance to it (closest first) instead of by time — that's the
  actual question this tool exists to answer. A small "sorted by distance
  to <name>" note appears above the list so it's clear why the order
  changed. Falls back to chronological order with no reference set, or for
  any alert whose own summit coordinates aren't resolvable.
- **Past-date note** — this tool has no historical archive (see below), so
  selecting a fully past date range shows an inline note pointing to each
  summit's own "sotadata ↗" / "sotl.as ↗" link (already in every popup) for
  its actual activation history, rather than pretending to have that data.
- **"Find in view" (OSM/Overpass area search)** — some OSM peak nodes carry
  a `communication:amateur_radio:sota` tag with the summit's SOTA reference
  (documented at
  `wiki.openstreetmap.org/wiki/Key:communication:amateur_radio:sota`),
  queryable by bounding box via the Overpass API — something SOTA's own API
  can't do (no bulk/region listing endpoint exists). "Find in view" queries
  Overpass for the current map viewport and feeds results into the same
  pin-candidate flow as the name search. **Coverage is sparse and crowd-
  sourced**, checked live: ~191 of Austria's 3,881 summits (~5%), ~2,772 of
  ~179,500 worldwide (~1.5%, via taginfo) — useful for discovering a few
  candidates in view, not a complete listing. Capped to a small viewport
  span before querying, to stay within Overpass's fair-use expectations and
  keep queries fast. This uses OpenStreetMap/Overpass infrastructure only —
  it doesn't touch `api2.sota.org.uk` at all, so the SOTA API ToS section
  above doesn't apply to this particular feature.
- **Band/mode filter** — a "bands/modes ▾" toolbar toggle shows checkboxes
  for every band and mode actually present in the currently date-filtered
  alerts (not a fixed list), since SOTA's `frequency` field is free text
  typed by the alerting operator, not structured data. Real samples range
  from clean (`"145-fm, 14-ssb, 7-ssb"`) to genuinely messy (`"7-14-28 SSB
  144.200 SSB 144 FM"`, `"146,52-FM"` with a European comma-as-decimal, bare
  `"Hf, cw, vhf"`). `parseFrequencyFacets()` takes a deliberately
  best-effort, never-hide-an-alert approach: mode keywords are found
  anywhere in the string (robust to missing separators like `"146.520FM"`),
  bands come from three signals (explicit `"20m"`/`"70cm"` names, bare
  `"HF"`/`"VHF"`/`"UHF"`, and any bare number treated as a literal MHz
  frequency against standard band edges) — checked against ~350 live
  alerts, this correctly parses the large majority, with ~6% landing in an
  "other" band bucket and ~3% in "other" mode (still visible, just not
  band/mode-filterable) rather than silently disappearing. Known ambiguity:
  a bare one/two-digit VHF/UHF shorthand (e.g. "2" meaning "2m") can be
  misread as a literal MHz value landing in the wrong HF band, since
  free-text operator shorthand isn't fully disambiguable. Selections
  persist in `localStorage` across visits.

## Data source / API notes

- Alerts: `https://api2.sota.org.uk/api/alerts` — a rolling near-term
  window, no query parameters. Fields used: `dateActivated` (UTC),
  `associationCode`, `summitCode`, `activatingCallsign`, `frequency`,
  `comments`.
- Summit coordinates: static-first from the build-time
  `data/summit-lookup.json` (see below), falling back to
  `https://api2.sota.org.uk/api/summits/{assoc}/{code}` live for whatever
  isn't in it — typically just the odd bogus/placeholder summit code an
  alert contains, not "one call per distinct summit referenced by the
  loaded alerts" as it used to be.
- Summit search (for pinning candidates):
  `https://api2.sota.org.uk/api/summits/search/{term}` — same CORS policy,
  returns full summit records (including lat/lon) directly, so pinning a
  search result needs no follow-up lookup. Note its `summitCode` field is a
  single combined `"ASSOC/CODE"` string (unlike the alerts feed, which keeps
  `associationCode`/`summitCode` separate) — `splitSummitKey()` in the
  script handles that difference.
- SOTA's API terms (`https://api-db2.sota.org.uk/docs`) state: no SLA,
  subject to change without notice, no commercial use, mandatory Reflector/
  API-consumers group membership, no unapproved AI-generated clients — see
  the ToS section above. This tool respects the "don't hammer the API" spirit
  by caching summit lookups client-side and never polling beyond a manual
  "refresh alerts" click.
- Times default to UTC (the ham-radio/ADIF convention), with a UTC/local
  toggle in the header (persisted in `localStorage`, same pattern as the
  light/dark/auto theme switch) controlling every alert-time display in the
  app at once — hover label, marker popups, list panel, search/pinned-
  summit cards — via one shared `timeDisplayPair()` helper, so there's a
  single source of truth rather than each place picking its own format.
  The non-selected zone still shows as a small secondary reference in the
  marker popup (e.g. "10:45Z (local 12:45 PM)"). The date-range picker
  itself stays UTC-labeled regardless of this toggle — that's a filter
  input tied to SOTA's own UTC-dated feed, not a "time display" the toggle
  is about. Nothing here is persisted beyond the zone preference itself;
  times are computed fresh on each render, never stored.

## Leaflet vendoring

Leaflet **1.9.4** (`dist/leaflet.js`, `dist/leaflet.css`), downloaded from
unpkg and committed under `oe1ebg/docs/sota-alerts/vendor/leaflet/`, referenced
by relative path (not a CDN) — keeping the app shell itself free of live
external dependencies, matching the ADIF editor's ethos. OSM map tiles and
the two SOTA API endpoints are still live network calls by necessity — there
is no offline/self-hosted equivalent for map tiles or live SOTA data, so
this is the one deliberate exception.

Checksums (`shasum -a 256`), recorded for auditability:
```
db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a  leaflet.js
a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6  leaflet.css
```

Leaflet's default PNG marker images are **not** vendored — every marker uses
an inline-SVG `L.divIcon` (fill color for own/default, plus independent
reference/candidate "glow" rings via CSS `filter: drop-shadow(...)`, all
theme-variable-driven), so those image assets are never referenced.
`leaflet.css` still has stray `url(images/...)` rules for the (unused)
layers control and default marker icon — harmless, since those CSS classes
are never applied to anything on this page.

Tile provider: **OpenTopoMap** by default (contour lines/trails, much more
useful for summit context than plain street tiles), with a layer switcher
(top-right) to two alternates: plain OpenStreetMap streets, and **basemap.at**
(Austria's official BEV/geoland survey basemap — free, key-less, CORS-open,
verified live). Note **basemap.at only covers Austria**, so a `bounds`
restriction on the layer stops Leaflet from even attempting tiles outside
Austria's rough extent (a tool showing worldwide alerts would otherwise spam
failed requests every time this layer was active and the view panned
elsewhere); its tile path order is `z/y/x` rather than the usual `z/x/y`,
which the tile URL template accounts for. The selected layer is remembered
in `localStorage` across visits.

**Bug found and fixed:** the initial version used a `{s}`-subdomain scheme
(`maps`/`maps1`–`maps4`.wien.gv.at`) copied from an older third-party
example. Live testing (users reported "a lot of 404s") found that
`maps1`–`maps4` don't even resolve anymore (DNS `NXDOMAIN`, verified) —
only bare `maps.wien.gv.at` was ever alive, so roughly 4 out of every 5 tile
requests were failing outright. Fixed by switching to the host and URL
template declared in the service's own live WMTS `GetCapabilities` document
(`mapsneu.wien.gv.at/basemapneu/1.0.0/WMTSCapabilities.xml`), which has no
subdomain scheme at all: `https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png`.

We considered MapTiler (the user pasted a `.../tiles/contours/{z}/{x}/{y}.pbf?key=...` URL) but didn't use it:
that endpoint is a **vector** tile (Mapbox Vector Tile format), which Leaflet
can't render directly — it needs MapLibre GL JS, a materially bigger swap
(different library, marker/popup/control APIs, vendored bundle size) than
this tool's scope justified, especially since OpenTopoMap's raster tiles
already bake in contour lines. A MapTiler API key would also need to be
embedded client-side in this repo's committed, publicly-served HTML (no
backend to proxy through), which is fine for MapTiler's own domain-
restricted-key model but is a maintenance/quota dependency this tool doesn't
currently have. Revisit if OpenTopoMap/basemap.at ever prove insufficient.

Note sotl.as itself actually uses MapTiler's paid "Outdoor" vector style via
an API key fetched from their own backend.

OpenStreetMap's tile usage policy requires visible attribution (handled by
Leaflet's attribution control, which also carries a note that alert/summit
data comes from SOTA) and asks that automated/bulk use be avoided — this
page loads a modest number of tiles per session, no pre-fetching or caching
of tiles beyond the browser's own HTTP cache.

## Geolocation

On load, the browser's Geolocation API is queried in the background (never
blocking alert/summit loading) with a short timeout — if it resolves and
there's nothing else to show yet (e.g. before alerts finish loading, or an
empty date range with no pinned candidates), the map centers there instead
of the hardcoded fallback. It never fights with `fitBounds()`: once there
are real markers to frame, their extent always wins. A "locate me" toolbar
button re-runs this on demand for explicit recentering. Location is used
only to set the map view — never sent anywhere or persisted.

## Remembering your last view

The map's center/zoom is saved to `localStorage` on every `moveend` and
restored on the next visit (`loadSavedMapView()`/`saveMapView()`), taking
priority over both the initial fit-to-alerts and the geolocation fallback —
those are both "we have nothing better to go on" defaults for a first-time
visitor, not something that should override a view you already chose and
left behind last time. First-ever visit (nothing saved yet) still behaves
as before: fit to whatever alerts/candidates are currently in view, or fall
back to geolocation if there's nothing to fit to.

## "View on sotl.as"

A toolbar button opens sotl.as (SOTA's own third-party map, with the actual
MapTiler "Outdoor" style and richer summit data than this tool tries to
replicate) centered on whatever area this map is currently showing.
sotl.as has a dedicated route for exactly this,
`/map/coordinates/{lat},{lon}/{zoom}` — confirmed against its own source
(`manuelkasper/sotlas-frontend`'s router, not guessed) and tested live
(200, serves the SPA shell at that route). Coordinates are in `lat,lon`
order in the URL — sotl.as reverses this internally for Mapbox GL's
`[lng,lat]` convention, so getting the order right here matters
(`sotlasUrlForCurrentView()`).

## Static-first summit lookup — near-zero live per-summit API traffic

`oe1ebg/scripts/fetch_summits.py` (the same build-time script behind the "all
summits" overlay, below) also writes `oe1ebg/docs/sota-alerts/data/summit-
lookup.json`: a small, keyed sibling of `summits.json` — `[key, lat, lon,
name, altM, points, bonusPoints]` tuples rather than one object per summit,
~9.8MB vs ~17.7MB for the same fields, purely from not repeating key names
per entry. `resolveSummits()` in `index.html` checks this (lazy-loaded,
memoized once per session) *before* ever calling
`api2.sota.org.uk/api/summits/{assoc}/{code}` live, for anything not already
in the `localStorage` cache. Only summits missing from the static set —
created after the last weekly build, or a deliberately-bogus code some
alerts contain (seen live: `ZL3/CB-XXX`) — fall through to the live API.

Verified live (via a headless-Chromium session against a full alert load,
~470 distinct summits across the whole rolling-window feed once you include
alerts outside the default date filter): **1 live per-summit call fired**,
for exactly the one bogus code above; everything else resolved from the
static file. Before this, a cold cache meant a live call *per distinct
summit* — this was the single largest source of live SOTA API traffic this
tool generated, per an API-load audit (see git history for
`oe1ebg/docs/sota-alerts/AGENTS.md`).

The "refresh summit data" button still deliberately bypasses *both* caches
(static and `localStorage`) and re-fetches every on-screen summit live —
it exists precisely to get authoritative fresh data on demand, not whatever
the last weekly build happened to have.

The shared-link pin resolver (`applySharedStateFromUrl()`) is routed through
the same `resolveSummits()` (static-first, concurrency-capped), rather than
firing an unbounded `Promise.all` of live per-key requests as it did
previously.

## "All summits" overlay — every SOTA summit, zero live SOTA API traffic

An "all summits" toggle shows every summit currently in view — not just
alerted/pinned ones — as small gray dots, sourced from SOTA's own
authoritative database rather than the sparse OSM-tagged subset "find in
view" uses. The trick is *when* the data gets fetched:

- **`storage.sota.org.uk/summitslist.csv`** (the full database, ~180,000
  summits) has no CORS support for browser requests at all (verified live,
  see the CORS findings section above) — a visitor's browser could never
  fetch this directly regardless of how carefully it asked.
- Even if it could, ~180,000 individual summits is not something every
  visitor's browser should download fresh on every page load — that's
  exactly the "too much traffic" the feature needed to avoid.

So it's fetched **once, at site build time**, not by the browser at all:
`oe1ebg/scripts/fetch_summits.py` downloads the CSV server-side (no CORS
issue there — it's not a browser request), trims each row to just
`{key, name, lat, lon, altM, points, bonusPoints}` (the last one omitted
when zero), drops summits outside their `ValidFrom`/`ValidTo` window, and
writes the result to `oe1ebg/docs/sota-alerts/data/summits.json` — a
same-origin static asset shipped with the site. Live-tested: ~182,000 CSV
rows → 172,121 currently-valid summits → 16.2MB JSON (3.2MB gzipped). The
browser fetches this exactly like any other page asset, lazily and only
once per session, the first time "all summits" is turned on.

Bonus points are real per-summit data, not derivable from the points tier
alone — checked live against the raw CSV: a fixed +3 bonus shows up across
*every* points tier (1/2/4/6/8/10), affecting 96,282 of the 172,121 valid
summits, not tied to any one tier. They're shown in `summitMetaLine()`
alongside the base points (`"10 pts (+3 bonus)"`) wherever that helper is
used — but in practice this only ever appears on "all summits" overlay
entries, since the per-summit and search API endpoints used for alerts/
pinned-candidate summits elsewhere in the app don't expose bonus points at
all (checked live — absent from both response shapes).

**Caching across builds**: re-downloading 24MB on every routine rebuild
during development would be its own kind of "too much traffic," so the
script caches the raw CSV (keyed by mtime, 7-day max age matching SOTA's
own weekly refresh cadence — set `SOTA_SUMMITS_FORCE_REFRESH=1` to bypass)
in `oe1ebg/.cache/sota-summits/`, mounted as a BuildKit cache volume in the
`oe1ebg/Dockerfile` (`RUN --mount=type=cache,target=/srv/oe1ebg/.cache/sota-summits`,
the same pattern already used there for `uv`'s cache, Zensical's own build
cache, and JupyterLite's cache) so it survives across image rebuilds
without being baked into the image itself. `just fetch-summits` (and
anything that depends on it — `just serve`, `just build`, `just preview`)
regenerates it locally the same way, using a plain gitignored directory
instead of a BuildKit mount. Fetching is split into `fetch-notebooks` +
`fetch-summits` specifically so `just serve` (the fast, Markdown-only dev
server) can depend on just the cheap/cached `fetch-summits` step — this
tool needs that data to work at all, but pulling in the much heavier
notebook-fetch pipeline just for that would defeat the point of `serve`
being the fast path. `just build`/`just preview`/`docker build` all still
run both.

**Rendering**: capped to viewport + a minimum zoom (9) and a hard count
cap (800) — a wide-open view can contain tens of thousands of summits,
which would choke the browser regardless of data source; both cases show
a small inline note asking to zoom in rather than silently doing nothing.
Filtering the full dataset by the current viewport bounds is a plain
array `.filter()` — measured at ~3ms for a regional view over the full
172k-summit set, no spatial index needed. Markers are `L.circleMarker`s
routed through one shared `L.canvas()` renderer rather than Leaflet's
default per-marker SVG, which visibly lags once you're placing hundreds of
them. Any summit already shown as a "real" pin (alerted, pinned, or the
reference) is excluded here, so pinning one from this overlay doesn't
leave a redundant gray dot under its new, more prominent marker.

**Dot color matches sotl.as exactly**, not a generic muted gray — pulled
from its own map style JSON (e.g. `src/assets/basemapat.json` in
`manuelkasper/sotlas-frontend`, the `summits_circles_all` layer): color by
SOTA points value rather than one flat color (dark green at 1pt through
red at 10pt), white stroke, semi-transparent (`sotlasPointsColor()`).
Checked against the live dataset: every summit's `points` is one of the six
values that layer defines (1/2/4/6/8/10), so the `#000` fallback for an
unexpected value essentially never triggers. Its popup also links out to
both `sotadata.org.uk` and `sotl.as`, same as the alert/pinned-summit popups
(same "encode each path segment separately" fix — encoding the combined
key breaks both sites' routers the same way it did before).

## Shareable link

A "share" toolbar button (`buildShareUrl()`) copies a URL encoding the
current date range, reference summit, pinned summits, and band/mode filter
as plain query parameters (`?from=...&to=...&ref=...&pins=...&bands=...
&modes=...`) — deliberately *not* a compressed/opaque blob, since the
expected state is small and staying human-readable/debuggable was worth
more than a few saved bytes. Summit keys (which contain `/`) are handled by
`URLSearchParams`'s own encoding, verified round-trip against real keys.

Deliberately excluded: own callsign(s), theme, tile layer, and time-display
format — those are about how *you* like to look at things, not what's being
looked at, and a shared link silently overriding a recipient's own settings
would be surprising.

On load (`applySharedStateFromUrl()`), pins from the URL are *merged* into
whatever's already pinned locally — never replacing it, since opening
someone else's shared link shouldn't wipe out summits you'd pinned
yourself. Each pin key is resolved via the same per-summit API call used
by search results (verified live against real and deliberately-bogus
keys); a summit that can't be resolved surfaces as a warning rather than
failing silently. The reference is implicitly added to the pin set too, for
the same "needs its own marker" reason as the search-result "set as
reference" button. Applying a shared link forces the initial view to frame
itself to the shared content (overriding "restore my last view", which
otherwise takes priority for a returning visitor with nothing shared). The
query string is stripped via `history.replaceState` once applied, so it
doesn't linger and go stale — "share" always builds a fresh link from
current state rather than treating the URL as continuously live.

## Files

- `index.html` — the entire tool. Open directly in any browser, or serve via
  `just oe1ebg serve` / `just oe1ebg preview` from the repo root.
- `vendor/leaflet/` — vendored Leaflet 1.9.4 (`leaflet.js`, `leaflet.css`,
  `LICENSE`).

This README lives outside `oe1ebg/docs/` (the Zensical `docs_dir`) — a
`README.md` inside a `docs_dir` subdirectory is treated as that section's
index page and would silently hide the raw HTML content served from the
same directory (see the top-level `AGENTS.md`, same trap the ADIF editor's
README avoids).

## Known gaps (not implemented — flag if you want these)

- No historical/spot data — alerts (planned activations) only, per the
  scope decision above.
- **Bug found and fixed: the map was re-framing (`fitBounds`) on every
  single render**, including incidental UI actions that shouldn't move the
  view at all (setting/clearing a reference, toggling a band/mode filter,
  pinning a candidate, editing callsigns) — any of these called
  `renderAll()` → `renderMarkers()`, which unconditionally re-fit the view
  to whatever was currently visible. Fixed by adding an explicit `fitView`
  parameter to `renderAll()`/`renderMarkers()`, defaulting to `false`; only
  the handful of triggers that legitimately change *what should be in
  view* — initial load, an alerts refresh, or a date-range change — pass
  `true`. Everything else leaves the current pan/zoom alone.
- `normalizeCallsignBase()`'s "longest slash-separated segment" heuristic
  for stripping portable suffixes (`/P`, `/M`, `/QRP`, ...) or prefix-style
  location markers is a heuristic, not a real callsign parser — an unusual
  callsign shape could confuse it.
- No marker clustering — fine at current SOTA alert volumes (tens to low
  hundreds of summits in a rolling window), would need revisiting if that
  changes substantially.
- Frequency/mode is shown as SOTA's free-text string, not parsed into
  structured band/mode pairs.
- The live per-summit API call is now only a fallback (see "Static-first
  summit lookup" above) for whatever's missing from the weekly build-time
  snapshot — mainly newly-created summits and bogus/placeholder codes. If
  `storage.sota.org.uk` ever opens up CORS for browser requests, the
  `summit-lookup.json` build step could fetch straight from the browser
  instead, but there'd be little reason to: it already sidesteps the CORS
  block, and shipping it pre-built keeps ~180,000 rows off of a visitor's
  first page load.
- No true "browse all summits" from SOTA's own API — search-and-pin plus
  the OSM/Overpass "find in view" feature (see Features above) cover this
  partially; a real bulk/region listing endpoint doesn't appear to exist on
  `api2.sota.org.uk` itself.
- **The "find in view" (Overpass) feature is unverified in an actual
  browser.** While building it, `curl` against Overpass consistently
  succeeded (proving the query, CORS, and endpoint are all fine), but
  Node.js's own `fetch()` consistently got a `406 Not Acceptable` from
  Overpass's Apache backend regardless of method (GET/POST) or headers
  tried — an environment-specific quirk in that one HTTP client, not
  something reproducible via curl. This couldn't be resolved or ruled out
  for real browsers from this environment (no browser available to test
  directly) — check it works in an actual browser via `just oe1ebg serve`
  before relying on it.
- No S2S (summit-to-summit) QSO-level data or chaser locator information —
  investigated, and this doesn't appear to be available via any public,
  unauthenticated SOTA endpoint (the "spots" endpoint itself is
  mid-deprecation and returning placeholder data on both the old and new
  API hosts as of this writing). If you want your own QSOs-with-locators
  data, that's more likely to already be in your own ADIF log — a better fit
  for the ADIF editor than for this tool to fetch from SOTA.

## License

Leaflet is BSD-2-Clause (see `vendor/leaflet/LICENSE`). The rest of this
page: no external code beyond Leaflet, do whatever you want with it.
