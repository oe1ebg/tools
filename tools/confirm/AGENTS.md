# AGENTS.md — Confirm (Bestätigungsverkehr)

Apply the root `AGENTS.md` and read `tools/confirm/README.md` before editing.
Paths below are relative to the repository root. This guide contains the
Confirm-specific contracts; the README contains design and data schemas.

## Persistence and recovery

- `tools/confirm/js/db.js` owns the schema and migrations. Bump `DB_VERSION`
  for a schema change and extend its `upgrade()` callback; preserve older
  stores and migration branches. Shared storage behaviour is documented in
  `tools/shared/README.md`, “Storage contract”.
- Await the storage transaction before reporting success. Edits retain the
  replaced record as a revision; entries and logs are soft-deleted. Preserve
  transaction boundaries, draft recovery, snapshots, and the read-only
  second-tab behaviour described in the README, “Persistence”.
- Backup imports validate before writing, apply the whole file or part set atomically,
  and copy colliding logs with references remapped. Preserve old-data
  warnings and export/restore compatibility (`tools/confirm/js/backup.js`).
- `backupTexts()` and `groupParts()` / `combineBackupParts()` must preserve
  the root backup-parts contract before `planBackupImport()` applies the set.
- Edits, deletes, and restores must advance `updated` with `laterIso()`,
  including when the clock stalls or moves backwards; row reuse relies on it.
- “Gespeichert” requires a completed commit. A draft is not a saved entry;
  starting a download does not establish that a backup was retained. Keep
  UI/help and `docs/confirm-anleitung.md` consistent.

## Entry and export contracts

- An entry without `kind` is a check-in. `kind: 'comment'` entries have no
  callsign, sequence number, or check-in number. Use `liveCheckins()` and
  the existing counting/map helpers for stations and QSOs; `liveSorted()`
  includes both kinds. Preserve old records and raw JSON backups.
- Comments stay out of ADIF, KML, and the map. CSV includes them only with
  `toCSV(..., { comments: true })`; the summary includes them and the
  operator shifts. Preserve the `!` shortcut and automatic header markers,
  including `flushMarkers()` after header changes and before saves, exports,
  and leaving a log.
  A marker may open for editing only with an empty form and header focus;
  never switch a form under an operator who is logging.
- ADIF export must remain ADIF 3.1.7-conformant. Non-callsign/non-locator
  header values belong in `COMMENT`, not `OPERATOR`/`MY_GRIDSQUARE`.
  Template mappings must not duplicate `ADIF_FIXED_FIELDS`. Preserve
  `adifIssues()` feedback before export and follow the root cross-check rule.
- KML uses `stationsForMap()` from `tools/confirm/js/mapdata.js`, so the
  exported stations match the map.
- UTMREF for found places is derived from stored coordinates; only typed
  UTMREF is retained as `loc.utm`. Exports use full precision. Preserve
  `ownUtm()` resolution and zone-less input using `utmRef()` (default 33U).
  See the README, “UTMREF”.

## Keyboard and DOM

- `renderLog()` reuses keyed rows through shared `syncRows()`. Any new
  displayed value must enter the row signature or shared context; context
  changes invalidate cached rows. Preserve focus and use `highlightMatches()`
  / `markEditing()` without rebuilding the table on every keystroke.
- Shift+Enter saves from any entry control; Enter advances with
  `focusNext()`. Preserve the corresponding header/new-log shortcuts.
- Keep field hints inside fixed-height `.ac-hints` slots and avoid extra
  Tab stops in them. Completion lists use shared `popover()`; list items
  are not Tab stops. Typo guesses use `{ enterPicksFirst: false }`, so Enter
  cannot replace valid input with a suggestion.
- Use shared `fill()` for arrays or nullable children; native
  `replaceChildren()` would stringify them. Follow the shared HTML rules.

## Offline data and map

- No runtime network dependency, including tiles or marker images.
  Dataset/licence/map URLs in `tools/shared/js/sources.js` are user-opened
  links. Keep online map links hidden offline through `mapLinks()` and
  `trackOnline()`; XML namespace identifiers are not network dependencies.
- Load built data with a string literal `loadDataFile('name.json')`.
  `scripts/offline_tool.py` discovers those literals, imported modules, and
  `CONFIRM-VENDOR` assets for precaching and single-file inlining. Keep
  `fileHidden` links hidden under `file://`, vendor licences in the
  `CONFIRM-LICENSES` footer, and the download size label accurate.
- The footer commit is generated in `build-info.js` from `GIT_SHA`; keep it
  out of `precache.js` and the content hash, so unrelated commits do not
  trigger updates.
- Callbook data must contain no street addresses. Repeater `out` is output,
  `in` is input, and shift is `in - out`.
- Location data formats and compatibility live in the README, “Location
  lookup”. Bump `schema` and update `buildLocationIndex()` when changing a
  format. Normalization belongs in shared `location/normalize.js`; query
  structure belongs in `location/query.js`. Austria areas are built from
  `data-src/austria-areas.json`; refresh the snapshot intentionally.
- Ranking changes need synthetic tests and a real-data gold-set evaluation.
  `just eval-location` must not regress the per-category minimums or
  wrong-auto-selection cap. Add cases for observed misses and tighten
  improved ratchets in `tests/location-goldset.txt`.
- Use `L.divIcon`; never add `L.tileLayer`, `L.imageOverlay`, `L.icon`, or
  default markers. Keep Leaflet's layer-toggle PNG disabled in CSS. Keep
  vendored code unmodified and place our code outside vendor directories.

## Verification

Use the root verification matrix and select these checks by the change:

| Behaviour | Coverage |
| --- | --- |
| Records, comments, backup, exports | `tests/confirm-*.test.mjs`, `tests/backup-parts.test.mjs`; ADIF changes also require conformance/cross-checks |
| Location parsing/ranking | `tests/location-*.test.mjs`, built-data checks, `just eval-location` |
| Map, coordinates, UTMREF | Confirm map/export tests and shared geo/UTM tests |
| Entry, focus, draft, cross-tab UI | `tests/e2e/confirm.spec.mjs`, relevant storage/update specs; row reuse also needs `tests/rowcache.test.mjs` |
| Offline/build changes | Rebuild; offline Node tests and `tests/e2e/offline.spec.mjs`, served and `file://` |

For affected browser flows, verify repeat check-ins, comment/automatic
markers, edit/delete/undo, draft reload, second-tab read-only mode, and
exports. Offline changes also need an offline reload followed by entry,
online-link visibility, and the single-file bundle.

For performance changes use `just bench-ui --tool confirm`; see
`tools/adif/README.md`, “Responsiveness baselines”, for the measurement
procedure. Compare the same sizes, engines, viewports, and CPU throttling;
report responsiveness, DOM/heap cost, and preserved focus/entry behaviour.
Historical timing tables are in this file's git history, not acceptance
thresholds for a different machine or implementation.
