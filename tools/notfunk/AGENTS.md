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
- **Backups restorable (within limits).** The import limits (50 MB / 200000 records)
  should not make the tool's own export unrestorable: `toBackupTexts()` splits
  an export beyond them into parts (`part: { set, n, of }`) that
  `groupParts()` / `combineBackupParts()` put together for ONE atomic
  `applyBackup()`; never block an export or add a limit without a restore
  path (`tests/backup-parts.test.mjs`). Limits of the parts: the set is bounded too (12 parts, 480 MB, 1000000 records in total, `PARTS_*` in backup-parts.js; refused with a German message, nothing written); a single record larger than the per-file limit (Confirm has no text limit) is not split and can still not be restored; an older app version may import a lone part as a partial backup; parts import only into the same tool; an automatic multi-download may be blocked, so the status says N files were *started* (check all arrived) and the export/backup time is not recorded for parts. A changed message always gets a later
  `updated` (`laterIso()`): the row cache's signature relies on it. The
  Inhalt limit applies to changed text only (`keepText`), so a restored long
  message stays editable.
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
- **Saved vs draft vs backup:** "gespeichert" only after the commit, a draft
  is never called saved, "Download der Sicherung (JSON) gestartet" means a
  download was started, not that a copy is retained. The conflict/draft notices
  (`NICHT GESPEICHERT`, `ENTWURF NICHT GESICHERT`, `ENTWURF PRÜFEN`) and
  their buttons are quoted in the manual; change both together.
- **Not in the oe1ebg.at nav** or llms.txt until the format is
  confirmed; the "Entwurf" banner stays until then.
- **Check changes** with `just test`, and in a browser with
  `just e2e` (or against the nginx image: `BASE_URL=…`).

## Performance baselines (issue #15)

`just bench-ui --tool notfunk` (see `tools/adif/README.md`, "Responsiveness
baselines") seeds an Einsatz with 200 / 1000 / 5000 messages. Chromium,
desktop, median / p95:

| | 200 | 1000 | 5000 |
| --- | ---: | ---: | ---: |
| search: `renderBook` after the 150 ms debounce, 1x / 4x | 20 / 50 ms | 64 / 236 ms | 280 / 1222 ms |
| search -> next frame, 1x | 43 / 57 ms | 156 / 201 ms | 752 / 874 ms |
| ... 4x / 6x CPU | 125 / 217 ms | 601 / 992 ms | 3218 / 4806 ms |
| filter button -> next frame, 1x / 4x | 18 / 80 ms | 86 / 386 ms | 475 / 1814 ms |
| save message -> book updated, 1x / 4x | 45 / 176 ms | 199 / 819 ms | 1024 / 3983 ms |
| open book -> rows, 1x / 4x | 62 / 263 ms | 196 / 787 ms | 872 / 3557 ms |
| WebKit search -> frame, unthrottled | 69 ms | 264 ms | 1289 ms |

`renderBook` rebuilds every row (about 35 DOM nodes per message, 170k at 5000)
on each search, filter, save and status change; the layout and paint after the
rebuild cost about as much as the rebuild itself. Linear: ~0.15 ms per
message unthrottled.

### After keyed row reuse (issue #15)

`renderBook` keeps its rows (`tools/shared/js/rowcache.js`, `syncRows`): key =
message id, signature = `updated|deleted|status steps` (`updated` is the
compare-and-set token and changes on every write; a row's buttons capture the
message object of the render that built it, so a row may only be reused while
the signature is equal). A new or changed message builds one row, a search or
filter adds/moves/removes rows; rows filtered out are dropped from the cache
(so clearing a search builds them again). Sort order, filters, row-click
(delegated on `#book-body`), pills and ARIA are unchanged (tests/e2e/notfunk.spec.mjs
"search, filter and a status step keep the rows"). Chromium desktop, median /
p95, 2 runs, before in brackets:

| | 200 | 1000 | 5000 |
| --- | ---: | ---: | ---: |
| search -> next frame, 1x | 23.8 / 41.8 (43) | 50.6 / 108 (156) | 270 / 519 (752) |
| ... 4x CPU | 46.7 / 104 (125) | 211 / 502 (601) | 1088 / 2159 (3218) |
| ... WebKit desktop | 24 (69) | 101 (264) | 505 (1289) |
| `renderBook` after the debounce, 1x / 4x | 7 / 10 (20) | 12 / 41 (64) | 50 / 197 (280 / 1222) |
| filter click -> frame, 1x | 16 (18) | 68 (86) | 361 (475) |
| save message -> book updated, 1x | 23 (45) | 66 (199) | 273 (1024) |
| ... 4x CPU | 61 (176) | 236 (819) | 1225 (3983) |
| open book -> rows (unchanged: one full build) | 65 | 201 | 902 |
| heap after use / DOM nodes | 32 MB / 9k | 34 MB / 36k | 44 MB / 173k |

What is left at 5000 messages is the browser's layout and paint of 170k nodes
when many rows appear or go away at once (search text cleared = ~5000 rows
built again; filter changes likewise): the longest search task is 355 ms at 1x
(was ~750). Windowing the table was **not** added: it would have to keep the
keyboard order, the row buttons and the screen-reader table semantics for rows
that are not in the DOM, which is not a small change. The practical limit
stays about 1000 messages for comfortable use, 5000 usable (search answers in
~0.3 s on a desktop, 1.1 s at 4x CPU). `scripts/bench_ui.mjs` counts a search
that leaves the same rows (no DOM mutation) as done after 400 ms.
