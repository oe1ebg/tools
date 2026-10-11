# AGENTS.md — Bestätigungsverkehr (confirmation log)

This is the short, agent-facing guide. Design rationale and the feature list
are in `oe1ebg/tools/confirm/README.md`.

## Rules to keep

- **Never add a runtime network dependency.** That means no `fetch()` to
  another host, no CDN `<script>`/`<link>`, no web fonts and no map tiles.
  Data must be produced at build time, under `tools/shared/data/`, and
  listed in the precache. `tests/confirm-offline.test.mjs` fails on any external URL.
  The one exception is `tools/shared/js/sources.js`: dataset/licence links (footer) and
  map links (Google Maps / OpenStreetMap, built by `mapLinkUrls()`), which
  are only `<a href>` targets and never fetched. The test also checks that
  this file contains no request APIs. Map links are rendered via
  `mapLinks()` with class `online-only`, hidden while offline
  (`trackOnline()` sets `html.offline`). XML namespace identifiers (SVG,
  KML) are allowed by the test's `XML_NAMESPACES`.
- **`confirm-offline.html` needs nothing outside itself.** Vendored code
  needs a `LICENSE` next to it (inlined into the footer at the
  `CONFIRM-LICENSES` marker); relative links (`../…`) are hidden under
  `file://` (the `fileHidden` list passed to `initOffline()`,
  `tools/shared/js/offline.js`); keep the "~N MB" next to the download link
  in step with the file (the test checks it).
- **Never lose user data.** The IndexedDB schema (`js/db.js`, on top of
  `tools/shared/js/storage.js`) is at v2; v2 added the `stations` store.
  - Writes go through `store.tx()`, and the UI may only show success after
    the promise resolves.
  - Edits store a revision first, and deletes are soft (`deleted`
    timestamp).
  - Schema changes need a new `DB_VERSION` plus a migration branch in
    `openIdb()`. Never delete or recreate stores.
- **Bundler limits.** `scripts/build_confirm.py` (via `scripts/offline_tool.py`) concatenates the `js/`
  modules and the `tools/shared/` modules they import into
  `confirm-offline.html` (`scripts/single_file.py`), so:
  - only use `import { … } from './x.js';` (or `'../…'`), no `as`;
  - only put `export` in front of `function`/`const`/`let`/`class`;
  - keep top-level names unique across all modules, the shared ones included.
- **Shared code** (`tools/shared/`: location lookup and field, callsign and
  repeater completion, time helpers, offline/update code and the service
  worker logic, form styles, Maidenhead, distance, ADIF encoding, Leaflet)
  is used by other tools too. Change it with them in
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
- **Markup:** follow "HTML & interop rules" in `tools/shared/README.md`
  (checked by `tests/tools-html.test.mjs`). CSS goes in `style.css`,
  which builds on `tools/shared/css/tools.css`; `theme.js`, both
  stylesheets and Leaflet sit in the `CONFIRM-VENDOR` block, so they are
  precached and inlined into the offline file.
- **ADIF export** (`toADIF()`) must stay ADIF 3.1.7-conformant:
  `tests/confirm-adif-spec.test.mjs` runs every template through the strict
  reader in `tests/adif-spec.mjs`. Header values that aren't a callsign /
  locator go into `COMMENT`, never into `OPERATOR` / `MY_GRIDSQUARE`; a
  template field must not map onto a field in `ADIF_FIXED_FIELDS` (no field
  twice per record); `adifIssues()` lists what a logbook program would
  reject, shown before the download.
- **Relative paths only.** The directory is planned to move to `/tools/`
  later.
- **Footer version** (`commit abc1234 · data <hash>`). The commit comes
  from `GIT_SHA` (Docker build arg / Justfile) and goes into the generated
  `build-info.js` (`self.CONFIRM_BUILD`, inlined into the offline file).
  Keep it **out of `precache.js` and out of the content hash**. Otherwise
  every commit triggers a service-worker update. The commit link is
  built by `commitUrl()` in `tools/shared/js/sources.js`.
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

- **UTMREF** (issue #55, `tools/shared/js/utm.js`): computed from the
  stored lat/lon, never stored for found places; only a typed UTMREF is kept
  as typed (`loc.utm`, `type: 'utm'`). Exports always use full precision
  (`utmFields()` / `mgrsOf()`); the own position comes from `ownUtm()` in
  `js/export.js`, which resolves like the map. A zone-less input takes its
  zone from `utmRef()` (set by `app.js` from the log header), default 33U.
  Details: README "UTMREF".
- **Backups restorable (within limits).** The import limits (50 MB / 200000 records)
  should not make the tool's own export unrestorable: `backupTexts()` splits
  an export beyond them into parts (`part: { set, n, of }`) that the multi-file
  import puts together (`groupParts()`, `combineBackupParts()`) for ONE atomic
  `planBackupImport()` write; never block an export or add a limit without a
  restore path (`tests/backup-parts.test.mjs`). Limits of the parts: the set is bounded too (12 parts, 480 MB, 1000000 records in total, `PARTS_*` in backup-parts.js; refused with a German message, nothing written); a single record larger than the per-file limit (Confirm has no text limit) is not split and can still not be restored; an older app version may import a lone part as a partial backup; parts import only into the same tool; an automatic multi-download may be blocked, so the status says N files were *started* (check all arrived) and the export/backup time is not recorded for parts. An edited, deleted or restored
  line always gets a later `updated` (`laterIso()`): the log's row cache
  compares it (a stalled clock must not keep a stale row).
- **Saved / draft / backup wording:** "gespeichert" only after the commit; a
  draft is never called saved; "Sicherung" texts say a download was started,
  never that a backup is kept or safe; import is all-or-nothing, copy-on-
  import, old backups with warnings. The manual's section "Gespeichert,
  Entwurf und Sicherung" and the UI/help must say the same. Storage is per
  origin and plaintext (README "Persistence").

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
(schema 2). It contains `plz[]`, `streets[[name, start, count]]` (with
addresses contiguous per street), the per-address arrays
`hn`/`ap`/`ad`/`alat`/`alon` (integer 1e-5° offsets from
`latBase`/`lonBase`), `places[[name, category, lat, lon, alts, sources,
umland]]` (alts: `"name"` = alias or `["name", "c"|"h"|"g"]` =
colloquial/historical/generated; sources e.g. `"osm+gip"`; umland 0/1;
category OSM `key=value`, `gip:<NAMECAT_NAME>`, `stop` or `landmark`),
`districts`, `aliases[[alias, kind, id, type]]` (type `""`/`"c"`/`"h"`),
`families[[name, [street index, ...]]]`, `genericStreets[name, ...]` and
`meta` (sources and retrieval times per dataset). `buildLocationIndex()`
still reads schema 1 rows (missing fields = alias / osm / Vienna).

- **Changing the format:** bump `schema` and update `buildLocationIndex()`.
- **Normalization** exists only in `tools/shared/js/location/normalize.js`;
  free-text structure (position words, corners, category words) only in
  `query.js`.
- **Ranking changes** need the tests in
  `tests/location-search.test.mjs` / `location-freetext.test.mjs` updated
  (synthetic data, always run) and **`just eval-location` must not get
  worse**: `tests/location-goldset.test.mjs` enforces the gold set's
  per-category minimums and wrong-auto-selection cap on the real data.
  Tighten those ratchets in `tests/location-goldset.txt` when a change
  improves them; add a gold-set case for every miss found in practice.

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

1. Run `just test`.
2. Run `just build && just serve` and open
   http://localhost:8000/tools/confirm/. Check these:
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

## Performance baselines (issue #15)

`just bench-ui --tool confirm` (`scripts/bench_ui.mjs`, details and the other
tools in `tools/adif/README.md`, "Responsiveness baselines") seeds a log of
200 / 1000 / 5000 lines. Chromium, desktop, median / p95 (the phone viewport
is 10-40 % slower):

| | 200 | 1000 | 5000 |
| --- | ---: | ---: | ---: |
| keystroke in `#f-call` -> next frame, 1x | 24 / 30 ms | 107 / 138 ms | 535 / 678 ms |
| ... 4x CPU | 104 / 125 ms | 525 / 653 ms | 2474 / 3080 ms |
| ... 6x CPU | 146 / 192 ms | 672 / 855 ms | 3594 / 4435 ms |
| ... WebKit unthrottled | 52 ms | 245 ms | 1260 ms |
| save line -> new row shown, 1x / 4x | 31 / 127 ms | 147 / 688 ms | 745 / 3131 ms |
| open log -> all rows, 1x / 4x | 115 / 450 ms | 145 / 1338 ms | 574 / 2572 ms |
| DOM nodes / heap | 8k / 31 MB | 35k / 31 MB | 170k / 34 MB |

Each keystroke is one task of the same length (`updateCallFeedback` ->
`renderLog` rebuilds every row); the cost is linear, ~0.1 ms per line
unthrottled. Scrolling the page is fine up to 5000 lines unthrottled; at 4x on
a phone viewport 5-7 frames are > 50 ms.

### After the targeted updates (issue #15)

`updateCallFeedback` no longer calls `renderLog`: `highlightMatches(call)`
toggles the class `match` on the existing rows (index `rowsByCall`, built by
`renderLog`) and `markEditing()` the class `editing`. `renderLog` itself keeps
its rows between renders (`tools/shared/js/rowcache.js`, `syncRows`): key = line
id, signature = `updated|deleted|seq|check-in number|date shown`; the rows'
shared context (time mode, zone, read-only, UTM digits, template, callsign
list) resets the cache when it changes. A save or edit builds the changed
row(s) and leaves the others (and their focus) untouched. Any new thing a
row shows must go into the signature or the context. `renderLog` still walks
all lines (numbering, signatures, index): O(n) but ~100x cheaper than
building rows. Chromium desktop, median / p95, 2 runs, before in brackets:

| | 200 | 1000 | 5000 |
| --- | ---: | ---: | ---: |
| keystroke -> next frame, 1x | 16.7 / 18.9 (24) | 16.7 / 17.8 (107) | 16.9 / 18.2 (535) |
| ... 4x CPU | 16.7 / 18.4 (104) | 20.1 / 34.2 (525) | 68.7 / 79.8 (2474) |
| ... phone viewport 1x / 4x | 16.6 / 16.6 | 16.6 / 54.2 | 71.1 / 265 |
| ... WebKit desktop | 17 (52) | 17 (245) | 17 (1260) |
| keystroke handler (sync), 1x / 4x | 0.2 / 1.0 | 0.4 / 1.5 | 1.0 / 3.9 |
| save line -> new row shown, 1x | 19 (31) | 39 (147) | 156 (745) |
| ... 4x CPU | 43 (127) | 135 (688) | 627 (3131) |
| ... WebKit desktop | 13 | 29 | 120 |
| open log -> all rows, 1x (unchanged: one full build) | 104 | 156 | 593 |
| heap after use / DOM nodes | 32 MB / 8k | 33 MB / 35k | 36 MB (34) / 174k |

Tradeoffs: the row cache keeps one entry per line (a Map of node references,
the nodes are in the DOM anyway), +2 MB heap at 5000. The remaining cost of
a save at 5000 lines is the O(n) walk plus layout of the table; the phone
viewport's 71 ms keystroke frame at 5000 is style/paint of the long table, not
script (handler 1 ms). Not done: windowing the table (no measured need: scrolling
is fine unthrottled, the open still builds all rows once).
