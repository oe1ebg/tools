# Winlink exchange format (prototype, issue #179)

Shared contract between the Meldebuch (`tools/notfunk/js/winlink.js`) and the
Winlink form pack (`tools/notfunk/winlink/`). Both sides must follow it exactly.

## Transport

The form „OE1 Notfunk Meldung“ (files `OE1_Notfunk_Meldung.txt`,
`OE1_Notfunk_Meldung_Initial.html`, `OE1_Notfunk_Meldung_Viewer.html`) posts its
fields to the Winlink client (Winlink Express or Pat). The client:

- builds subject and plain-text body from the `.txt` template (`<var x>` slots);
  the body is ISO-8859-1 in transit (umlauts fine, `€`, `„“`, emoji become `?`);
- attaches `RMS_Express_Form_OE1_Notfunk_Meldung_Viewer.xml` with **every**
  posted field under `<variables>`, names lower-cased, values trimmed and
  XML-escaped;
- on the receiving side opens the viewer with `{var name}` replaced by the
  value. Pat inserts the value **still XML-escaped** (`&amp;`, `&lt;`, `&#34;`, `&#xA;`);
  Winlink Express is assumed to insert it raw. The viewer therefore reads the
  payload from a `<textarea hidden>` (RCDATA: entities are decoded, raw text is
  kept), never from a `<script>` element.

## The payload: variable `meldung`

One form variable `meldung` carries the complete message as **compact JSON**,
written so that it survives every hop unchanged:

- ASCII only: every character above U+007E is written as `\uXXXX`
  (surrogate pairs for astral characters);
- `<`, `>`, `&` are written as `\u003c`, `\u003e`, `\u0026`;
- `{` is written as `\u007b` unless followed by `"` or `}` (Pat substitutes
  `{var x}` / `<var x>` one after another, so a value containing such text
  could be filled in by a later substitution); the form's serialiser uses
  `/[\u007f-\uffff<>&]|\{(?!["}])/g`;
- no line breaks (newlines inside strings are `\n` escapes anyway).

Multi-line flat fields arrive with CRLF (browsers submit forms that way);
readers normalise to LF.

Why JSON and not base64: base64 adds 33 % and defeats the LZH compression
Winlink applies in transit (B2F), while JSON compresses 3–4×. The `\u` escapes
cost a few percent on German text.

```json
{
  "format": "oe1ebg-notfunk-winlink",
  "version": 1,
  "app": "0.9.0",
  "exported": "2026-11-06T18:00:00Z",
  "exercise": true,
  "station": { "call": "OE1XYZ", "operation": "Übung Donau", "prefix": "W1", "operator": "OE1ABC" },
  "message": { /* the full message record, see below */ },
  "revisions": [ { "at": "…Z", "by": "OE1ABC", "old": { /* previous version, same shape as message */ } } ],
  "ref": null | { "id": "uuid", "number": "W1-003", "station": "OE1XYZ",
                  "source": null | { "id": "uuid", "number": "K-012", "station": "OE3ABC" } }
}
```

- `exercise`: the sending operation is an exercise (Übung). Missing means
  unknown and counts as an exercise (the safe side); only `false` drops the
  marker. Added within version 1: older readers ignore it.
- `format` and `version` are required. Readers accept every `version` ≤ their
  own and reject newer ones with a German message („Diese Meldung wurde mit
  einer neueren Version erstellt …“). Version 1 is this document.
- `message` is the stored record as it is: `id`, `number`, `prefix`, `seq`,
  every field of `messageFields()` (`tools/notfunk/js/model.js`), `operator`,
  `stationCall`, `status[]`, `attempts[]`, `created`, `updated`, `deleted`,
  `editedBy`, and `source` if the message itself was imported. `eventId` and
  `replyTo` are left out (local ids of the sender's book); the reference goes
  to `ref`.
- `revisions`: the message's revision records, oldest first, without their
  local `id`/`eventId`/`messageId`; `old` without `eventId`/`replyTo`.
- `ref`: the message this one refers to (Bezug), if `replyTo` is set:
  its `id`, `number`, `stationCall` as `station`, and that message's own
  `source` (`id`, `number`, `station`) when it was imported. `refKind` and
  `refNumber` stay in `message`.

## Flat fields (body, Winlink clients without the form, other tools)

Posted next to `meldung`, filled from it by „Aus Meldebuch laden“ or typed by
hand when the form is used without the Meldebuch:

| variable | content |
| --- | --- |
| `msgto` | recipient's Winlink address (callsign or e-mail), used in `To:` |
| `nummer` | message number, e.g. `W1-007` |
| `prioritaet` | `Routine` / `Dringend` / `Notfall` |
| `art` | Meldung / Auftrag / Frage / Anforderung / Lagemeldung |
| `von`, `an` | sender and addressee as `Name / CALL` |
| `betreff` | subject |
| `inhalt` | message text |
| `zeit` | time `YYYY-MM-DD HH:MM UTC` |
| `bezug` | e.g. `Antwort auf W1-003 (OE1XYZ)` |
| `station` | sending station callsign |
| `verlauf` | status history as text lines (`YYYY-MM-DD HH:MM UTC übertragen an OE3ABC`) |
| `kennung` | `[ÜBUNG]` for an exercise, else empty (subject prefix) |
| `uebung` | `=== ACHTUNG ÜBUNG ===` for an exercise, else empty (body) |
| `format_version` | `1` |
| `templateversion` | form version, e.g. `OE1 Notfunk Meldung 1.0` |

Subject (template): `<kennung> <prioritaet> <nummer>: <betreff>` – the
clients trim the subject, so without `kennung` it starts with the priority.
The Meldebuch export warns when it exceeds 128 bytes (Q-encoded: the `Ü` of
the prefix makes the whole subject an encoded word).

Exercise marker in the body: `<var uebung>` as the very first line, and
before the Inhalt the line `<var uebung>`, a blank line, the Inhalt, a blank
line, `<var uebung>` – framed so it reads as a marker, not as
part of the Spruch. The forms show „⚠ ACHTUNG ÜBUNG“ as a banner directly
above the text box. Import never takes marker lines into the Inhalt: lines
consisting only of „ACHTUNG ÜBUNG“ (optionally framed with `===`, `***`,
`---`, `###`, or written UEBUNG) and a leading `[ÜBUNG]` in a subject are
removed and set `exercise: true`.

## Files the Meldebuch reads and writes

- **Export** `<nummer>.winlink.json`: the payload object above, pretty-printing
  allowed. The input form's „Aus Meldebuch laden“ reads exactly this file.
- **Export for Pat** `<MID>.b2f` (optional): a ready message for Pat's `out/`
  folder: body from the same template, the XML attachment as the form would
  build it.
- **Import** accepts: the `.winlink.json` file (also as pasted text), an
  `RMS_Express_Form_*.xml` (ours: full payload; other forms: flat fields only),
  a `.b2f` message file (attachments parsed; without our XML: subject, body and
  sender only).

## Import rules (receiver)

- The imported message becomes a new **incoming** message in the open
  operation with its own number; the operator reviews it before saving.
- The sender's data is kept read-only as `source`:
  `{ format_version, station, operation, operator, id, number, direction, ts,
  updated, status, attempts, revisions, exported, exercise, mid? }` (`station` is the
  callsign as a string, as in `ref`). Imports of foreign forms or of our form
  filled in by hand have `id: null` plus `form` and `history`.
  The receiver's own `status` starts at `logged`.
- Bezug: `ref.id` or `ref.source.id` matching a local message's `id` or
  `source.id` → `replyTo` = that local id (and it is marked „beantwortet“ as
  usual). No match → `refNumber` = `"<number> (<station>)"`, or
  `"<number> (?)"` without a station, so it never matches a local number.
- Same `message.id` imported before (a local message with `source.id` equal):
  newer `message.updated` replaces the `source` block only; otherwise
  „bereits übernommen“. The receiver's own fields are never changed.
- Flat imports (no `meldung`) are duplicates by the same Winlink `mid`, or
  by the same number and station from our form.
- `message.id` or `message.source.id` is the id of a local message (own
  message coming back, also as a forwarded copy): not imported, reported.
- An import is refused while the message form holds unsaved input or an
  edit, so nothing typed is lost.
- The recipient's Winlink address is not part of the payload; it is typed
  in the form (`msgto`) or in the export dialog (only for the `.b2f`).
- Limits: files over 1 MB or payloads failing validation are rejected before
  anything is written, with a German message.
