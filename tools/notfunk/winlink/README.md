# Winlink form pack „OE1 Notfunk Meldung“ (prototype, issue #179)

Sends a Meldung of the Notfunk-Meldebuch over Winlink as a form, so the
receiver sees the whole message (fields, Bezug, status history, attempts,
edits) and can take it into its own Meldebuch without retyping. The exchange
format is [FORMAT.md](FORMAT.md); it is binding for both sides.

| File | Role |
| --- | --- |
| `OE1_Notfunk_Meldung.txt` | template: `To:`, subject `<Dringlichkeit> <Nummer>: <Betreff>`, plain-text body |
| `OE1_Notfunk_Meldung_Initial.html` | input form: „Aus Meldebuch laden“ (the `.winlink.json` export, file or pasted) or manual entry |
| `OE1_Notfunk_Meldung_Viewer.html` | viewer: the full message from `meldung`, else the flat fields; „Für das Meldebuch“ copy/save |
| `README.txt` | operator instructions shipped in the zip (German) |

The bundle ships the pack only as `downloads/oe1-notfunk-meldung-winlink.zip`
(folder `OE1 Notfunk/`, built by `scripts/winlink_pack.py` from
`scripts/build_site.py`). The HTML files are not staged as pages and not
precached: they are Winlink artifacts (`http://{FormServer}:{FormPort}` is
not a URL until the client replaces it).

## Rules for editing the forms

- Standalone files: inline `<style>`/`<script>`, no external assets, ES2020,
  Safari 15.4 / Firefox 115 / Chrome 109 (Winlink Express opens forms in the
  system's default browser). Keep each file well under 25 KB.
- **ASCII only** (named entities in markup, `\u` escapes in scripts): the
  clients' handling of non-ASCII form files is not specified; ASCII survives
  any of them. The template is ASCII too.
- Pat and Winlink Express replace insertion tags in braces (`MsgSender`,
  `Date`, `Time`, `Callsign`, `GPS`, …, case-insensitive, spaces allowed)
  everywhere in the HTML, scripts included. Never write such a name in
  braces (e.g. destructuring `{ time }`) except the intended slots;
  `tests/notfunk-winlink.test.mjs` checks this.
- Only fields meant for the message have a `name`: every named field ends up
  in the XML attachment. The clients lower-case names and trim values.
- The viewer reads every value from a hidden `<textarea>` (RCDATA): Pat
  inserts values XML-escaped (`&#34;`, `&#xD;&#xA;`), Winlink Express
  presumably raw. Flat fields inserted raw could still end the textarea
  (`</textarea>` in a typed text); `meldung` cannot (`<` is escaped).
- Labels follow the Meldebuch: „Dringlichkeit“ (variable `prioritaet`),
  „Von (Absender)“, „An (Adressat)“, status words of `STATUS_WORDS`.

## Install

**Winlink Express:** copy the folder `OE1 Notfunk` with the three files to
`C:\RMS Express\Global Folders\Templates\OE1 Notfunk\` (or the Templates
folder of one callsign). New message → „Select Template“ → `OE1 Notfunk` →
`OE1_Notfunk_Meldung`.

**Pat:** copy the folder into Pat's forms directory, e.g.
`~/.local/share/pat/Standard_Forms/OE1 Notfunk/` (Linux, Raspberry Pi) or
`~/Library/Application Support/pat/Standard_Forms/OE1 Notfunk/` (macOS);
`pat env` shows `PAT_FORMS_PATH`. Pat finds subfolders by itself (no
restart needed). `pat templates update` / „Update forms“ only unzips the
Standard Forms over that directory: it does not delete other folders, so
`OE1 Notfunk/` survives (Pat v1.0.0, `internal/forms/unzip.go`). Web UI:
New message → Template → `OE1 Notfunk` → `OE1_Notfunk_Meldung`.

## Send

1. Meldebuch: export the message for Winlink (`<Nummer>.winlink.json`).
2. Open the form, „Aus Meldebuch laden“, choose the file (or paste its
   content), enter the recipient's Winlink address, „Nachricht erstellen“.
3. Winlink Express puts the message into the outbox; Pat fills its composer:
   „Send“ there. Transmission happens at the next connection.

Without the Meldebuch the same form takes the fields by hand (number, time
UTC, Dringlichkeit, Art, Von, An, Betreff, Inhalt, Bezug, and „Übung“,
checked by default).

**Exercise marker** (FORMAT.md): from the payload's `exercise` (missing =
exercise) or the manual checkbox, the form posts `kennung` = `[ÜBUNG]` and
`uebung` = `=== ACHTUNG ÜBUNG ===`. The template puts `kennung` before the
subject and `uebung` as the first body line and on its own line before and after the
Inhalt, each with a blank line; both forms show the banner „⚠ ACHTUNG ÜBUNG“ directly above the
text box (border, symbol and text; also in print and forced colours). Not an
exercise: both empty, nothing shown.

## Receive into the Meldebuch

Open the message; the client shows the viewer. Under „Für das Meldebuch“:
„Kopieren“ and paste in the Meldebuch's import, or „Speichern“
(`<Nummer>.winlink.json`). Pat's viewer runs in a sandbox without downloads:
„Speichern“ is disabled there; copy, or download the attachment
`RMS_Express_Form_OE1_Notfunk_Meldung_Viewer.xml` from the message (the
Meldebuch reads it too), or take the `.b2f` from Pat's mailbox
(`<mailbox>/<CALL>/in/<MID>.b2f`).

## Tested

With Pat v1.0.0 (sandbox, no connection): form catalogue, input form,
submit, composer data, outbox `.b2f`, viewer rendered from the received
attachment; recorded in `tests/fixtures/notfunk-winlink/pat/`. Winlink
Express itself is **not** tested yet: its raw substitution was only
simulated (viewer via `file://`).
