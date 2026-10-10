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
- **Writes go through `js/ops.js`:** a new message is `saveNewMessage()`
  (number, message and the reply's "answered" status in one `atomic()`; the
  message id doubles as idempotency key, so a retry returns the committed
  message); every change of a stored message (edit, status, attempt, delete,
  restore, staff reference) is `updateMessage()`, a compare-and-set on
  `updated` that throws `ConflictError` instead of overwriting another
  tab's change, with the replaced record as the revision; a restore is
  `applyBackup()` (decision + writes in one `atomic()`, ids are global).
  After the number is committed nothing may make the message look unsaved
  (station completion and the redraw only warn). Backups are read from the
  storage, not from the tab's memory. Drafts carry `updated` and are
  compare-and-set per operation (another tab's draft is never overwritten
  silently). The compare-and-set token is `updated`, made strictly
  increasing per record (`bumpUpdated()`: clock, or previous + 1 ms), so two
  writes never share a token; the message format is unchanged. An edit
  draft stores its base (`editBaseOf()`: token and field values of the
  version it was opened on) and a restore checks against that, so a change
  made meanwhile is a conflict and only fields the user changed are sent.
  `parseBackup()` validates the whole file; keep it as strict as
  the model.
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
  the printout, the CSV and the manual (`docs/notfunk-anleitung.md`).
  Notfunk-Nr. and "Referenz Meldesammelstelle" are never mixed up. After
  visible changes re-run `just screenshots` for the manual.
- **Not in the oe1ebg.at nav** or llms.txt until the format is
  confirmed; the "Entwurf" banner stays until then.
- **Check changes** with `just test`, and in a browser with
  `just e2e` (or against the nginx image: `BASE_URL=…`).
