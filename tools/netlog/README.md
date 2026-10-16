# Netlog: notes for amateur radio nets

A standalone browser app for nets on a repeater or frequency. A participant
takes selective notes about the other stations and prepares what to say when
it is their turn; the net control station (NCS) keeps check-ins, speaking
order, rounds and handovers straight. Offline-first after the first load,
keyboard-first, single user, German and English.

The specification and acceptance criteria are issue
[#68](https://github.com/oe1ebg/tools/issues/68); a UI mockup is attached
there (a guide, not a contract). The MVP is delivered in four stacked pull
requests:

1. **Foundation** (this part): the app shell, both languages and the help,
   storage with versioned schema, one writing tab per session, sessions and
   series, participants with partial callsigns, status, flags, presence and
   roster order.
2. Live logging: rounds, contributions, the note editor and drafts, on-air
   response reminders, personal talking points, after-net tasks, My Turn.
3. NCS and navigation: handovers, Continuous Log, search, correction and
   undo in the UI, return navigation.
4. Release readiness: JSON backup/restore, privacy and deletion, station
   lookup links, the full acceptance suite.

## Using it

Open `tools/netlog/` from a server (HTTPS or `localhost`; the service worker
needs a secure context). After the first complete load it works offline,
including reloads (the chip says "offline bereit ✓" / "offline ready ✓"
only when every file is cached). There is no single-file `file://` version
yet (a follow-up).

- **Sessions & series.** "+ New session" starts at once: no series, number
  or reconstruction of earlier activity needed. Joining a running net:
  give the round it is in (say 4) and tick "joining a net that is already
  running"; no earlier rounds and no start time are invented. A series
  holds the name, description, usual schedule, default repeater and a
  default net control (only a suggestion). A new session of a series gets
  the next number suggested (one above the highest number given so far;
  missed dates are never counted), editable. The series' defaults are
  copied into the session, so later series edits never rewrite history.
  An ad-hoc session can be put into a series later (the select next to it
  in the list); its identity, notes and history stay.
- **Check-in** in the sidebar: callsign (also partial: `OE0QX?`, `?QXB`,
  or just `?`) and an optional name. Known identities from station
  profiles and earlier sessions are suggested; nothing is merged by
  itself. Enter in the callsign field goes to the name, Enter there checks
  in; the fields empty at once, so the next station can be typed while the
  first one saves.
- **The selected station** (Live Notes): status (active, paused/away,
  listening, unconfirmed, checked out), flags (wants to speak, short time
  only, reception problems, priority), "Correct callsign / name" inline,
  "Details" (QTH, locator, RST, member number, EchoLink, presence
  intervals). Checking out closes the presence interval; coming back opens
  a new one (a reentry). Correcting a callsign keeps the station's id, so
  everything recorded for it stays with it.
- **Order.** ↑/↓ in the sidebar change the roster order; Net Control has
  the planned speaking order. Neither ever changes the actual speaking
  history or starts a round.
- **Second tab.** Only one tab or window edits a session; another one shows
  it read-only with "Edit here" (which takes over; the first one turns
  read-only).

## Keyboard

Navigation mode (focus outside text fields) takes single keys without
modifiers; they never fire while typing, during an IME composition or with
Ctrl/⌘/Alt. Tab, Shift+Tab and the buttons can do everything as well. The
mode is shown in the toolbar ("Navigation" / "Editing").

| Key | Action |
| --- | --- |
| `j` / `k`, ↓ / ↑ | next / previous station (more lists in later parts) |
| `Enter` | open the focused station or item (native button activation) |
| `?` | help |
| `Esc` | close a popup first; in a field: leave editing, the text stays |

The full table of issue #68 (`n`, `r`, `m`, `/`, `p`, `x`, `b`) arrives with
the workspaces it belongs to. Editing-mode commands are configurable in the
help dialog (`js/keys.js`, pref `oe1ebg-netlog-keys`); a binding needs Ctrl
or ⌘, and Option/Alt combinations (they type characters on macOS), function
keys and the browser's own Ctrl/⌘ shortcuts are refused.

Row focus model: each roster row is one button, the station's navigation
surface (click or Enter opens it, `aria-current` marks the selected one,
only it is in the Tab order); `j`/`k` move between rows. Nested controls
(status, flags, reorder) are separate buttons and never navigate.

## Languages

German and English, everything in `js/lang-de.js` / `js/lang-en.js` (same
keys, `tests/netlog-i18n.test.mjs`). First use: German when the browser's
first language is German, otherwise English; the header switch changes it
at once (pref `oe1ebg-netlog-lang`) and keeps all input, focus and data. The
shared update/offline texts follow (`initOffline({ strings })`,
`setOfflineText()` in `../shared/js/offline.js`). Users' text (notes,
callsigns, names) is never translated. Shortcuts are the same in both.
Dates are ISO `YYYY-MM-DD`, times 24-hour `HH:MM` in UTC, labelled.

Terms: Live Notes / Live-Notizen, My Turn / Ich bin dran, Open Responses /
Offene Antworten, Round Notes / Rundennotizen, Net Control / Rundenleitung,
session / Sitzung (one net on one day), series / Serie, round / Runde.

## Data model

IndexedDB database `oe1ebg-netlog` (version 1, `js/db.js`) on the shared
`../shared/js/storage.js`. Every record has a stable `id` (`newId()`),
`created`, `updated` (`laterIso()`, strictly increasing per record) and,
where it can be deleted, `deleted` (ISO time or null: soft delete).
Records refer to each other by id only, never by callsign, text or list
position. Session-owned records carry `eventId` = the session's id (the
shared `eventId` index).

| Store | Record |
| --- | --- |
| `series` | `name`, `description`, `schedule`, `defaults { repeater, freq, mode, ncs }`, `numbering` (`sequential` / `none`) |
| `sessions` | `seriesId` or null, `number` or null, `name`, `date` (UTC), `own { call, base }`, `radio { repeater, freq, mode }`, `suggestedNcs` (copied), `start` / `end` (times, below), `joinedLate`, `currentRoundId`, `ncsId`, `lease` (the writing tab) |
| `profiles` | reusable station identity (`call`, `name`, `qth`, `locator`, `echolink`, `member`); a session never changes through a profile edit |
| `participants` | session-specific snapshot: `call` (as typed), `base` (matching identity), `unresolved`, `profileId`, `name`, `qth`, `locator`, `rst`, `echolink`, `member`, `status`, `flags { speak, short, reception, priority }`, `presence [{ from, to }]`, `rosterOrder`, `plannedOrder`, `checkinRoundId` |
| `rounds` | `number`, `order`, `topic`, `start` |
| `contributions`, `notes`, `items`, `turns` | used from part 2 (speaking turns, observations, responses/points/tasks, My Turn cycles) |
| `events` | timestamped facts: check-ins (`type: 'presence'`), status changes (`'status'`, `from`/`to`), later NCS handovers and round changes |
| `revisions` | every replaced version of a record (`store`, `recordId`, `record`, `at`) |
| `undo` | the undo history (below) |
| `drafts` | unfinished editor text: `id` = `<session>|<editor key>`, `text`, selection |
| `meta` | reserved |

**Times** are `{ iso, quality }`: `exact`, `estimated`, or `unknown` (then
`iso` is null). Nothing invents precision: a session joined late has an
unknown start.

**Callsigns.** `call` keeps what was typed (upper case, suffixes like `/P`
kept); `base` is the callsign part used for matching (`OE/DL0QXA/P` →
`DL0QXA`). A call with `?` or `*` (or empty) is unresolved and marked as
such; each run of placeholders stands for one or more unknown characters
when suggesting candidates (`model.js`, `callPattern()`).

**Orders** are separate fields: roster order, planned order, and (part 2)
the actual contribution order. Changing one never touches the others,
timestamps or round assignments.

Schema changes bump `NETLOG_SCHEMA.version` and extend `upgrade()`; older
stores and migration branches stay (data-preserving migrations).

## Storage, saving and recovery

- **IndexedDB only.** Without it (private mode, blocked storage) Netlog runs
  on an in-memory store (`js/memstore.js`), says in the banner and the save
  chip that nothing is stored, and the update banner names what an update
  would lose. There is no localStorage fallback: without Web Locks it could
  not keep two writing tabs apart.
- **Every change is one transaction** (`js/ops.js`, `runOp()` over
  `store.atomic()`): read, change, revisions of the replaced versions and
  the undo step commit together or not at all. A failed write (quota, a
  blocked or closed database) changes nothing; the input stays where it was
  typed and the banner says so (quota: what to do).
- **The save chip** (`js/status.js`): "saving…", "saved HH:MM:SS UTC" only
  after the commit, "NOT SAVED" after a failure, "draft kept" / "DRAFT NOT
  KEPT" for unfinished text, "read-only", "NOT STORED (memory only)". A
  change is announced to screen readers only where it matters, not on every
  autosave.
- **Before leaving or updating**, pending input is committed
  (`app.flush()`: station details typed but not yet saved are kept per
  station until they are). The update hook resolves `true` only when
  nothing typed is at risk; otherwise the shared update banner holds the
  update back (`../shared/README.md`, "Save hook"). Flushes also run on
  `visibilitychange` (hidden) and `pagehide`, not only on unload.
- **One writing tab per session.** With Web Locks the tab that opens a
  session holds `oe1ebg-netlog-session-<id>`; others are read-only until
  "Edit here" (steal). Without Web Locks a BroadcastChannel claim
  (`oe1ebg-netlog`) does the same between tabs that can hear each other.
  In both cases the writing tab stores its id in `session.lease`, and every
  write of the session checks it in the same transaction: a tab that
  missed the handover gets a `LeaseError` and turns read-only instead of
  overwriting (`js/lock.js`).
- **Undo** (`undo()` in `js/ops.js`): each step stores the before-images of
  the records it changed and their new `updated` stamps. Undo restores them
  only when every one is still as the step left it, otherwise it refuses
  and changes nothing; redo works the same way back. Restoring writes new
  versions (with revisions), so the undone state stays in the history; a
  record the step created is soft-deleted. A new change ends the redo
  history. The history is stored per session (at most 200 steps,
  `UNDO_MAX`), so it survives reloads; series edits have their own
  history. Drafts, the lease and the creation of a session are not undo
  steps. The undo commands in the UI come with part 3.

## App identity

`manifest.webmanifest`: `start_url` and `scope` `./`, no `id` (the identity
is the start URL, distinct per tool and deployment prefix,
`tests/e2e/pwa-identity.spec.mjs`). Service worker `sw.js` on the shared
`../shared/js/sw-core.js`, caches `tools-netlog-<version>`; `precache.js`
and `build-info.js` are generated by `scripts/build_netlog.py`
(`just build-netlog`).

## Stable identifiers

Never rename (root `README.md`, "Stable identifiers"):

| What | Name |
| --- | --- |
| IndexedDB database | `oe1ebg-netlog` |
| prefs (localStorage) | `oe1ebg-netlog-lang`, `oe1ebg-netlog-own-call`, `oe1ebg-netlog-ui`, `oe1ebg-netlog-keys` |
| BroadcastChannel | `oe1ebg-netlog` |
| Web Locks | `oe1ebg-netlog-session-<session id>` |
| service worker | `self.OE1EBG_SW = { prefix: 'tools-netlog', precache: 'NETLOG_PRECACHE' }` |
| globals | `NETLOG_BUILD`, `NETLOG_PRECACHE`, `NETLOG_STARTED`, `NETLOG_READY` |

`NETLOG_APP` exposes the page state to the browser tests; it is not an API.

## Code

| File | What |
| --- | --- |
| `js/app.js` | page controller: loading, routing (`#/`, `#/s/<session>/<view>`), rendering, `act()` (runs an op, the chip follows the commit), read-only, flush/update hook |
| `js/model.js` | pure model: callsigns, numbering, orders, presence (node-tested) |
| `js/ops.js` | every write, one transaction each, revisions, undo/redo, lease |
| `js/db.js` | the schema |
| `js/memstore.js` | in-memory backend (no IndexedDB; node tests) |
| `js/lock.js` | one writing tab per session |
| `js/status.js` | the save chip's state |
| `js/i18n.js`, `js/lang-de.js`, `js/lang-en.js` | languages |
| `js/keys.js` | keyboard model, editing commands |
| `js/keyed.js` | keyed list rendering that patches rows in place (focus, caret and scroll survive re-renders) |
| `js/roster.js` | sidebar roster, check-in, station head and details |
| `js/control.js` | Net Control |
| `js/sessions.js` | sessions & series |
| `js/help.js` | help dialog |

Plain ES modules following the bundler rules of `scripts/single_file.py`
(named imports, no `as`, no default exports, unique top-level names), so a
single-file version stays possible.

## Tests

- `tests/netlog-model.test.mjs`, `tests/netlog-ops.test.mjs`,
  `tests/netlog-i18n.test.mjs`, `tests/netlog-offline.test.mjs` (`just test`).
- `tests/e2e/netlog.spec.mjs`: languages, a session joined mid-net with a
  partial callsign resolved later and a series assigned afterwards,
  keyboard-only check-in and roster, the read-only second tab. Also in the
  shared specs: `offline-update.spec.mjs` (a failed save holds the update
  back), `pwa-identity.spec.mjs`, `header.spec.mjs`, `deploy.spec.mjs`.
- All examples and fixtures use synthetic callsigns (`OE0QX…`) and
  fictitious names.
