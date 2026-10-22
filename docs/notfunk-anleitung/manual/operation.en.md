# Creating an operation

[← Notfunk logbook (English)](../index.en.md) · [Open the Notfunk logbook](../../notfunk/index.html)
{ .doc-nav }

An **operation** (*Einsatz*, or an exercise) is a logbook of its own with its
own numbering. Create one with **"+ Neuer Einsatz"** (new operation).

![New operation](../../img/notfunk-einsatz-neu.png)

| Field | Meaning | Example |
| --- | --- | --- |
| Einsatz / Übung | name of the operation | Übung Blackout Wien |
| Stationskürzel | station prefix; stands before every number; each device in an operation gets its own | W1 |
| **Own station (Eigene Station):** | | |
| Stationsrufzeichen | callsign of your radio station; may differ from the operator's callsign | OE1ABC |
| Standort der Station (Adresse) | where your radio stands; printed at the top of the printout | Lichtinsel 12 Floridsdorf |
| Für Stelle | whom the station works for: addressee of incoming and sender of outgoing messages | Stab |
| Frequenz, Relais | default for new messages; relay empty = direct | 438,950 |
| **At the device (Am Gerät):** | | |
| Operator | who takes down messages at the device | OE1EBG |

Station callsign and operator are stored with every message and appear in the
printout ("Aufgenommen von OE1EBG, an Station OE1ABC": taken down by OE1EBG,
at station OE1ABC).

## Changing it later

Everything except the station prefix can be changed in the collapsible
**"Einsatz"** field above the form; changes apply to new messages. The station
prefix stays fixed once the first message is saved.

**Change of shift:** change the operator in the "Einsatz" field (or click
"Aufnahme OE1EBG" at the top of the form). Saved messages keep the operator
who took them down.

<kbd>Esc</kbd> resets a field to the value it had before editing; "Rückgängig"
(undo) restores the operation as it was when the field was opened.

Next: [Taking down a message](message.en.md)
