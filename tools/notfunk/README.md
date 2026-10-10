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
| Record layout | One record per message with the SKKM Meldeaufnahmeformular fields: direction, number, time, channel, from/to, subject, verbatim text, operator, remarks. Notfunk extras: the radio station (Gegenstelle) apart from the sender/addressee, frequency/relay, station and place of origin, filing time (relayed traffic), read-back, location of the event (Ort / Einsatzstelle), Bezug (answer, correction or addition to a number), distribution, the Meldesammelstelle's reference. | SKKM 4.10.1, E-31, ÖVSV § 6.7, ARENA |
| Numbering | `<station prefix>-<running number>` (e.g. `W1-007`), gapless per operation and prefix, never reused. Each device or station gets its own prefix, so logs from several devices merge without collisions. The staff's own number ("Referenz Meldesammelstelle / Geschäftsbuch-Nr.", `staffRef`) is a separate field, filled in once it is reported back, only to match the two lists; it is never called "Nr." or "GZ" in the tool. | #31; E-31 keeps GZ and ETB numbers separate too |
| Number safety | Taken only when saving, in the **same storage transaction** as the message and the counter (`shared/js/storage.js` `atomic()`). A failed save consumes nothing, and two tabs can't take the same number. The next number is max(counter, highest stored) + 1, so even a lost counter write never reuses one. A restore never lowers a counter. | `js/numbering.js`, tested |
| Time | Stored as ISO 8601 UTC. Typed, shown, printed and exported **only in Austrian local time** (`Europe/Vienna` via Intl, whatever the device's zone) in the staff-form format `TT.MM.JJJJ hh:mm`, no zone and no UTC: the zone (MESZ/MEZ) appears only in the hour that repeats when the clocks go back (last Sunday of October, 02:00–02:59), where the form asks which one is meant (`#m-zone`, preset to the occurrence nearer now). The CSV adds "Zeitstempel (ISO 8601)" with the offset (`2026-10-05T14:07:00+02:00`) for programs. A DTG isn't used: no Austrian civil source uses it. The message time is "Empfangen am" / "Gesendet am": a date and a time field (native `type=date` / `type=time`, values `YYYY-MM-DD` / `HH:MM`), prefilled at the first keystroke of a new message (so midnight and paper entries stay right), correctable; Stichzeit, Aufgabezeit and the handover times are times of day only, read as the latest such time at most 5 min after the message (or now), so after midnight the day before (`readClock()`); the time it was saved (`created`, "Erfasst am") is kept apart. | E-31; ARENA uses UTC |
| Urgency ("Dringlichkeit") | Provisional: Routine / Dringend / Notfall (IARU/ARENA precedences; keys `routine`/`priority`/`emergency`), plus "Stab herhören!": the box only *asks* for the announcement (`alarm`); the announcement itself is recorded with time and person (`alarmDone`), so a ticked box never pretends it happened. | No Austrian staff scheme exists; open question |
| Message type | Meldung / Auftrag / Frage / Anforderung / Lagemeldung | LFV Salzburg (Meldung/Befehl/Frage), SKKM special forms |
| Status | In the words of the direction. Eingang: erfasst → übergeben (to whom, when) → übernommen (by whom, when). Ausgang: zur Übertragung → übertragen (to which station, when, read back) → Empfang bestätigt (by whom, when); failed attempts / queries are logged without changing the status. Each step once, the handover never goes back; "beantwortet" comes from saving a reply and doesn't block recording the handover later. None of the steps means that an order in the text was carried out. Stored keys unchanged (`forwarded`, `acknowledged`), so older data reads as übergeben/übertragen and übernommen/Empfang bestätigt. | #31, handover note of Oct 2026 |
| Edits, deletes | Edits keep the previous version as a revision. Deletes are soft, and a deleted message keeps its number. | #31, ÖVSV § 6.7 (complete records) |
| Exports | **Geschäftsbuch CSV** (E-31 columns + Notfunk fields; `;` with BOM for Excel de-AT), JSON backup/restore. Planned: KMZ for messages with a location (#27). | E-31 forms |
| Print / PDF | Through the browser's print dialog ("Als PDF sichern"), no PDF library: an A4 layout (`@page`, the `.pf-*` rules in `style.css`). Three printouts: the **Meldeaufnahmeformular** of one message on **one A4 page** ("Fassung n" to match the edit history), the **message book** for a time range (Geschäftsbuch columns, header repeated on each page), and an **empty form** to print a stack of (number of copies in the print dialog). The form page has no page margin (`printview.js` sets the `@page` margin to 0 while it prints; not a named page, Safari ignores those), which keeps Chrome's and Edge's header/footer lines off it. The sheet is 276 mm high, sized for Safari: WebKit (macOS and iOS) prints 1 CSS px as 0.8 pt, so its A4 page is only 197 × 278 mm in CSS units, and a full 296 mm sheet spilled onto a second page; a dialog before the first print says to switch "Kopf- und Fußzeilen" off (can be turned off). A long text first gets tighter spacing, then a smaller font down to 10 pt (`fitForm()` measures the sheet off-screen); beyond that (about 2,500 characters) it flows over several pages with the number on each, and the dialog says so first. | E-31 forms; works offline and on iOS; handover note of Oct 2026 |
| Paper form design | White, thin lines, no filled areas (nothing depends on printed backgrounds; saves toner, works in black and white, also from the dark theme). On top: title, **↓ EINGANG \| ↑ AUSGANG** (the chosen one with a thick frame and ✕, the other pale), a big box for the Notfunk-Nr.; then one dashed row **"Nur von der Meldesammelstelle / dem Stab auszufüllen"** (Referenz / Geschäftsbuch-Nr., Federführend, Mitwirkend, Zur Kenntnis; only the reference is filled in); two narrow rows for Empfangen/Gesendet am (date · time, Erfasst), Übermittlung, Dringlichkeit (one joined block, "Stab herhören!" next to it) and Meldungsart; Von/An (with the Gegenstelle), Betreff/Ort/Bezug; the verbatim text takes the rest of the page; then Aufgenommen von, Anmerkungen, and the handover (Eingang) or transmission (Ausgang). A **circle** = choose one, a **square** = an extra mark. Frequency and relay stay in the book, not on paper. | common paper-form conventions; reviewed as a mockup (Oct 2026) |

## Using it

- **Einsätze:** an operation has a name, a **station code** (the number
  prefix, e.g. `W1`; one per device or station), the station's name, the
  operator, the **own post** ("Eigene Stelle", e.g. "Stab": recipient of
  incoming and sender of outgoing messages unless typed otherwise), and a
  default frequency/relay.
- **Einsatz panel** above the form (like the confirmation log's Header):
  name, station, operator (shift change), own post, frequency and relay
  can change at any time and apply to new messages; stored messages keep
  what they were saved with. An untouched form follows new defaults. The
  station code can only change while the operation has no message.
- **Entry form:** keyboard only, like the confirmation log: Tab/Enter next
  field (Enter in the text is a new line), digits pick an option,
  Shift+Enter or Ctrl/⌘+Enter saves. Required fields (`*`: time, Von, An,
  Betreff, Inhalt) block saving with the error at the field; warnings
  (no Gegenstelle, time in the future or more than an hour back, no
  read-back) ask once, saving again saves anyway. Esc closes suggestions
  first, then asks "Eingabe verwerfen?" for a filled form (Esc again =
  keep); "Rückgängig" after discarding. The next number is shown
  ("→ W1-008") but taken only on saving. Von/An/Gegenstelle/Ursprungsstation
  complete from the stations heard in this operation and the callsign
  list, Relais from the ÖVSV list, Ort / Einsatzstelle and Ursprungsort
  from the offline location lookup (which never changes the text).
  Frequencies take a comma or a point and are shown as `145,500`. The
  half-typed message is kept as a draft ("✓ Entwurf gesichert").
- **Help:** "? Hilfe", F1, or ? outside text fields opens a dialog with the
  keys, the flow, who is who, places, times, confirmations, numbers and
  urgency; Esc closes it and the focus goes back to the field. The
  manual with screenshots is `docs/notfunk-anleitung.md`
  (`/tools/notfunk-anleitung/`, linked from the header and the help; screenshots from
  `just screenshots`).
- **Book:** newest first, filters (offen, Eingang, Ausgang, Notfall +
  Dringend, search incl. the reference), the next status step as a button,
  an "Ausdruck" button per row; a summary says how many emergencies are
  open, how many aren't confirmed, and whether the numbers are gapless. The
  header shows the backup state ("Letzte Sicherung 14:40 · 3 Meldungen
  ungesichert", a click downloads a backup).
- **One message:** verbatim text, all fields, the flow (Ablauf) with a small
  form for the next step (to whom / by whom, when), failed attempts, the
  Meldesammelstelle's reference (an edit with a revision), the
  "Stab herhören!" announcement, replies ("Antwort erfassen" swaps Von/An
  and sets the Bezug; saving it marks the original "beantwortet"), earlier
  versions, print, delete (soft; the number stays taken) and restore.

## Code

- `index.html`, `style.css` (incl. the print layout), `sw.js` (on the shared
  `../shared/js/sw-core.js`), `manifest.webmanifest`, icons.
- `js/app.js`: the page (routing, views, form wiring, exports, printing).
- `js/db.js`: the storage schema (operations, messages, revisions,
  counters, drafts, stations).
- `js/form.js`: the entry form as data <-> message fields (pure, tested).
- `js/print.js`: what the printouts show (pure, tested);
  `js/printview.js` turns it into the print-only sheet and measures the
  one-page fit.
- `js/numbering.js`: message numbers (format, next number, atomic save,
  restore counters, gap check).
- `js/model.js`: the message record (fields, validation, edit with revision,
  soft delete, status steps per direction, attempts, the announcement,
  filters, time and frequency formatting).
- `js/export.js`: Geschäftsbuch CSV, JSON backup, restore merge (by id,
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
`notfunk-form.test.mjs` (form and printouts), `notfunk-offline.test.mjs`
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
   (Sofort/Blitz), ITU (MAYDAY/PAN PAN), or ARENA (E/P/R)? Should
   "Stab herhören!" messages be flagged?
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
