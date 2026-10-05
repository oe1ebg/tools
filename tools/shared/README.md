# tools/shared/

Code and vendored libraries used by more than one tool. `scripts/stage_tools.py`
publishes this directory at `/shared/` like any tool directory (without this
README). The tools reference it by relative path (`../shared/…` from a
tool's `index.html`, `../../shared/…` from its `js/`), which resolves the same
way in `tools/` and on the site, so the node tests import the same files the
browser loads.

| Path | What | Used by |
| --- | --- | --- |
| `js/location/` | offline location lookup (Vienna addresses/landmarks, Austria-wide PLZ/Gemeinden/Bezirke); design in `../confirm/README.md` | confirm |
| `js/maidenhead.js` | Maidenhead locator ↔ WGS84 | confirm, location lookup |
| `js/geo.js` | haversine distance | confirm, location lookup, sota-alerts |
| `js/adif.js` | ADI parsing and field encoding | adif, confirm |
| `js/callbook.js` | Austrian callsign list: lookup, typo suggestions | confirm |
| `js/repeaters.js` | Austrian repeater search (callsign, site, frequency, locator, nearest) | confirm |
| `js/data.js` | `loadDataFile(name)`: `data/` files (fetched, or inlined in single-file bundles) | confirm |
| `js/storage.js` | IndexedDB storage with localStorage fallback; each tool passes its schema | confirm |
| `js/dom.js` | DOM helpers (`el`, `fill`, `popover`, …); the one DOM module | confirm |
| `data/` | build-time data, git-ignored (see below) | confirm |
| `vendor/leaflet/` | Leaflet 1.9.4, unmodified (BSD-2) | confirm, sota-alerts |

## Data (`data/`, generated)

Built by the `oe1ebg/scripts/` data steps (`just build-confirm` runs them
all), published at `/shared/data/`:

| File | Script |
| --- | --- |
| `callsigns-oe.json` | `fetch_callsigns.py` |
| `repeaters-at.json` | `fetch_repeaters.py` |
| `vienna-locations.json` | `build_location_data.py` |
| `austria-areas.json` | `build_austria_areas.py` |
| `vienna-map.json` | `build_map_data.py` |

Formats are documented in `../confirm/AGENTS.md`. Load them with
`loadDataFile('name.json')` and a string literal: the offline tools' build
scripts collect those literals to precache and inline exactly the files the
tool uses. `data.js` fetches `../shared/data/<name>`, relative to the page,
so it works for every tool published at `/<tool>/`.

## Rules

- **Plain ES modules, no dependencies, no DOM** (except `dom.js`), so
  `oe1ebg/tests/` can import them (`location-*.test.mjs`, `adif.test.mjs`, `geo.test.mjs`,
  `callbook.test.mjs`, `repeaters.test.mjs`).
- **Bundler-compatible** (`scripts/single_file.py`): the single-file
  versions (`confirm-offline.html`, `adif-editor.html`) concatenate these
  modules with the tool's own. Use only `import { … } from './x.js';` /
  `'../x.js'` (no `as`, no default exports), only `export function|const|let|class`,
  and keep top-level names unique across everything one tool loads.
- **No runtime network access.** The confirmation log must work 100% offline,
  and `tests/confirm-offline.test.mjs` checks the shared modules for external
  URLs too.
- **Offline tools precache what they use.** `scripts/build_confirm.py` adds
  every shared module confirm imports, the Leaflet files in its
  `CONFIRM-VENDOR` block and the `loadDataFile()` data files to
  `precache.js`. A shared file a tool loads some other way must be added
  there by hand.
- **Storage schemas belong to the tools.** `storage.js` is only the
  mechanism; a tool's database name, stores and migrations stay in the tool
  (e.g. `../confirm/js/db.js`). Never change one tool's schema from here.
- A change here affects every tool listed above: run `just oe1ebg test` and
  check each user.
