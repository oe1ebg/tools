# AGENTS.md — Bestätigungsverkehr (confirmation log)

This is the short, agent-facing guide. Design rationale and the feature list
are in `oe1ebg/confirm-README.md`.

## Rules to keep

- **Never add a runtime network dependency.** That means no `fetch()` to
  another host, no CDN `<script>`/`<link>`, no web fonts and no map tiles.
  Data must be produced at build time, under `data/`, and listed in the
  precache. `tests/confirm-offline.test.mjs` fails on any external URL.
- **Never lose user data.**
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
- **Relative paths only.** The directory is planned to move to `/tools/`
  later.

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
