# AGENTS.md — Notfunk-Nachrichtenbuch (emergency traffic log)

Work in progress (issue #31). Design, sources and open questions are in
`oe1ebg/tools/notfunk/README.md`. Read it first: the message format is
provisional until the Notfunkreferat Wien confirms it.

## Rules to keep

- **Message numbers are sacred.** Take them only via
  `saveNumbered()` (`js/numbering.js`), which writes the message and the
  counter in one `store.atomic()` transaction. Never compute or change a
  number anywhere else; `editMessage()` keeps prefix/seq/number. Restores
  go through `mergeBackup()` (counters never go down). The tests in
  `tests/notfunk-numbering.test.mjs` must keep passing.
- **Never lose data:** soft deletes only, edits store a revision, the full
  text is kept verbatim (ÖVSV Notfunk-Konzept § 6.7).
- **Offline only, shared code first:** same rules as the confirmation log
  (`../confirm/AGENTS.md`). Use `tools/shared/` (storage, location lookup,
  callbook, repeaters, data, Leaflet) instead of copying from `confirm/`.
- **Bundler rules** (`scripts/single_file.py`): `import { … } from './x.js'`
  only, `export` only on function/const/let/class, top-level names unique
  across all modules the tool loads (shared ones included).
- Until there is an `index.html`, `scripts/stage_tools.py` does not publish
  this directory.
