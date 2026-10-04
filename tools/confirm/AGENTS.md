# AGENTS.md — Bestätigungsverkehr (confirmation log)

This is the short, agent-facing guide. Design rationale and the feature list
are in `oe1ebg/confirm-README.md`.

## Rules to keep

- **Never add a runtime network dependency.** That means no `fetch()` to
  another host, no CDN `<script>`/`<link>`, no web fonts and no map tiles.
  Data must be produced at build time, under `data/`, and listed in the
  precache. `tests/confirm-offline.test.mjs` fails on any external URL.
  The one exception is `js/sources.js`: links to the datasets and licences
  shown in the footer, which are only `<a href>` targets and never fetched.
  The test also checks that this file contains no request APIs.
- **Never lose user data.** The IndexedDB schema is at v2; v2 added the
  `stations` store.
  - Writes go through `store.tx()`, and the UI may only show success after
    the promise resolves.
  - Edits store a revision first, and deletes are soft (`deleted`
    timestamp).
  - Schema changes need a new `DB_VERSION` plus a migration branch in
    `openIdb()`. Never delete or recreate stores.
- **Bundler limits.** `scripts/build_confirm.py` concatenates the `js/`
  modules into `confirm-offline.html`, so:
  - only use `import { … } from './x.js';`;
  - only put `export` in front of `function`/`const`/`let`/`class`;
  - keep top-level names unique across all modules.
- **DOM:** use `fill(node, ...children)` from `js/dom.js`, not
  `node.replaceChildren(...)` with arrays or `null`. `replaceChildren`
  renders an array as "[object HTMLLIElement]" and `null` as the text
  "null". That was the bug in the recycle bin and snapshot lists.
- **Completion dropdowns** use `popover(input, list)` from `js/dom.js`.
- **Relative paths only.** The directory is planned to move to `/tools/`
  later.

## Data

`data/callsigns-oe.json` is built by `scripts/fetch_callsigns.py` and holds
`{stand, source, calls: [[call, name, location], ...]}`. Keep it free of
street addresses. `js/data.js` loads every data file, so new data files only
need to be loaded through it; the service worker precache and the offline
bundle pick up `data/*.json` automatically.

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
- **Normalization** exists only in `js/location/normalize.js`.
- **Ranking changes** need the tests in
  `tests/location-search.test.mjs` updated. They run against a synthetic
  dataset (always) and against the real data (when it has been built).

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
   - an edit followed by a delete and undo;
   - reload while a line is half-typed (the draft must come back);
   - two tabs on the same event (the second must be read-only);
   - CSV and ADIF export;
   - DevTools → Network → Offline, then reload and log a line;
   - open `confirm-offline.html` via `file://`.
