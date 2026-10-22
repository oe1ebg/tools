# When something does not work

[← Notfunk logbook (English)](../index.en.md) · [Open the Notfunk logbook](../../notfunk/index.html)
{ .doc-nav }

The logbook never silently overwrites anything. Best work on an operation in
**one** window only. If it happens in two anyway, these notices help.

## "NICHT GESPEICHERT" (not saved)

The message (or the operation) was changed elsewhere between opening and
saving, for example in another window. **Nothing** was written, the current
version is loaded, and your input is still in the form. Check and save again;
only the fields you changed yourself are then taken over.

![Notice NICHT GESPEICHERT](../../img/notfunk-nicht-gespeichert.png)

## "ENTWURF NICHT GESICHERT" (draft not saved)

Two windows each have a draft for this operation, but there is only one.
Choose "Meinen Entwurf sichern (ersetzt den anderen)" (save my draft, replaces
the other) or "Den anderen Entwurf laden (ersetzt meine Eingabe)" (load the
other draft, replaces my input).

![Notice ENTWURF NICHT GESICHERT](../../img/notfunk-entwurf-nicht-gesichert.png)

## "ENTWURF PRÜFEN" (check draft)

A draft that edits a saved message dates from before an update. The notice
names the fields that differ. With "Entwurf auf die aktuelle Fassung anwenden"
(apply the draft to the current version) your input stays in the form; with
"Entwurf verwerfen (gespeicherte Fassung laden)" (discard the draft, load the
saved version) the saved version applies. Nothing is saved until you choose.

![Notice ENTWURF PRÜFEN](../../img/notfunk-entwurf-pruefen.png)

## "ENTWURF – die Meldung gibt es nicht mehr" (the message no longer exists)

The message the draft edits no longer exists in this operation. The draft
would be saved as a **new** message with a new number.

## "SPEICHERN FEHLGESCHLAGEN" (saving failed)

Nothing was saved and no number was assigned; your input is still in the
form. Download a backup right away and try again.

## "Update wartet" (update waiting)

See [Preparation, New version](../manual/preparation.en.md#new-version).

## "localStorage (Ersatzspeicher)" in the footer

The browser's storage is restricted. Use only **one** window then and back up
often.

Next: [Keyboard and help](keyboard.en.md)
