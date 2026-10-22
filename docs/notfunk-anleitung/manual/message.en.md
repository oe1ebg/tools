# Taking down a message

[← Notfunk logbook (English)](../index.en.md) · [Open the Notfunk logbook](../../notfunk/index.html)
{ .doc-nav }

The form is at the very top of the logbook. The next number is shown
("→ W1-008") but only assigned when you save.

## The course of a message

1. **Take down the wording:** the content word for word, as transmitted.
2. **Read back** (*Rücklesen*; recommended, not mandatory): read the message
   to the sender, or have the radio station read it back to you. If they
   confirm, tick the box "Rücklesen"; otherwise leave it empty.
3. **Save the message:** saving assigns the Notfunk number.
4. **Record the handover or transmission:** for an incoming message
   "übergeben" (handed over), for an outgoing one "übertragen" (transmitted),
   then the confirmation.
5. **Add the reference:** the number the Meldesammelstelle reports back.

"Handed over" or "transmitted" never means that a task in the content has
been done.

[![The form "Neue Meldung" with labelled fields, grouped by colour by what belongs together. Head: number, direction. When and how: time, transmission, radio station, frequency and relay, urgency. Who and what: from, to, subject, place, content. Finish: read back, further fields, save](../../img/notfunk-formular-beschriftet.png){ .wide }](../../img/notfunk-formular-beschriftet.png)

Every field is labelled in the picture (in German, as in the tool); the
colours show what belongs together. If you have **received** the message,
choose "Eingang" (incoming); if you are **relaying** it by radio, "Ausgang"
(outgoing). Enter times and dates as they are displayed (`2026-10-08`,
`14:05`); `20261008` and `1405` work too. All times are **local time**, in
24-hour notation.

**Required fields** are marked with \*: Empfangen/Gesendet am (received/sent
on), Von (from), An (to), Betreff (subject) and Inhalt (content). If one is
missing, the notice appears right at the field and the cursor jumps there.

Under **"Weitere Felder"** (further fields) you find:

| Field | Meaning | Example |
| --- | --- | --- |
| Bezug | reply, correction or addition to another message, with its number | Antwort auf W1-003 |
| Verteiler | who else receives the message | S3, S4 |
| Ursprungsstation | station where the message was originally filed (for relayed messages) | OE3XYZ |
| Ursprungsort | place where it was originally filed | Wolkersdorf |
| Aufgabezeit | when it was filed there (time) | 13:50 |
| Stichzeit | only for situation reports: the time the situation refers to | 14:00 |
| Anmerkungen | own notes | |

### Who is who

- **Von / An** are sender and addressee of the message itself, for example
  "Pflegeheim Brünner Straße 68, Frau Huber" to "Stab".
- The **Funkstelle** is the station the message came through or goes to. For
  relayed messages this is often not the **Ursprungsstation**.
- The **operator** is you: whoever takes down messages at this device.

When you type a callsign, the logbook suggests callsigns from the Austrian
callsign list and shows name and place below. Manage your own lists at the
bottom of the page under **"Rufzeichenlisten – verwalten…"**; they apply to
all tools on this device and are **not** part of the backup.

### Places

- **Ort:** where the event is.
- **Ursprungsort:** where the message was filed.
- **Standort der Station:** where your radio stands; it belongs to the
  operation, not to the message.

The place search suggests Vienna addresses, places, squares and stops, and
for all of Austria postal codes, municipalities and districts. A suggestion
adds postal code and locator. If nothing fits, your text stays as it is; the
**content of the message is never changed**.

**"📍 Standort"** in the header opens the location search: type an address,
place, coordinates, locator or UTMREF and have it converted, without leaving
the form.

### Times

- **Empfangen am / Gesendet am:** when the message was transmitted.
- **Erfasst am:** when it was saved in the logbook (automatic).
- **Aufgabezeit:** when it was filed at the originating station.
- **Stichzeit:** what a situation report refers to.

**Entering from paper afterwards ("Nachtrag vom Papier"):** enter the actual
date and time. If the time is more than an hour back, the form asks when you
save.

## Saving, notices, discarding

![Notice before saving](../../img/notfunk-hinweis.png)

- <kbd>⇧</kbd>+<kbd>Enter</kbd> or <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (on a Mac
  also <kbd>⌘</kbd>+<kbd>Enter</kbd>) saves, from any field.
- If only something optional is missing (the radio station), or the time is
  far back or in the future, **"Vor dem Speichern prüfen"** (check before
  saving) appears and the field is marked orange. Pressing
  <kbd>⇧</kbd>+<kbd>Enter</kbd> again, or "Trotzdem speichern" (save anyway),
  saves.
- <kbd>Esc</kbd> first closes open suggestions. With a filled-in form it then
  asks **"Eingabe verwerfen?"** (discard the input?); a second <kbd>Esc</kbd>
  means "keep entering". After discarding, "Rückgängig" (undo) brings
  everything back.
- **Draft:** what you are typing is saved continuously ("✓ Entwurf
  gesichert") and is still there after a reload. A draft is **not a saved
  message**, though: a number is only assigned when you save.
- **Saved** means message and number are filed completely and the message
  appears in the logbook. If saving fails ("SPEICHERN FEHLGESCHLAGEN"),
  nothing was assigned and your input is still in the form. Then download a
  backup right away.

Work on an operation in **one** window only. What happens with two is
described under [When something does not work](../reference/notices.en.md).

## Urgency

| Level | Meaning (provisional) |
| --- | --- |
| Routine | everything handled in the normal order |
| Dringend (urgent) | transmit and handle before routine messages |
| Notfall (emergency) | danger to life or limb, or imminent major damage: immediately |

Next: [The logbook](logbook.en.md)
