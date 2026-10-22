# AGENTS.md — Notfunk-Meldebuch

Apply the root `AGENTS.md` and read `tools/notfunk/README.md` before editing.
Paths below are relative to the repository root. The message format is
provisional until the Notfunkreferat Wien confirms it; preserve the draft
banner and draft labels wherever the tool is listed.

## Numbering and persistence

- Numbers are allocated only through `saveNewMessage()` in
  `tools/notfunk/js/ops.js`, which uses `saveNumbered()` from
  `tools/notfunk/js/numbering.js`. Message, counter, and a reply's answered
  status commit in one `store.atomic()` transaction. Never compute numbers
  in the UI, renumber edits, or reuse deleted numbers. Restore counters
  never decrease.
- Keep the new-message id as the idempotency key across retries. After a
  successful commit, completion or redraw failures must not make the
  message appear unsaved; report them as warnings.
- Stored message changes use `updateMessage()` (edit, status, transmission
  attempt, delete, restore, staff reference). Preserve compare-and-set on
  `updated`, `ConflictError`, and revisions of replaced records.
  `bumpUpdated()` keeps tokens strictly increasing even with equal or
  backwards clock readings; timestamps alone must not bypass conflicts.
- Draft writes/clears are compare-and-set per operation. An edit draft
  retains the opened record's token and fields through `editBaseOf()` and
  `draftEditState()`. Preserve conflict handling and `changedFields()`:
  send only the user's changes when applying an edit to the current record.
  Older drafts without a base require review before applying them.
- Soft-delete messages and retain revisions and the full message text,
  including inner whitespace and line breaks, under the model's existing
  normalization contract (README, ÖVSV Notfunk-Konzept § 6.7). Notfunk number and
  Meldesammelstelle reference are separate fields.

## Backup and status contracts

- Restore through `applyBackup()`: read existing state, decide the merge,
  and write within one transaction. IDs are global; an older backup must
  not undo newer edits/deletes. Conflicting numbers/ownership are reported,
  counters never go down.
- `parseBackup()` checks the whole input before writes. Preserve its
  distinction between file-rejecting identity/ownership errors and
  recoverable records listed in `dropped`/`droppedSeqs`; do not silently
  discard data or turn recovery warnings into blanket rejection.
- Backups normally read committed storage. If recovery uses the tab's
  memory because storage cannot be read, clearly label that snapshot.
  Preserve compatibility with previously stored/exported data.
- `toBackupTexts()` and `groupParts()` / `combineBackupParts()` must preserve
  the root backup-parts contract before one atomic `applyBackup()`. Reconstructed
  counters use the highest values. The Inhalt limit applies to changed text
  only (`keepText`), so restored long messages remain editable.
- “Gespeichert” requires the commit; a draft is not a saved message and
  may be lost. Backup status establishes only that a download started.
  Keep `NICHT GESPEICHERT`, `ENTWURF NICHT GESICHERT`, `ENTWURF PRÜFEN`,
  their actions, and update-wait behaviour aligned with UI/help and
  `docs/notfunk-anleitung/*.md`.

## Offline UI and print

- `renderBook()` reuses rows through shared `syncRows()`. Keep displayed
  values and captured message objects consistent with the row signature
  (`updated`, deletion, status steps). Preserve delegated row clicks, focus,
  keyboard order, pills, and ARIA; filtered-out rows leave the cache.
- Use shared storage, location/completion, data, and offline modules rather
  than copying Confirm code. Follow root offline/bundler rules and
  `tools/shared/README.md`; Notfunk does not inherit Confirm-specific
  counting, export, or keyboard contracts.
- Keep German wording consistent across the form, help, print, CSV, and
  manual. Regenerate affected manual screenshots with `just screenshots`.
- Print data is produced by `tools/notfunk/js/print.js` (`formSheet()`,
  `blankFormSheet()`, `bookSheet()`); every printout is a PDF written with
  the shared `pdf.js`, not browser print: the filled and the empty form by
  ONE drawing function in `tools/notfunk/js/paperpdf.js`, the book by
  `tools/notfunk/js/bookpdf.js`. Preserve E-31 field order and shared form
  labels. White, thin lines, no filled areas except the chosen circles.
  Text never leaves its cell (wrap, or shorten with "…" and repeat in full
  on a continuation page); a long Inhalt continues on further pages, a long
  book row splits across pages, nothing is truncated.

## Verification

Use the root verification matrix and the relevant coverage below:

| Behaviour | Coverage |
| --- | --- |
| Numbering/retries | `tests/notfunk-numbering.test.mjs`, `tests/notfunk-integrity.test.mjs` |
| Model, status, replies, time | `tests/notfunk-model.test.mjs`, `tests/notfunk-times.test.mjs` |
| Draft/conflict/backup recovery | Integrity tests, storage tests, `tests/backup-parts.test.mjs`, `tests/e2e/notfunk.spec.mjs` |
| Form/print/exports | `tests/notfunk-form.test.mjs`, `tests/notfunk-paperpdf.test.mjs` (form, Vordruck, book PDFs), `tests/pdf.test.mjs`, Notfunk browser specs; row reuse also needs `tests/rowcache.test.mjs` |
| Offline/update/bundling | Rebuild; `tests/notfunk-offline.test.mjs` and relevant offline/update browser specs |

Exercise the affected save/edit/status/reply, retry/conflict, draft reload,
backup restore, and print flows. Check served and `file://` variants for
offline changes. For performance work, run `just bench-ui --tool notfunk`
with comparable sizes, engines, viewports, and throttling; report search,
filter, save, and DOM/heap costs. The measurement procedure is in
`tools/adif/README.md`, “Responsiveness baselines”; historical timing tables
remain in git history rather than defining current thresholds.
