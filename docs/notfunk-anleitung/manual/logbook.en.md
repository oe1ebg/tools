# The logbook

[← Notfunk logbook (English)](../index.en.md) · [Open the Notfunk logbook](../../notfunk/index.html)
{ .doc-nav }

![Logbook](../../img/notfunk-meldebuch.png)

The logbook (*Meldebuch*) shows all messages of an operation, newest first. At
the top is the summary: open emergencies, messages not yet confirmed, the
numbers and whether they are gapless. With the filters (alle = all, offen =
open, Eingang = incoming, Ausgang = outgoing, Notfall + Dringend) and the
search (number, reference, subject, station, text) you find a message quickly.

## Reading a row

- **Nr. · Zeit:** the Notfunk number, below it the time (Vienna local time),
  the reference of the Meldesammelstelle and, for a reply, "↪" with the number
  of the message it answers.
- **Gegenstelle:** the other side, with **↓** (incoming: from them) or **↑**
  (outgoing: to them).
- **Betreff · Inhalt:** type of message, urgency (red emergency, yellow
  urgent), subject and the beginning of the content.
- **Status:** where the message stands, with time and operator of the last
  step.
- At the far right the **next step** and **PDF** (the message as a form).

On a phone each message is a card with the same information.

## The status

The status depends on the direction:

| Direction | 1 | 2 | 3 | afterwards |
| --- | --- | --- | --- | --- |
| ↓ Eingang | erfasst | übergeben | übernommen | beantwortet |
| ↑ Ausgang | zur Übertragung | übertragen | Empfang bestätigt | beantwortet |

(erfasst = taken down, übergeben = handed over, übernommen = taken over,
zur Übertragung = to be transmitted, übertragen = transmitted, Empfang
bestätigt = receipt confirmed, beantwortet = answered.)

The button in the row ("übergeben", "Übernahme bestätigt", "übertragen",
"Empfang bestätigt") opens a small window for this step: **to whom** or **by
whom**, the **time** (empty = now) and, for "Übernahme bestätigt", the
**reference of the Meldesammelstelle** if one is given. <kbd>Enter</kbd>
records, <kbd>Esc</kbd> closes without recording.

"Beantwortet" happens by itself as soon as a reply that refers to the message
is saved.

## The map

![Map of the messages](../../img/notfunk-karte.png)

*The picture shows the example operation to try out
([notfunk-full.json](https://github.com/oe1ebg/tools/blob/main/examples/backups/notfunk-full.json),
load it with "Wiederherstellen…").*

"Karte" (next to the search) shows the messages of the current selection at
their place, on a map of Vienna that also works without internet. The colour
of a dot is the highest urgency: red emergency, yellow urgent, blue routine.
A number on the dot means several messages at the same place. Hover over it
(on a phone: tap) to see number, time, subject and status; the number leads to
the message. The star is your station's location. Below the map it says which
messages have no place.

## A message in detail

![Message in detail](../../img/notfunk-meldung-detail.png)

Clicking the row (or the number) opens the message: at the top status, type,
direction and time, then **Von → An** (from → to), the **wording**, below it
transmission, place (with a small map), origin and notes. On the right is the
**course**: when and by whom the message was taken down, handed over or
transmitted, and confirmed.

- **Incoming:** "Übergeben an" (handed over to, for example the
  Meldesammelstelle), then "Übernommen durch" (taken over by) and, if given,
  the reference of the Meldesammelstelle.
- **Outgoing:** "Übertragen an" (transmitted to, the radio station), if
  applicable whether it read back, then "Empfang bestätigt durch" (receipt
  confirmed by). If a transmission fails or there is a query: "Fehlversuch /
  Rückfrage eintragen" (record failed attempt / query).
- Time empty = now; otherwise the time, for example `14:10`.

**Reference of the Meldesammelstelle:** the number under which the
Meldesammelstelle keeps the message in its registry (*Geschäftsbuch*). Enter
it as soon as it is reported back; this lets the two lists be matched. The
Notfunk number (`W1-007`) is **not** the registry number.

More buttons on the message:

- **Antwort erfassen** (record reply): direction, sender and addressee are
  swapped, the reference is set.
- **Bearbeiten** (edit): corrects the message; the previous version stays
  stored.
- **Ausdruck / PDF:** see [Printout and PDF](printout.en.md).
- **Löschen** (delete): the message disappears from the list, its number stays
  assigned and is never used again. Under "Gelöschte Meldungen" it can be
  restored.

Next: [Printout and PDF](printout.en.md)
