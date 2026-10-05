# AGENTS.md — Bestätigungsverkehr (confirmation log)

This is the short, agent-facing guide. Design rationale and the feature list
are in `oe1ebg/tools/confirm/README.md`.

## Rules to keep

- **Never add a runtime network dependency.** That means no `fetch()` to
  another host, no CDN `<script>`/`<link>`, no web fonts and no map tiles.
  Data must be produced at build time, under `tools/shared/data/`, and
  listed in the precache. `tests/confirm-offline.test.mjs` fails on any external URL.
  The one exception is `js/sources.js`: dataset/licence links (footer) and
  map links (Google Maps / OpenStreetMap, built by `mapLinkUrls()`), which
  are only `<a href>` targets and never fetched. The test also checks that
  this file contains no request APIs. Map links are rendered via
  `mapLinks()` with class `online-only`, hidden while offline
  (`trackOnline()` sets `html.offline`). XML namespace identifiers (SVG,
  KML) are allowed by the test's `XML_NAMESPACES`.
- **Never lose user data.** The IndexedDB schema (`js/db.js`, on top of
  `tools/shared/js/storage.js`) is at v2; v2 added the `stations` store.
  - Writes go through `store.tx()`, and the UI may only show success after
    the promise resolves.
  - Edits store a revision first, and deletes are soft (`deleted`
    timestamp).
  - Schema changes need a new `DB_VERSION` plus a migration branch in
    `openIdb()`. Never delete or recreate stores.
- **Bundler limits.** `scripts/build_confirm.py` concatenates the `js/`
  modules and the `tools/shared/` modules they import into
  `confirm-offline.html` (`scripts/single_file.py`), so:
  - only use `import { … } from './x.js';` (or `'../…'`), no `as`;
  - only put `export` in front of `function`/`const`/`let`/`class`;
  - keep top-level names unique across all modules, the shared ones included.
- **Shared code** (`tools/shared/`: location lookup, Maidenhead, distance,
  ADIF encoding, Leaflet) is used by other tools too. Change it with them in
  mind and run all tests. It is precached as `../shared/…` (computed by
  `build_confirm.py` from the imports and the `CONFIRM-VENDOR` block).
- **DOM:** use `fill(node, ...children)` from `tools/shared/js/dom.js`, not
  `node.replaceChildren(...)` with arrays or `null`. `replaceChildren`
  renders an array as "[object HTMLLIElement]" and `null` as the text
  "null". That was the bug in the recycle bin and snapshot lists.
- **Completion dropdowns** use `popover(input, list)` from `tools/shared/js/dom.js`.
  - Their items are not Tab stops (`update()` sets `tabIndex=-1`).
  - Enter in the input picks the first item. Pass
    `{ enterPicksFirst: false }` where the items are only guesses that
    could replace valid input (the callsign typo suggestions).
- **Keyboard-only entry form** (the log header and "+ Neues Log" follow
  the same rules; `headerKeys()` in `js/app.js`).
  - Shift+Enter saves from any control.
  - Enter moves on with `focusNext()`.
  - Don't add Tab stops inside the info lines under fields.
  - Keep those info lines inside the fixed-height `.ac-hints` slot, so the
    inputs never move.
- **Relative paths only.** The directory is planned to move to `/tools/`
  later.
- **Footer version** (`commit abc1234 · data <hash>`). The commit comes
  from `GIT_SHA` (Docker build arg / Justfile) and goes into the generated
  `build-info.js` (`self.CONFIRM_BUILD`, inlined into the offline file).
  Keep it **out of `precache.js` and out of the content hash**. Otherwise
  every commit triggers a service-worker update. The commit link is
  built by `commitUrl()` in `js/sources.js`.
- **Operator comments** (issue #32) are entries with `kind: 'comment'` in
  the `entries` store (no schema change): `{ id, eventId, kind, ts, text,
  category, auto, snap, created, updated, deleted }`, with no `call`, no
  `seq` and no check-in number. A line without `kind` is a check-in (old
  data and backups). Anything that counts stations or QSOs must use
  `liveCheckins()` (or `checkinNumbers()` / `previousCheckins()` /
  `stats()` / `stationsForMap()`, which already do); `liveSorted()` returns
  both kinds in time order.
  - Exports: ADIF, KML and the map never include comments. CSV only with
    `toCSV(…, { comments: true })` (columns `typ`, `kategorie`). The
    summary always includes them, plus the "Operators:" line from
    `operatorShifts()`. The JSON backup is the raw store.
  - Adding: `!` as the first character in the callsign field switches the
    form to comment mode (`setCommentMode()` in `js/app.js`; CSS
    `.ci-only` / `.c-only`).
  - Automatic markers: `headerChangeMarkers()` (pure, tested) decides;
    `flushMarkers()` in `js/app.js` runs it on the log header's `change`
    event, before saving a line, before an export and when leaving. Keep
    the "don't switch the form under someone who is logging" rule: a new
    marker opens for editing only with an empty form and focus in the
    header.

## Data

`data/callsigns-oe.json` is built by `scripts/fetch_callsigns.py` and holds
`{stand, source, calls: [[call, name, location], ...]}`. Keep it free of
street addresses. The data files live in `tools/shared/data/` (shared with
other tools, published at `/shared/data/`). Load them only through
`loadDataFile('name.json')` (`tools/shared/js/data.js`) with a **string
literal**: `build_confirm.py` collects those literals to decide which files
go into the precache and the offline bundle.

`data/repeaters-at.json` is built by `scripts/fetch_repeaters.py` and holds
`{source, retrieved, repeaters: [{call, site, city, lat, lon, locator, alt,
band, out, in, shift, ctcss, modes[], status, ch?, cc?, echolink?,
comment?}]}`. `out` is the repeater's output and `in` its input
(shift = in − out). `modes` uses the keys of `MODES` in `js/model.js`.

`data/vienna-locations.json` is built by `scripts/build_location_data.py`
(schema 1). It contains `plz[]`, `streets[[name, start, count]]` (with
addresses contiguous per street), the per-address arrays
`hn`/`ap`/`ad`/`alat`/`alon` (integer 1e-5° offsets from
`latBase`/`lonBase`), `places[[name, category, lat, lon, alts]]`,
`districts`, `aliases` and `meta`.

- **Changing the format:** bump `schema` and update `buildLocationIndex()`.
- **Normalization** exists only in `tools/shared/js/location/normalize.js`.
- **Ranking changes** need the tests in
  `tests/location-search.test.mjs` updated. They run against a synthetic
  dataset (always) and against the real data (when it has been built).

`data/austria-areas.json` is written by `scripts/build_austria_areas.py`
(schema 1) from the **committed snapshot** `oe1ebg/austria-areas.json`;
`just refresh-areas` rebuilds the snapshot from the BEV Adressregister and
Statistik Austria (needs network + pyproj). It contains `meta`, `states[]`
(Bundesland short names by the first GKZ digit), `plz[[plz, name,
moreGemeinden, state, bezirke, lat, lon, addresses, loc6, loc6Count,
loc4]]` and `bezirke[[code, name, aliases, state, lat, lon, addresses,
loc6, loc6Count, loc4, topPlz]]`; `loc6`/`loc4` are `[[locator,
sharePercent]]`, biggest first. It is optional at runtime
(`buildLocationIndex(data, areas)`); `tests/location-areas.test.mjs` covers
it.

`data/vienna-map.json` is built by `scripts/build_map_data.py` (schema 1).
It contains `bounds`, `districts[{nr, name, label:[lat,lon], rings}]`,
`water[{name, rings}]`, `roads[{c: motorway|trunk|primary|secondary, p}]`
and `meta`. All coordinates are `[lat, lon]` (Leaflet order), rounded to
5 decimals.

## Map rules

- **Never** use `L.tileLayer`, `L.imageOverlay`, `L.icon` or a default
  `L.marker`, because each of those requests images or tiles. Markers must
  use `L.divIcon`. `tests/confirm-offline.test.mjs` checks this.
- Keep Leaflet's layer-toggle PNG disabled in CSS
  (`.leaflet-control-layers-toggle{ background-image:none }`).
- `vendor/` holds unmodified third-party code and is exempt from the
  external-URL scan. Don't put our own code there.

## Verify a change

1. Run `just test` (from `oe1ebg/`).
2. Run `just build-confirm && uv run zensical build --clean`, then serve
   `site/` and open `/confirm/`. Check these:
   - logging, plus a repeat check-in (the warning box and the `2×` badge);
   - an operator comment via `!` and an automatic marker from an operator
     change in the header (banner rows; not counted in Stationen/Check-ins);
   - an edit followed by a delete and undo;
   - reload while a line is half-typed (the draft must come back);
   - two tabs on the same event (the second must be read-only);
   - CSV, ADIF and KML export (KML = the map's stations: `toKML()` uses
     `stationsForMap()` from `js/mapdata.js`, keep it that way);
   - Standortsuche: the Google Maps / OpenStreetMap links show online and
     disappear with DevTools → Offline;
   - DevTools → Network → Offline, then reload and log a line;
   - open `confirm-offline.html` via `file://`.
