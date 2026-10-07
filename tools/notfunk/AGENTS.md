# AGENTS.md — Notfunk-Meldebuch (emergency traffic log)

Draft (issue #31), published at `/tools/notfunk/` but not in the nav (only listed as a draft on the `/tools/` overview). Design, sources and open questions are in
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
- **Print:** the printouts are data (`js/print.js`, tested) rendered by
  `js/printview.js` into `#print-sheet`; the layout is the `.pf-*` rules in
  `style.css` (A4). A message must fit one page (the e2e test counts the
  PDF pages in Chromium): white, thin lines, no filled areas, nothing that
  depends on printed backgrounds. Keep the E-31 field order and the words
  of the web form (both use the same labels).
- **Words:** German, the same in the form, the help dialog (`index.html`),
  the printout, the CSV and the manual (`content/tools/notfunk-anleitung.md`).
  Notfunk-Nr. and "Referenz Meldesammelstelle" are never mixed up. After
  visible changes re-run `just oe1ebg screenshots` for the manual.
- **Not in the nav** (`zensical.toml`) or llms.txt until the format is
  confirmed; the "Entwurf" banner stays until then.
- **Check changes** with `just oe1ebg test`, and in a browser with
  `just oe1ebg e2e` (or against the nginx image: `BASE_URL=…`).
