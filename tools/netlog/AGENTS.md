# AGENTS.md — Netlog

Apply the root `AGENTS.md` and read `tools/netlog/README.md` before editing.
Issue #68 is the specification and the list of MVP release gates; the
mockup attached to it is a guide, not a contract. Paths are relative to the
repository root.

## Persistence

- `tools/netlog/js/db.js` owns the schema. Bump `NETLOG_SCHEMA.version` for
  a change and extend `upgrade()`; keep older stores and branches.
  IndexedDB only (`fallback: false`): never add a localStorage fallback
  without solving multiple writers where Web Locks are absent.
- Every write goes through an op in `tools/netlog/js/ops.js` (`runOp()`):
  one `store.atomic()` transaction that reads what it changes, writes
  revisions of the replaced versions and the undo step. Never write stores
  from the UI directly. Session writes check the lease (`meta`, `lease:<id>`); keep that
  check inside the transaction.
- `updated` comes from `laterIso()` (writer `put()`); undo relies on it as
  the compare token. Undo/redo refuse when a record changed since and then
  change nothing; keep the chain re-stamping in `undo()`.
- Soft-delete (`deleted`); permanent erasure is an explicit user action
  that also removes revisions, drafts and undo steps.
- "Saved" only after the commit (`app.act()` → `saveState.track()`). Input
  that could not be saved stays where it was typed and is retried by
  `app.flush()`; the update hook (`beforeReload`) resolves `true` only when
  nothing typed is at risk.

## Identity and order

- Reference records by id. Never by callsign, display text or index.
  Correcting a callsign keeps the participant id; historical snapshots in
  a session never change through a profile edit; candidates are only
  suggested, never merged automatically.
- Roster order, planned order and actual contributions are separate. A
  display reorder, NCS change or new note never creates a round or
  rewrites speaking history.
- Times are `{ iso, quality }`; never invent precision (unknown → null).

## UI

- All user-facing text through `t()` with keys in both `js/lang-de.js` and
  `js/lang-en.js` (same keys, `tests/netlog-i18n.test.mjs`); never
  translate user text. Dates/times ISO and 24-hour, UTC labelled; no
  `toLocale*`, no visible native date/time inputs (`isodate.js`).
- Render lists with `keyedList()` (`js/keyed.js`): rows are patched in
  place, never rebuilt while focused; keep focus, caret and scroll through
  autosaves and re-renders.
- Single-key commands only in navigation mode (`js/keys.js`); no new
  global character shortcuts beyond issue #68's table, no Option/Alt
  character combinations, no required function keys. Every command also
  reachable with Tab and buttons.
- Follow `tools/shared/README.md`, "HTML & interop rules": `el()`/`fill()`,
  no `innerHTML` with data, labelled controls, `aria-pressed` /
  `aria-expanded` / `aria-current` state.
- Synthetic callsigns (`OE0QX…`) and fictitious names in examples, tests
  and screenshots.

## Backup and erasure

- Backups go through `tools/netlog/js/backup.js`: `checkBackup()` before
  any write, `importBackup()` in one transaction, nothing stored is ever
  overwritten (clashes import a copy with every reference remapped; extend
  `REFS` in backup.js for every new reference field). Keep the export
  refusal beyond the limits before any download and the README's "Backup"
  section in step. A started download is not proof of a kept backup.
- Permanent erasure is explicit, explained in its confirmation and also
  removes revisions, drafts and undo steps that could hold copies.

## Offline and deployment

- No runtime network access. Station-lookup links (QRZ.com, HamQTH, …)
  are user-opened links only and live in `tools/netlog/js/links.js`
  (`tests/netlog-offline.test.mjs`).
- The inline load-failure script in `index.html` is allowed by hash in
  `deploy/nginx.conf.example` and `deploy/htaccess.example`; changing it
  needs both updated (`tests/deploy-headers.test.mjs` prints the hash).
- `precache.js` / `build-info.js` are generated (`just build-netlog`).

## Verification

| Behaviour | Coverage |
| --- | --- |
| Model, ordering, callsigns | `tests/netlog-model.test.mjs` |
| Statistics (definitions, identity, CSV, PDF) | `tests/netlog-stats*.test.mjs`, `tests/netlog-statspdf.test.mjs`, `tests/e2e/netlog-statistics.spec.mjs` |
| Ops, transactions, lease, undo, drafts | `tests/netlog-ops.test.mjs` |
| Languages | `tests/netlog-i18n.test.mjs` and the language test in `tests/e2e/netlog.spec.mjs` |
| Offline, precache, single-file bundle | `tests/netlog-offline.test.mjs`, `tests/e2e/offline-update.spec.mjs`, `tests/e2e/offline.spec.mjs` (`file://`), `tests/e2e/deploy.spec.mjs` |
| UI, keyboard, tabs | `tests/e2e/netlog.spec.mjs` (desktop and mobile projects) |
| Shared changes | every consumer's tests: `just test`, `just e2e` |
