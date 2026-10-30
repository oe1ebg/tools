# Notfunk-Meldebuch: emergency traffic log (draft)

An offline tool for ÖVSV Notfunk operators (focus: Vienna) to log emergency
radio traffic and hand the Krisenstab messages it can use without retyping.
Issue #31. Served at `/tools/notfunk/`.

**Name.** "Meldebuch" uses the staff vocabulary (Meldeaufnahme,
Meldesammelstelle) and, like Geschäftsbuch and Einsatztagebuch, says it is
the running record. No Austrian source names the radio station's own log;
"Geschäftsbuch" is avoided on purpose, since the staff keeps its own one
with its own Geschäftszahl.

**Status:** a working draft. Published at `/tools/notfunk/` with a banner
("Entwurf") and listed as a draft on the `/tools/` overview, but **not in
the site's nav** until the message
format is confirmed with the Notfunkreferat Wien and the Krisenstab side.
See [Open questions](#open-questions).

## Requirements (from #31)

- 100% offline, like the confirmation log: everything built at build time,
  a cache-first PWA with user-triggered updates, a single-file `file://`
  version, data in IndexedDB that is never hard-deleted, with edit history.
- Message numbers: gapless and monotonic per operation and station, never
  reused (not after deletes, edits or restores), and unambiguous with
  several stations or devices.
- A message format that works with a Krisenstab in Vienna (SKKM).
- Reuse the shared offline data and code (`tools/shared/`): location lookup
  (Vienna addresses, Austrian PLZ/Bezirke, Maidenhead), callsign list,
  repeater list, map, storage.

## Research: what the message format is based on

Sources were checked in October 2026. **[V]** marks things checked in the
source itself; everything else is inference.

### SKKM: Meldeaufnahmeformular, Geschäftsbuch, Einsatztagebuch

The governing document is the BMI/SKKM *Richtlinie für das Führen im
Katastropheneinsatz* (2nd edition, June 2026,
<https://www.bmi.gv.at/204/download/files/skkm-richtlinie-fuer-das-fuehren-im-katastropheneinsatz_bf_20260820.pdf>).
**[V]**

- **S6 (Kommunikation)** runs the **Meldesammelstelle**, the staff's central
  registry. Everything addressed to the staff goes through it, and so does
  everything going out. (4.5.7, 4.9)
- Anything received orally, by phone or **by radio** must be written down
  when it's received, on an analogue or digital **Meldeaufnahmeformular**. It
  is then logged in the **Geschäftsbuch**, and the Leiter der Stabsarbeit
  marks it ("Auszeichnung": which staff function leads, contributes or only
  takes note). (4.9)
- Fields the Meldeaufnahmeformular must have (4.10.1):
  - Eingang/Ausgang
  - date and time
  - running number from the Geschäftsbuch
  - channel (oral / phone / radio / other)
  - sender or addressee
  - subject and content
  - name and signature of the person taking or forwarding it
  - further action
  - completion notes
- There is **no "4-fach-Vordruck"** (unlike Germany), and no priority
  levels or date-time group (DTG) in the guideline.

The fire services' implementation, **ÖBFV Info E-31** "Behelf für die
Stabsarbeit im Feuerwehrdienst" (2022,
<https://www.bundesfeuerwehrverband.at/wp-content/uploads/2022/12/E-31-Info_2022.pdf>),
has concrete forms. **[V]**

- **Meldeaufnahmeformular** fields:
  - An, Von
  - Datum (TT.MM.JJJJ), Uhrzeit (hh:mm)
  - Tel. / Mobil / Fax / E-Mail / Funk / Anders
  - Betreff, Inhalt
  - Name/Unterschrift, Anmerkungen
  - "Geschäftszahl, Auszeichnung"

  The same form is used for outgoing messages.
- **Geschäftsbuch** columns: GZ, Datum, Uhrzeit, Ein/Aus, eingegangen von /
  weitergeleitet an, Betreff, Anmerkungen.
- **Einsatztagebuch** (S3): its own running numbers, which are **not**
  Geschäftszahlen.
- **Lagemeldung**: includes a *Stichzeit*, the time the situation report
  refers to.
- A received alarm message is announced with **"Stab herhören!"** (4.1.5).
  This is the only priority-like mechanism found in Austrian staff
  documents.

The NÖ Landesfeuerwehrverband's forms
(<https://www.noe122.at/service/downloads-und-formulare/katastrophenhilfsdienst>)
are similar. **[V]** They add separate **Ein-Nr./Aus-Nr.**, the radio call
name, and a distribution list ("Verteiler").

### Amateur radio side

- ÖVSV **Notfunk-Konzept** Teil 1 v1.3.3 (2020) **[V]**:
  - Emergency traffic must be documented **completely and verbatim**, and
    the records kept for at least 10 years. Electronic records are allowed.
  - Records go to the authorities on request.
  - Precedence: Notverkehr (MAYDAY) / Dringlichkeit (PAN PAN) / Sicherheit
    (SECURITÉ) / Routine.
  - LV1's 2019 slides quote AFV § 78g (3) with the same verbatim-recording
    duty (not checked against the RIS text).
- **ARENA Radiogram** (Message Handling v1.0, 2014; form v3, 2026; on
  <https://wiki.oevsv.at/wiki/Kategorie:NOTFUNK>) **[V]**:
  - IARU/ARRL-compatible header: number, precedence (Routine / Priority /
    Emergency; v3 adds Welfare), station of origin, check, place of origin,
    filing time and date in **UTC**.
  - Operator fields: received from / sent to.
- **Vienna** **[V]**:
  - Crisis management is the *Magistratsdirektion – Krisenmanagement und
    Sicherheit*, not MA 68.
  - The Notfunknetz Wien has four levels: Einsatzleitstelle, K-Vorsorge
    sites, Lichtinseln, all stations.
  - The Notfunkreferat Wien staffed twelve Lichtinseln in the 2024 blackout
    exercise.
  - **No public document says which format Vienna expects from Notfunk.**

## Design decisions (provisional until confirmed)

| Topic | Decision | Why |
| --- | --- | --- |
| Record layout | One record per message with the SKKM Meldeaufnahmeformular fields: direction, number, time, channel, from/to, subject, verbatim text, operator, remarks. Notfunk extras: the radio station (Funkstelle) apart from the sender/addressee, frequency/relay, station and place of origin, filing time (relayed traffic), read-back, location of the event (Ort), Bezug (answer, correction or addition to a number), distribution, the Meldesammelstelle's reference. | SKKM 4.10.1, E-31, ÖVSV § 6.7, ARENA |
| Numbering | `<station prefix>-<running number>` (e.g. `W1-007`), gapless per operation and prefix, never reused. Each device or station gets its own prefix, so logs from several devices merge without collisions. The staff's own number ("Referenz Meldesammelstelle / Geschäftsbuch-Nr.", `staffRef`) is a separate field, filled in once it is reported back, only to match the two lists; it is never called "Nr." or "GZ" in the tool. | #31; E-31 keeps GZ and ETB numbers separate too |
| Number safety | Taken only when saving, in the **same storage transaction** as the message and the counter (`shared/js/storage.js` `atomic()`). A failed save consumes nothing, and two tabs can't take the same number (on the localStorage fallback through its cross-tab write lock, which needs Web Locks; storage contract in `../shared/README.md`). The next number is max(counter, highest stored) + 1, so even a lost counter write never reuses one. A restore never lowers a counter. | `js/numbering.js`, tested |
| Time | Stored as ISO 8601 UTC. Typed, shown, printed and exported **only in Austrian local time** (`Europe/Vienna` via Intl, whatever the device's zone) as `YYYY-MM-DD hh:mm` (ISO 8601 date, 24-hour time; never the browser's locale, so no US month/day order and no AM/PM), no zone name and no UTC, anywhere (form, book, printouts; #153). Every time is an absolute instant (ISO 8601 UTC in `ts`, `stichzeit`, `origin.filed`, status `at`/`recorded`, attempts, `created`, `updated`), so nothing depends on the display. The hour that repeats when the clocks go back (last Sunday of October, 02:00–02:59) is resolved when a time is typed, without asking (`readDateTime()` in `js/form.js`; **to be confirmed by the maintainer**): if the reference time (now, or the saved time of the message) is itself in that hour, the typed time is the occurrence nearest to it; otherwise the first occurrence (summer time). An edit that leaves date and time as they are keeps the stored instant. In March the hour 02:00–02:59 does not exist: the field says so and asks for 03:00 or later (or 01:59 or earlier). The CSV adds "Zeitstempel (ISO 8601)" with the offset (`2026-10-05T14:07:00+02:00`) for programs, and the same for the handover ("Übergeben / übertragen um (ISO 8601)"), the receipt ("Empfang bestätigt um (ISO 8601)") and "Erfasst (ISO 8601)", as the last columns, because the wall-clock cells are ambiguous in the repeated hour. Drafts from before (a `zone` field) still restore; the field is dropped. A DTG isn't used: no Austrian civil source uses it. The message time is "Empfangen am" / "Gesendet am": a date and a time field (text in a fixed format, `YYYY-MM-DD` and `HH:MM`; `20261008`, `1405` and `14.05` are read too and shown formatted on leaving the field; native date/time inputs were dropped because they show the browser's locale, e.g. MM/DD/YYYY and AM/PM; instead `js/picker.js` adds a calendar (week from Monday) and a time grid (hours 00–23, minutes in steps of 5) with "Heute"/"Jetzt", same in every browser, opening on now when the field is empty; their buttons are no Tab stops), showing now and running with the clock (class `live`, grey) until the first keystroke of a new message, then kept (so midnight and paper entries stay right), correctable; a click into a date/time field opens its picker; the handover "Zeitpunkt" fields run with the clock the same way; Stichzeit, Aufgabezeit and the handover times are times of day only, read as the latest such time at most 5 min after the message (or now), so after midnight the day before (`readClock()`); the time it was saved (`created`, "Erfasst am") is kept apart. | E-31; ARENA uses UTC |
| Urgency ("Dringlichkeit") | Provisional: Routine / Dringend / Notfall (IARU/ARENA precedences; keys `routine`/`priority`/`emergency`). No "Stab herhören!" box: it was in earlier drafts (`alarm`, `alarmDone` with the announcement) and dropped as too much; such fields in old records are kept but not shown. | No Austrian staff scheme exists; open question |
| Message type | Meldung / Auftrag / Frage / Anforderung / Lagemeldung | LFV Salzburg (Meldung/Befehl/Frage), SKKM special forms |
| Status | In the words of the direction. Eingang: erfasst → übergeben (to whom, when) → übernommen (by whom, when). Ausgang: zur Übertragung → übertragen (to which station, when, read back) → Empfang bestätigt (by whom, when); failed attempts / queries are logged without changing the status. Each step once, the handover never goes back; "beantwortet" comes from saving a reply and doesn't block recording the handover later. None of the steps means that an order in the text was carried out. Stored keys unchanged (`forwarded`, `acknowledged`), so older data reads as übergeben/übertragen and übernommen/Empfang bestätigt. | #31, handover note of Oct 2026 |
| Edits, deletes | Edits keep the previous version as a revision. Deletes are soft, and a deleted message keeps its number. | #31, ÖVSV § 6.7 (complete records) |
| Exports | **Geschäftsbuch CSV** (E-31 columns + Notfunk fields; `;` with BOM for Excel de-AT), JSON backup/restore. Planned: KMZ for messages with a location (#27). | E-31 forms |
| Print / PDF | Every printout is a **PDF written by the app** without a library (`js/paperpdf.js` for the forms, `js/bookpdf.js` for the book, on the shared `shared/js/pdf.js`; Helvetica, WinAnsi), opened in a new tab (downloaded where the tab is blocked), printed from the PDF viewer. Not the browser's print engine: every engine scales, breaks and pads differently (WebKit prints 1 CSS px as 0.8 pt), a PDF prints the same at its own size everywhere, with no header/footer or scaling settings to get right. Three printouts: the **Meldeaufnahmeformular** of one message (A4 portrait, `meldebuch-<prefix>-<date>_<number>.pdf`, "Fassung n" to match the edit history), the **message book** for a time range (A4 landscape, `_Meldebuch.pdf`) and an **empty form** ("Vordruck", below). The form and the Vordruck come from ONE drawing function fed by `formSheet()` / `blankFormSheet()` in `print.js`. A long text is set in the largest of 12 / 11 / 10.5 / 10 pt that fits the Inhalt area; beyond that (about 1,500 characters) the form page ends with "Fortsetzung auf Seite 2" and continuation pages follow, each with Notfunk-Nr., Betreff and "Fortsetzung, Seite n von N". Text never leaves its cell: single-line values shrink, then are shortened with "…" and given in full on the last page. The book has the screen's columns (Nr. · Zeit with reference and Bezug, Gegenstelle with the direction as a drawn arrow, Betreff · Inhalt with the FULL text wrapped, Status with time and operator), header, column heads and "Seite n von N" on every page; a row that does not fit the rest of a page is split and continues with its number (`bookSheet()` supplies the rows). | E-31 forms; works offline and on iOS (also from `file://`); print engines differ |
| Empty form (Vordruck) | The same PDF writer and drawing function with nothing filled in ("Leeres Formular (PDF)" on the Einsatz list and in the book's print panel; `meldebuch-<prefix>-<date>_Vordruck.pdf`). Same fields and words as the filled form (`blankFormSheet()` in `print.js` gives the options, headings and footer), black thin lines on white; writing lines at least 10 mm apart, tick squares of 4.4–5.6 mm, each choice option a box of its own with the word (to cross or circle by hand, as the siren grades on Confirm's Leerformular); only the Einsatz's name and the print date are filled in, not the rest of its header (often printed before the Einsatz). | Confirm's Leerformular (same writer); print engines differ |
| Paper form design | White, thin lines, no filled areas (nothing depends on printed backgrounds; saves toner, works in black and white, also from the dark theme). On top: title, **↓ EINGANG \| ↑ AUSGANG** (the chosen one with a thick frame and ✕, the other pale; the chosen option of each choice is a filled circle), a big box for the Notfunk-Nr.; then one dashed row **"Nur von der Meldesammelstelle auszufüllen"** (Referenz / Geschäftsbuch-Nr., Federführend, Mitwirkend, Zur Kenntnis; only the reference is filled in); under the head every field of the Einsatz header, labelled (`einsatzFields()`; not on the empty form, printed before an Einsatz); Empfangen/Gesendet am (Datum and Uhrzeit side by side, Erfasst) | Dringlichkeit, then Übermittlung and Meldungsart each on a line of its own (every choice a circle and its word, no frames; nothing wraps); Von/An (with the Funkstelle), Betreff/Ort/Bezug (Betreff the left half, aligned with Von); the verbatim text takes the rest of the page; then Aufgenommen von, Anmerkungen, and the handover (Eingang) or transmission (Ausgang). A **circle** = choose one, a **square** = an extra mark. The book PDF marks Notfall (red label, row tinted) and Dringend (amber label) as on screen and frames those rows thick / medium, so they show on black-and-white printers too; its "Zeitraum" is always from–to with date and time ("(gesamter Einsatz)" without chosen bounds). | common paper-form conventions; reviewed as a mockup (Oct 2026) |

## Using it

- **Einsätze:** an operation has a name, a **station code** (the number
  prefix, e.g. `W1`; one per device or station), the own station's
  callsign ("Stationsrufzeichen", `call`, e.g. a club station; kept with
  every message as `stationCall`, like the operator), where the station
  is ("Standort der Station (Adresse)", `station`), the operator, the **own post** ("Für
  Stelle", `home`, e.g. "Stab": recipient of
  incoming and sender of outgoing messages unless typed otherwise), and a
  default frequency/relay.
- **Einsatz panel** above the form (like the confirmation log's Header):
  name, station, operator (shift change), own post, frequency and relay
  can change at any time and apply to new messages; stored messages keep
  what they were saved with. An untouched form follows new defaults. The
  station code can only change while the operation has no message.
  Esc in a field puts back the value it had when it got the focus
  (`revertOnEscape()` in `shared/js/dom.js`; an open suggestion list takes
  Esc first). "Rückgängig" puts the panel's fields back to what they were
  when the panel was opened or the book loaded (`takeOpUndo()`), as one
  `updateOp`; the station code stays once messages exist; a form that
  followed the defaults follows back (`applyOpPatch()`, shared with the
  fields). Another tab's change does not move that baseline.
- **Entry form:** keyboard only, like the confirmation log: Tab/Enter next
  field (Enter in the text is a new line), digits pick an option,
  Shift+Enter or Ctrl/⌘+Enter saves. Required fields (`*`: time, Von, An,
  Betreff, Inhalt) block saving with the error at the field; warnings
  (no Funkstelle, time in the future or more than an hour back; each also
  marked at its field, `fieldWarnings`) ask once,
  saving again saves anyway; the read-back box is optional and never
  asked for. Esc closes suggestions
  first, then asks "Eingabe verwerfen?" for a filled form (Esc again =
  keep); "Rückgängig" after discarding. The next number is shown
  ("→ W1-008") but taken only on saving. Von/An are free text (no
  callsign search); Funkstelle/Ursprungsstation complete from the
  stations heard in this operation and the callsign lists, Relais from the ÖVSV list, Ort and Ursprungsort
  from the offline location lookup (which never changes the text). An Ort
  the lookup doesn't resolve is stored as text (`locationText`; `''` when
  `location` holds the resolved snapshot, whose `input`/`label` keep the
  text). Messages saved before this kept no text for an unresolved Ort.
  **"Karte"** (in the filter bar, so the map opens right there, above the
  list; the form stays on top) shows the messages of the book's current list
  (filter, search) at their Ort on the shared offline map
  (`../shared/js/basemap.js`, `js/mapview.js`; which messages and where:
  `js/mapdata.js`, node-tested): one pin per place, coloured by the most
  pressing priority, a card with links to the messages; the own station
  ("Standort der Station") as the star. A stored Ort is used as stored; one
  kept only as text is looked up and shown only on a confident match.
  "📍 Standort" in the header opens the same offline location search as
  in Confirm (`initLocationPanel()`, shared `locationui.js`; the panel's
  settings are the shared location prefs, so they apply in both tools).
  Frequencies take a comma or a point and are shown as `145,500`. The
  half-typed message is kept as a draft ("✓ Entwurf gesichert").
- **Callsign lists** (issue #81). The lookup is the shared callsign service
  (`tools/shared/js/callsign-service.js`, see `tools/shared/README.md`,
  "Callsign store"): the Austrian list and the user's own lists, managed in
  the shared dialog opened from the footer ("Rufzeichenlisten – verwalten…",
  which says the lists are shared by all tools). They feed the completion
  of Funkstelle/Ursprungsstation and of the operator fields and the info
  lines under them; a value from a list other than the Austrian one is
  named ("(aus „X“)"). The own post ("Für Stelle", e.g. "Stab") still gets
  no guesses from the lists. The lists are read again when the window is
  looked at again.
- **Saved / draft / backup wording.** Same contract as the confirmation log
  (`../confirm/README.md`, Persistence). Notices in the banner, as of the
  storage/recovery work: "NICHT GESPEICHERT – … wurde inzwischen geändert"
  (compare-and-set conflict: nothing written, current version loaded, the
  input stays); "ENTWURF NICHT GESICHERT" (another tab holds another draft:
  keep mine / load the other); "ENTWURF PRÜFEN" (an edit draft of an older
  version: apply to the current version / discard, nothing is saved before
  the choice); "ENTWURF" (the edited message no longer exists: the draft
  would become a new message). A backup is read from the stored data, not the
  tab's memory (only when the storage is unreadable the tab's state is used,
  and the status says so); "Download der Sicherung (JSON) gestartet" means a
  download was started. A restore skips unusable records and lists them. Numbers are
  never reused; in the localStorage fallback without Web Locks (plain
  `http://`) two tabs can take the same number, a documented limitation. The
  manual describes all of this, with screenshots of the notices and of the
  update banner (`just screenshots`).
- **Help:** "? Hilfe", F1, or ? outside text fields opens a dialog with the
  keys, the flow, who is who, places, times, confirmations, numbers and
  urgency; Esc closes it and the focus goes back to the field. The
  manual with screenshots is `docs/notfunk-anleitung/` (start page
  `index.de.md` and sub pages in `tutorial/`, `manual/`, `reference/`, named `name.de.md`; `/tools/notfunk-anleitung/`,
  linked from the header and the help; screenshots from `just screenshots`,
  annotated pictures by `tests/e2e/annotate.mjs`, the paper form's by
  `scripts/make_vordruck_annotated.mjs`, committed in `docs/static/`).
- **Book:** newest first, filters (offen, Eingang, Ausgang, Notfall +
  Dringend, search incl. the reference), the next status step as a button,
  an "Ausdruck" button per row; the column names stay in view below the page
  header (`.sticky-head`, `trackSiteHeaderHeight()`; the wrapper clips, so
  from 641 to 1199 px, where the table (about 1060 px at its narrowest) does not fit, it scrolls sideways
  again and the names scroll with it; below 641 px the rows are cards); the
  Zeit cell has the full "2026-10-05 14:07" as title (Vienna time, no zone
  name, whatever the browser's zone) and shows its date when it is not the newest
  message's day (also the status time); the message in the form has
  `row-editing` (framed, ✎; `markEditing()` follows `state.editing` on the
  cached rows); on phones the sticky Save row (`.over-suggestions`) stays above
  an open suggestion list; a summary says how many emergencies are
  open, how many aren't confirmed, and whether the numbers are gapless. The
  header shows the backup state ("Sicherung gestartet 14:40 · 3 Meldungen
  ungesichert" or "… · nichts ungesichert", neutral, never "ok"-green; a
  click starts a backup download).
- **Book rows** (Variante D of a mockup, Oct 2026): Nr. with time, reference
  and "↪ Bezug"; the Gegenstelle only (↓/↑ and its name; the own side, the
  most common one in the book, only where a message differs); the type as a
  label, the priority when not routine, Betreff and two lines of text; the
  status pill (fixed width) with time and operator; the next step above
  Ausdruck. The step button opens a small dialog (`openStepDialog()`, the same
  inputs as the Ablauf's step form, `stepInputs()`): to whom / by whom with
  the names used in the Einsatz as suggestions, the time, and at an incoming
  takeover the Meldesammelstelle's reference.
- **One message:** the status line (type, direction, time), the Bezug under
  the subject, Von → An as on the paper form, the verbatim text, small
  blocks (Übermittlung, Ort, Stichzeit, Ursprung, Anmerkungen), the flow (Ablauf) with a small
  form for the next step (to whom / by whom, when), failed attempts, the
  Meldesammelstelle's reference (an edit with a revision), replies ("Antwort erfassen" swaps Von/An
  and sets the Bezug; saving it marks the original "beantwortet"), earlier
  versions, print, delete (soft; the number stays taken) and restore.

## Resource limits (issue #15)

A backup import is refused as a whole, with a German message and nothing
written: a file over 50 MB (`BACKUP_MAX_BYTES`, ~10x an operation of 5000
messages with revisions; checked from the file size before it is read), more
than 200000 messages and revisions together (`BACKUP_MAX_RECORDS`), a message
(there is no limit on texts in a file: a backup the tool wrote, revisions
included, must import again). `MESSAGE_TEXT_MAX` (50000 characters of Inhalt)
stops a message being saved in the form ("Inhalt ist zu
lang ..."); a radio message is a few hundred characters, the limit only stops
pasted files. It applies to the text typed now: an existing (restored or
imported) longer Inhalt stays editable as long as the Inhalt itself is not
changed (`validateMessage(f, { keepText })`, `formToFields(..., { keepText })`).
Imports stay atomic (`applyBackup`).

A backup the tool exports should be restorable, so an export beyond
these limits (e.g. 1100 messages of 50000 characters = 56 MB) is written in
**parts** (`toBackupTexts()`, `tools/shared/js/backup-parts.js`): each part
below 40 MB / 80000 records, named `..._teil-N-von-M.json`, a valid backup file
with an extra `part: { set, n, of }`, operation and counters in every part,
messages first and then the revisions. The import (`<input multiple>`) takes
the parts together: `groupParts()` checks the set is complete (a missing,
doubled or lone part writes nothing), `combineBackupParts()` puts them
together (counters: the highest), then the usual `checkBackup()` and ONE
atomic `applyBackup()`; ids, revisions and counters as exported. The limits
apply per file; a backup within them is one file as before. Limits: the set is bounded too (12 parts, 480 MB, 1000000 records in total; the per-part limits are chosen so that every split the export makes is within the set limits: 12 x 80000 <= 1000000, 12 x 40 MB = 480 MB; the import refuses a larger set with a German message and nothing written, and the EXPORT refuses it before anything is downloaded, "zu groß für eine einzige Sicherung", pointing to the individual operation's Geschäftsbuch CSV; never a partial set); a string longer than 1 Mi characters (a note, comment or Inhalt, also inside a revision) is cut out of its record for a split export and written as numbered chunks (`chunks: [{ kind, rid, path, n, of, data }]` at the top of the parts, `chunkRecord()` / `applyChunks()` in backup-parts.js) that `combineBackupParts()` puts back before the normal validation and atomic write, so a single huge text no longer has to fit one file (chunks count against the 12 parts / 480 MB / 1000000 records; a missing, doubled, inconsistent, orphaned or tampered chunk - wrong kind, a path with __proto__/constructor, a target that is not the empty placeholder - refuses the whole set with a German message "nichts importiert"); what still cannot be split - a record that stays beyond the per-file limit with no single string over 1 Mi characters (e.g. very many large fields) - is refused before anything is downloaded; an older app version may import a lone part as a partial backup and ignores `chunks` (long texts then stay empty), and a part may hold only chunks (no records); parts import only into the same tool; a blocked automatic multi-download is reported as "N files started, check that all arrived" and no export / backup time is recorded for parts. Test:
`tests/backup-parts.test.mjs`.

## App identity

The manifest has no `id` on purpose; see `../confirm/README.md`, "App identity" (#28), including the advice to back up both tools and not to delete site data when removing an old install.

## Code

- `index.html`, `style.css`, `sw.js` (on the shared
  `../shared/js/sw-core.js`), `manifest.webmanifest`, icons.
- `js/app.js`: the page (routing, views, form wiring, exports, printing).
- `js/db.js`: the storage schema (operations, messages, revisions,
  counters, drafts, stations).
- `js/form.js`: the entry form as data <-> message fields (pure, tested).
- `js/print.js`: what the printouts show (pure, tested);
  `js/paperpdf.js` writes the filled form and the empty one (Vordruck) as
  PDFs, `js/bookpdf.js` the book (shared `pdf.js`).
- `js/numbering.js`: message numbers (format, next number, atomic save,
  restore counters, gap check).
- `js/model.js`: the message record (fields, validation, edit with revision,
  soft delete, status steps per direction, attempts, the announcement,
  filters, time and frequency formatting).
- `js/export.js`: Geschäftsbuch CSV (spreadsheet-safe cells via
  `../shared/js/csv.js`, see `../shared/README.md`, "CSV exports"; the
  book's status line says how many got a leading `'`), JSON backup, restore merge (by id,
  newer `updated` wins, number clashes reported, counters never lowered).
- From `tools/shared/` (shared with the confirmation log): `storage.js`
  (IndexedDB, `atomic()` for the numbering), `offline.js` and `sw-core.js`
  (PWA and updates), `callsearch.js`, `repeaterui.js`, `locfield.js` and
  the location lookup, `callbook.js`, `time.js`, `sources.js`, `dom.js`,
  `prefs.js`, `css/forms.css`.
- `scripts/build_notfunk.py` (on `scripts/offline_tool.py`): `precache.js`,
  `build-info.js` and the single-file `notfunk-offline.html` (git-ignored).

The modules follow the single-file bundler rules (`scripts/single_file.py`):
only `import { … } from './x.js'` and unique top-level names.

Tests: `tests/notfunk-model.test.mjs`, `notfunk-numbering.test.mjs`,
`notfunk-form.test.mjs` (form and printouts), `notfunk-paperpdf.test.mjs` (the form, Vordruck and book PDFs), `notfunk-offline.test.mjs`
(no external URLs, bundle and precache); browser tests in
`tests/e2e/notfunk.spec.mjs` and `offline.spec.mjs`.

## Next steps

1. Confirm the open questions below with the Notfunkreferat Wien (and
   through them MD Krisenmanagement); adapt fields and wording.
2. Funkbuch (quick radio log) next to the message book.
3. Map view (offline basemap, messages by priority/status), KMZ export (#27).
4. Once confirmed: remove the "Entwurf" banner and the "(draft)" in the nav
   and on the tools overview.

## Open questions

To confirm with the Notfunkreferat Wien and the Krisenstab (MD-KS) side:

1. Does the MD-KS Einsatzstab or Einsatzleitstelle have its own
   Meldeaufnahmeformular or rules of procedure (layout, numbering)? Should
   Notfunk deliver on that form, or on its own?
2. Delivery: paper, PDF, CSV, or a staff software? How do messages get to
   the Meldesammelstelle (runner, printout, USB stick)?
3. Is a priority marking wanted? If so, in which wording: staff-style
   (Sofort/Blitz), ITU (MAYDAY/PAN PAN), or ARENA (E/P/R)?
4. Is a DTG used anywhere? (Documents for the staff are in local time for now; the CSV carries an ISO 8601 timestamp with offset.)
5. Numbering: confirm a Notfunk running number per station (K-Vorsorge
   site / Lichtinsel), next to the staff's Geschäftszahl. Which station code
   format?
6. Is the ARENA Radiogram the current Notfunk Wien standard for formal
   traffic, or only for HF/welfare traffic? Is the Notfunk-Konzept revision
   published?
7. Which identifiers should appear on messages: personal callsign, special
   callsign, location name, or SKKM station callsign?
8. Which standard templates are wanted from Lichtinseln and K-Vorsorge
   sites: Lagemeldung, Anforderung, Stärkemeldung, requests for help from
   the public?
9. Privacy versus retention: ÖVSV says keep records ≥ 10 years and hand them
   to the authorities. Does that fit the City's data-protection rules for
   personal data in welfare/emergency calls?
10. Is "Achtung Spruch" (verbatim plus read-back) the expected procedure on
    the Notfunknetz Wien? Should read-back be a required field?
