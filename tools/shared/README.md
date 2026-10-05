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
| `vendor/leaflet/` | Leaflet 1.9.4, unmodified (BSD-2) | confirm, sota-alerts |

## Rules

- **Plain ES modules, no dependencies, no DOM**, so `oe1ebg/tests/` can
  import them (`location-*.test.mjs`, `adif.test.mjs`, `geo.test.mjs`).
- **Bundler-compatible** (`scripts/single_file.py`): the single-file
  versions (`confirm-offline.html`, `adif-editor.html`) concatenate these
  modules with the tool's own. Use only `import { … } from './x.js';` /
  `'../x.js'` (no `as`, no default exports), only `export function|const|let|class`,
  and keep top-level names unique across everything one tool loads.
- **No runtime network access.** The confirmation log must work 100% offline,
  and `tests/confirm-offline.test.mjs` checks the shared modules for external
  URLs too.
- **Offline tools precache what they use.** `scripts/build_confirm.py` adds
  every shared module confirm imports (and the Leaflet files in its
  `CONFIRM-VENDOR` block) to `precache.js`. A new shared file that a tool
  loads some other way (e.g. `fetch`) must be added there by hand.
- A change here affects every tool listed above: run `just oe1ebg test` and
  check each user.
