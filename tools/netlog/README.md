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

1. **Foundation**: the app shell, both languages and the help, storage
   with versioned schema, one writing tab per session, sessions and
   series, participants with partial callsigns, status, flags, presence and
   roster order.
2. **Live logging**: rounds, contributions, the note editor and drafts,
   on-air response reminders, personal talking points, after-net tasks,
   My Turn.
3. **NCS and navigation**: handovers, Continuous Log, search, merging and
   moving notes, undo/redo in the UI, return navigation across sessions.
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
- **Notes** (Live Notes, below the station): one item per observation, in
  the round sections of the station (newest round first; the current and
  the previous one expanded, how many is set in Net Control; a collapsed
  heading shows its notes and open responses). The composer sits at the end
  of the current round: Enter saves and keeps the composer ready for the
  next note (the field empties at once), Shift+Enter is a new line, an
  empty Enter saves nothing, an Enter that confirms an IME composition is
  no save. A saved note is edited in place; Enter or leaving the field
  saves the correction, which never moves the note (its position is a
  sequence number, its time stays). An emptied note is not saved (× deletes
  it). Unfinished text is a draft: kept per station and editor, restored
  with its caret after a switch or a reload.
- **Rounds** start only with "+ New round" (a dialog with the next number
  and an optional topic) or in Net Control, never by a note, a reorder or a
  return to the NCS. Net Control corrects round numbers and topics and can
  make another round the current one. "Spoke now" records a speaking turn
  (contribution) of the selected station; it is optional and may repeat.
  A new note belongs to its station's latest contribution in the round, if
  there is one.
- **On-air responses.** "○ response" (or `r` on a focused note, or
  Ctrl+Shift+Enter while typing it) flags a note for an answer on air; the
  observation stays as it is and an optional prepared reply goes in its own
  field. Unflagging only takes it out of the queue; flagging again brings
  back the same item with its reply (never a duplicate), also after it was
  completed. **After-net tasks** ("☐ after net", and a list with free
  tasks in Net Control) are separate: completing one never completes the
  response, and they never show in My Turn.
- **My Turn** (`m`): one page, responses first. *Open Responses*: every
  open response of this session (from any round) and the personal talking
  points, in your order (↑/↓), each with its station, observation, reply
  and a checkbox (or `x`). *Round Notes*: every note of the current round
  (`p` or the toggle: the previous round, also an empty one; in the first
  logged round there is none), grouped by station in speaking order,
  responses marked, replies not repeated. Opening My Turn starts a review
  cycle (a "turn") that survives navigation and reloads: completed items
  stay visible, subdued, until **End Turn**, which clears them (they stay
  in "Completed earlier") and keeps the open ones. Neither changes the
  round.
- **Going to a station and back.** A station or note link in My Turn (or
  Enter on a focused item) opens Live Notes at the source: the station, its
  round expanded, the note focused and highlighted. `b` (or "Back to Live
  Notes" / Back) returns to exactly where you were: workspace, summary
  round, scroll and focus; edits made meanwhile stay.
- **Net control.** "Make net control" in the station head, or ☆ NCS in
  Net Control, designates the current NCS (at most one; marked "NCS" in the
  roster). Every change is an event with the old and the new station (the
  first one has none; nothing earlier is invented). Net Control lists the
  handovers with their time (UTC `HH:MM`, "estimated" if heard late), which
  can be corrected (a revision, undoable). A series' usual net control is
  shown as a suggestion with a button, never assigned by itself.
- **Continuous Log**: all notes of the session in recorded order, by round
  (older rounds collapsed), each with its station. They are the same notes
  as in Live Notes: edit, flag, task, move, delete work the same, and the
  station link opens the note in Live Notes (Back returns). "Select notes"
  adds checkboxes for moving several at once.
- **Moving notes** ("Move…" on a note, or several from the log): to another
  station and/or round. Ids, times, the recorded order and the on-air
  responses and tasks stay with the notes (their station and round follow
  the note); counters and summaries follow at once. One undo step.
- **Correcting an identity into a station that is already checked in**
  (an `OE0QX?` that turned out to be OE0QXB) asks first, with a preview of
  what would move: merge (notes, speaking turns, events, presence intervals
  move over; the unresolved one is soft-deleted, `mergedInto`; undoable), or
  keep both separate. Nothing is ever merged without that confirmation.
- **Station profiles**: "Save as station profile" in the details keeps the
  identity and details for later sessions (suggested at check-in). A
  session keeps its own copy; editing a profile never changes a session.
- **Search** (`/`): offline, this session or all sessions, in everything or
  one field (callsigns also partial, names, QTH/locator, notes, prepared
  replies, talking points, after-net tasks). Each result names session,
  date, round and station. Enter (or a click) opens the exact match ready
  to edit (a collapsed round is expanded, the match highlighted); `b` goes
  back, also to the other session, with the unfinished input as it was.
- **Undo / Redo** (↶ ↷ in the toolbar, or Ctrl/⌘+Z and Ctrl/⌘+Shift+Z /
  Ctrl+Y outside text fields; inside a field the browser's own text undo
  applies): every change of the session, including note edits and moves,
  merges, round and status changes, flags and completions. The buttons name
  the step. See "Undo" below for its limits.
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
| `j` / `k`, ↓ / ↑ | next / previous station; in the notes and in My Turn: next / previous item |
| `Enter` | open the focused station (its composer), edit the focused note, open the source of a My Turn item |
| `n` | new note for the selected station |
| `r` | flag / unflag the focused note for an on-air response |
| `m` | My Turn |
| `p` | My Turn: current / previous round notes |
| `x` | My Turn: complete / reopen the focused item |
| `b` | back to where you came from |
| `/` | search |
| `?` | help |
| `Esc` | close a popup first; in a field: leave editing, the text stays |

Outside text fields Ctrl/⌘+Z undoes and Ctrl/⌘+Shift+Z (Ctrl+Y) redoes
(the toolbar buttons do the same). While typing: Enter saves a note or reply
and goes on, Shift+Enter is a new line, Ctrl+Shift+Enter (configurable)
flags the note. Editing-mode commands are configurable in the
help dialog (`js/keys.js`, pref `oe1ebg-netlog-keys`); a binding needs Ctrl
or ⌘, and Option/Alt combinations (they type characters on macOS), function
keys and the browser's own Ctrl/⌘ shortcuts are refused.

Row focus model: each roster row is one button, the station's navigation
surface (click or Enter opens it, `aria-current` marks the selected one,
only it is in the Tab order); `j`/`k` move between rows (and select, while
a pointer selects on its click). A note row, a My Turn item and a summary
note are `li` rows with `tabindex="-1"` that `j`/`k` focus; their text
fields, checkboxes and buttons act on their own and never navigate.

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
| `sessions` | `seriesId` or null, `number` or null, `name`, `date` (UTC), `own { call, base }`, `radio { repeater, freq, mode }`, `suggestedNcs` (copied), `start` / `end` (times, below), `joinedLate`, `currentRoundId`, `ncsId` |
| `profiles` | reusable station identity (`call`, `name`, `qth`, `locator`, `echolink`, `member`); a session never changes through a profile edit |
| `participants` | session-specific snapshot: `call` (as typed), `base` (matching identity), `unresolved`, `profileId`, `name`, `qth`, `locator`, `rst`, `echolink`, `member`, `status`, `flags { speak, short, reception, priority }`, `presence [{ from, to }]`, `rosterOrder`, `plannedOrder`, `checkinRoundId` |
| `rounds` | `number`, `order`, `topic`, `start` |
| `contributions` | a speaking turn: `participantId`, `roundId`, `seq`, `time` |
| `notes` | one observation: `participantId`, `roundId`, `contributionId` or null, `text`, `seq`, `time` |
| `items` | `kind`: `response` (a note's on-air reminder, `noteId`, prepared reply in `text`), `point` (personal talking point, no note) or `task` (after-net follow-up); `state` `open`/`done`, `active` (flagged), `order` (My Turn order), `history [{ state, at, turnId }]`, `doneTurnId` |
| `turns` | My Turn review cycles: `started`, `ended` |
| `events` | timestamped facts: check-ins (`type: 'presence'`), status changes (`'status'`, `from`/`to`), later NCS handovers and round changes |
| `revisions` | every replaced version of a record (`store`, `recordId`, `record`, `at`) |
| `undo` | the undo history (below) |
| `drafts` | unfinished editor text: `id` = `<session>|<editor key>`, `text`, selection |
| `meta` | `lease:<session id>`: the writing tab of a session (`tab`, `at`); a record of its own, so claiming it never changes the session |

**Times** are `{ iso, quality }`: `exact`, `estimated`, or `unknown` (then
`iso` is null). Nothing invents precision: a session joined late has an
unknown start.

**Callsigns.** `call` keeps what was typed (upper case, suffixes like `/P`
kept); `base` is the callsign part used for matching (`OE/DL0QXA/P` →
`DL0QXA`). A call with `?` or `*` (or empty) is unresolved and marked as
such; each run of placeholders stands for one or more unknown characters
when suggesting candidates (`model.js`, `callPattern()`).

**Orders** are separate fields: roster order, planned order, the My Turn
order of items, and the actual history, `seq`: one sequence per session
for notes and contributions (the next number is one above the highest,
deleted ones included). It is the chronological tie-breaker and never
changes with an edit. Changing a display order never touches it, the
timestamps or round assignments.

**Round summary** (`roundSummary()`): stations in the order of their first
contribution in the round (a station without one at its first note's
position), each once; notes by their contribution's position, then `seq`.

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
  In both cases the writing tab stores its id in the lease record
  (`meta`, `lease:<session id>`), and every
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
  steps. Boundaries: the history belongs to the session (series edits to
  the series list), survives reloads and is shared by whichever tab writes
  the session; a step that touched a record changed since (in another
  way) is refused with a message; text being typed is not a step until it
  is saved (the field's own undo applies until then); a later permanent
  erasure (part 4) also removes the history.

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
| `js/notes.js` | Live Notes: round sections, note rows, the composer |
| `js/drafts.js` | drafts of every editor: debounced writes, restore, commit chain |
| `js/myturn.js` | My Turn |
| `js/nav.js` | return navigation (origin stack, focus restore) |
| `js/clog.js` | Continuous Log |
| `js/search.js` | offline search (pure, node-tested) |
| `js/searchui.js` | the search dialog and opening a result |

Plain ES modules following the bundler rules of `scripts/single_file.py`
(named imports, no `as`, no default exports, unique top-level names), so a
single-file version stays possible.

## Tests

- `tests/netlog-model.test.mjs`, `tests/netlog-ops.test.mjs`,
  `tests/netlog-i18n.test.mjs`, `tests/netlog-offline.test.mjs` (`just test`).
- `tests/e2e/netlog.spec.mjs`: languages, a session joined mid-net with a
  partial callsign resolved later and a series assigned afterwards,
  keyboard-only check-in and roster, the read-only second tab, the note
  editor (Enter, Shift+Enter, empty and IME Enter, order through
  corrections, switches, collapse and reload), drafts, My Turn (queue
  contents and order, summary rounds, the first round, an empty round,
  source navigation and Back, completion through a reload, End Turn), net
  control handovers with time correction and undo/redo, presence and
  reorders that keep the speaking history, the Continuous Log with a bulk
  move and undo, search across sessions and back, the merge with preview
  and undo.
- `tests/netlog-search.test.mjs`: the search. Also in the
  shared specs: `offline-update.spec.mjs` (a failed save holds the update
  back), `pwa-identity.spec.mjs`, `header.spec.mjs`, `deploy.spec.mjs`.
- All examples and fixtures use synthetic callsigns (`OE0QX…`) and
  fictitious names.
