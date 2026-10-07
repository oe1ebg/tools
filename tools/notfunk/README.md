# Notfunk-Meldebuch: emergency traffic log (draft)

An offline tool for ÖVSV Notfunk operators (focus: Vienna) to log emergency
radio traffic and hand the Krisenstab messages it can use without retyping.
Issue #31. Served at `/notfunk/`.

**Name.** "Meldebuch" uses the staff vocabulary (Meldeaufnahme,
Meldesammelstelle) and, like Geschäftsbuch and Einsatztagebuch, says it is
the running record. No Austrian source names the radio station's own log;
"Geschäftsbuch" is avoided on purpose, since the staff keeps its own one
with its own Geschäftszahl.

**Status:** a working draft. Published at `/notfunk/` with a banner
("Entwurf"), but **not in the site's nav or llms.txt** until the message
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
| Record layout | One record per message with the SKKM Meldeaufnahmeformular fields: direction, number, time, channel, from/to, subject, verbatim text, operator, remarks. Notfunk extras: frequency/relay, station and place of origin, filing time (relayed traffic), read-back, location, reply link, distribution. | SKKM 4.10.1, E-31, ÖVSV § 6.7, ARENA |
| Numbering | `<station prefix>-<running number>` (e.g. `W1-007`), gapless per operation and prefix, never reused. Each device or station gets its own prefix, so logs from several devices merge without collisions. The staff's own Geschäftszahl stays a separate field for the Meldesammelstelle. | #31; E-31 keeps GZ and ETB numbers separate too |
| Number safety | Taken only when saving, in the **same storage transaction** as the message and the counter (`shared/js/storage.js` `atomic()`). A failed save consumes nothing, and two tabs can't take the same number. The next number is max(counter, highest stored) + 1, so even a lost counter write never reuses one. A restore never lowers a counter. | `js/numbering.js`, tested |
| Time | Stored as ISO 8601 UTC. Shown and exported as Vienna local time in the staff-form format `TT.MM.JJJJ hh:mm` **with the zone** (MEZ/MESZ), plus a UTC column. A DTG isn't used: no Austrian civil source uses it. | E-31; ARENA uses UTC |
| Priority | Provisional: Routine / Priorität / Notfall (IARU/ARENA), plus a separate "Stab herhören!" alarm flag. | No Austrian staff scheme exists; open question |
| Message type | Meldung / Auftrag / Frage / Anforderung / Lagemeldung | LFV Salzburg (Meldung/Befehl/Frage), SKKM special forms |
| Status | erfasst → weitergeleitet → quittiert → beantwortet, forward only, each step with time and operator. Replies link to the message they answer. | #31 |
| Edits, deletes | Edits keep the previous version as a revision. Deletes are soft, and a deleted message keeps its number. | #31, ÖVSV § 6.7 (complete records) |
| Exports | **Geschäftsbuch CSV** (E-31 columns + Notfunk fields; `;` with BOM for Excel de-AT), JSON backup/restore. Planned: KMZ for messages with a location (#27). | E-31 forms |
| Print / PDF | Through the browser's print dialog ("Als PDF sichern"), no PDF library: an A4 layout (`@page`, `@media print` in `style.css`). Three printouts: the **Meldeaufnahmeformular** of one message (E-31 fields, an empty "Geschäftszahl, Auszeichnung" box for the staff, "Fassung n" to match the edit history), the **message book** for a time range (Geschäftsbuch columns, header repeated on each page), and an **empty form** to print a stack of for working without a device (number of copies in the print dialog). | E-31 forms; works offline and on iOS |
| Paper form design | The form says by its shapes what to mark, without extra words: a **circle** = choose exactly one (direction, channel, type, priority), a **square** = an extra mark (Stab herhören!, rückgelesen). The three priorities are one joined block; "Stab herhören!" sits apart in a heavy box. Eingang and Ausgang are two big halves side by side with an arrow. A printed message uses the same shapes, filled (the chosen half or priority inverted). | common paper-form conventions; readable without explanation |

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
  field, digits pick an option, Shift+Enter saves, Esc discards (with
  "Rückgängig"). The next number is shown ("→ W1-008") but taken only on
  saving. Von/An complete from the stations heard in this operation and the
  callsign list, Relais from the ÖVSV list, Standort from the offline
  location lookup. The half-typed message is kept as a draft.
- **Book:** newest first, filters (offen, Eingang, Ausgang, Notfall +
  Priorität, search), the next status step as a button, an "Formular"
  button per row; a summary says how many emergencies are open, how many
  aren't acknowledged, and whether the numbers are gapless.
- **One message:** verbatim text, all fields, the status steps, replies
  ("Antwort erfassen" swaps Von/An and links the reply; saving it marks the
  original "beantwortet"), earlier versions, print, delete (soft; the
  number stays taken) and restore.

## Code

- `index.html`, `style.css` (incl. the print layout), `sw.js` (on the shared
  `../shared/js/sw-core.js`), `manifest.webmanifest`, icons.
- `js/app.js`: the page (routing, views, form wiring, exports, printing).
- `js/db.js`: the storage schema (operations, messages, revisions,
  counters, drafts, stations).
- `js/form.js`: the entry form as data <-> message fields (pure, tested).
- `js/print.js`: what the printouts show (pure, tested);
  `js/printview.js` turns it into the print-only sheet.
- `js/numbering.js`: message numbers (format, next number, atomic save,
  restore counters, gap check).
- `js/model.js`: the message record (fields, validation, edit with revision,
  soft delete, status, filters, time formatting).
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
4. Once confirmed: `nav`/llms.txt entries and the data-sources page (#29),
   remove the "Entwurf" banner.

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
4. Local time or UTC on documents for the staff? Is a DTG used?
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
