# Notfunk-Nachrichtenbuch: emergency traffic log (work in progress)

An offline tool for ÖVSV Notfunk operators (focus: Vienna) to log emergency
radio traffic and hand the Krisenstab messages it can use without retyping.
Issue #31. It will be served at `/notfunk/`.

**Status:** research done, data model, numbering and exports implemented and
tested (`js/`, `oe1ebg/tests/notfunk-*.test.mjs`). There is **no UI yet**
(no `index.html`, so `scripts/stage_tools.py` doesn't publish it). The
message format must first be confirmed with the Notfunkreferat Wien and the
Krisenstab side. See [Open questions](#open-questions).

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
| Exports | **Geschäftsbuch CSV** (E-31 columns + Notfunk fields; `;` with BOM for Excel de-AT), JSON backup/restore. Planned: printable Meldeaufnahmeformular per message (with an empty "Geschäftszahl, Auszeichnung" box for the staff), printable message book for a time range, KMZ for messages with a location (#27). | E-31 forms |

## Code

- `js/numbering.js`: message numbers (format, next number, atomic save,
  restore counters, gap check).
- `js/model.js`: the message record (fields, validation, edit with revision,
  soft delete, status, filters, time formatting).
- `js/export.js`: Geschäftsbuch CSV, JSON backup, restore merge (by id,
  newer `updated` wins, number clashes reported, counters never lowered).
- From `tools/shared/js/`: `storage.js` (IndexedDB, plus `atomic()`
  read-modify-write added for the numbering); the location lookup, callbook,
  repeaters and data loader are there for the UI.

The modules follow the single-file bundler rules (`scripts/single_file.py`):
only `import { … } from './x.js'` and unique top-level names.

## Next steps

1. Confirm the open questions below with the Notfunkreferat Wien (and
   through them MD Krisenmanagement).
2. UI:
   - fast keyboard-only entry form (like the confirmation log)
   - message book with filters and status buttons
   - Funkbuch (quick radio log)
   - clock showing UTC and local time
3. Printable Meldeaufnahmeformular and message book.
4. PWA plus single-file bundle (a `build_notfunk.py` next to
   `build_confirm.py`).
5. Map view (offline basemap, messages by priority/status).
6. `nav`/llms.txt entries, and data sources on the data-sources page (#29).

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
