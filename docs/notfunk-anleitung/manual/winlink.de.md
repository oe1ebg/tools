# Winlink (Prototyp)

[← Notfunk-Anleitung](../index.de.md) · [Notfunk-Meldebuch öffnen](../../notfunk/index.html)
{ .doc-nav }

Eine Meldung lässt sich über **Winlink** an eine andere Station schicken, und
eine über Winlink empfangene Meldung lässt sich ohne Abtippen ins Meldebuch
übernehmen. Das Meldebuch bleibt dabei offline: Der Austausch läuft über
Dateien oder Kopieren und Einfügen, das Winlink-Programm (Winlink Express
oder Pat) sendet.

!!! warning "Prototyp"
    Getestet mit Pat 1.0. Winlink Express ist noch nicht ausprobiert. Für
    Übungen gedacht.

Beide Stationen brauchen dafür das Winlink-Formular **„OE1 Notfunk
Meldung“**; wie man es installiert, steht in
[Winlink-Formular installieren](winlink-formular.de.md). Eine Station ohne
Formular liest die Meldung trotzdem: als einfachen Text.

## Senden

1. Die Meldung im Meldebuch öffnen (Klick auf ihre Zeile) und
   **„Für Winlink exportieren…“** wählen.
2. Oben steht, ob die Nachricht als **Übung** gekennzeichnet wird: bei
   einem Einsatz mit Haken **„Übung“** (Vorgabe) steht im Betreff
   `[ÜBUNG]`, im Text als erste Zeile und vor und nach dem Spruch eine
   eigene Zeile `=== ACHTUNG ÜBUNG ===` und im Formular über dem Inhalt der Balken
   „⚠ ACHTUNG ÜBUNG“. Ohne Haken steht dort „Ernstfall“.
   Im Fenster steht die **Winlink-Adresse des Empfängers** (vorbelegt mit
   dem Rufzeichen des Adressaten) und die **Größe** der Nachricht.
   Hinweise darunter beachten:
    - Zeichen wie `€`, `„“` oder Emoji erscheinen im Text der
      Winlink-Nachricht als `?`; im Formular und beim Einlesen ins Meldebuch
      bleiben sie erhalten.
    - Ein Betreff über 128 Byte (Übungskennung, Dringlichkeit, Nummer und Betreff zusammen)
      wird gemeldet: besser den Betreff kürzen.
    - Über **120 KB** (mit allen Fassungen und dem Verlauf) exportiert das
      Meldebuch nichts; gekürzt wird nie. Den Inhalt dann auf mehrere
      Meldungen aufteilen.
3. **„Datei für das Formular speichern“** lädt `W1-007.winlink.json`
   herunter (die Nummer der Meldung). Ohne Datei geht es auch über die
   Zwischenablage: **„Daten kopieren“**, dann im Formular
   **„Oder den Inhalt der Datei einfügen“** aufklappen, einfügen und
   **„Übernehmen“**.
4. Im Winlink-Programm eine neue Nachricht mit dem Formular **„OE1 Notfunk
   Meldung“** beginnen, **„Aus Meldebuch laden“**, die Datei wählen (oder
   ihren Inhalt einfügen), die Winlink-Adresse des Empfängers prüfen und
   **„Nachricht erstellen“**.
    - **Winlink Express** legt die Nachricht in den Postausgang.
    - **Pat** füllt das Nachrichtenfenster: dort **„Send“**.
    Übertragen wird bei der nächsten Verbindung.
5. Wenn die Nachricht gesendet ist, im Meldebuch **„übertragen“**
   eintragen. Der Status ändert sich nicht von selbst.

**Nur Pat:** Statt Schritt 3 und 4 geht auch **„Für Pat (.b2f) speichern“**.
Das ist die fertige Nachricht (`ABCDEFGHIJKL.b2f`); sie kommt in den Ordner
`out/` des Postfachs von Pat, z. B.
`~/.local/share/pat/mailbox/OE1XYZ/out/` (macOS:
`~/Library/Application Support/pat/mailbox/OE1XYZ/out/`). Dafür muss im
Einsatz das Stationsrufzeichen eingetragen sein, und es muss das Rufzeichen
sein, mit dem Pat sendet.

## Empfangen

Die Nachricht im Winlink-Programm öffnen. Mit installiertem Formular zeigt
es die ganze Meldung mit Verlauf. Unter **„Für das Meldebuch“**:

- **Winlink Express:** „Speichern“ (Datei `…winlink.json`) oder
  „Kopieren“; oder den Anhang `RMS_Express_Form_OE1_Notfunk_Meldung_Viewer.xml`
  der Nachricht speichern.
- **Pat:** „Kopieren“ (Speichern ist in Pat gesperrt); oder in der
  Nachricht den Anhang `RMS_Express_Form_OE1_Notfunk_Meldung_Viewer.xml`
  herunterladen; oder die Datei `<MID>.b2f` aus dem Ordner `in/` des
  Postfachs nehmen (`~/.local/share/pat/mailbox/<RUFZEICHEN>/in/`, macOS
  `~/Library/Application Support/pat/mailbox/<RUFZEICHEN>/in/`).

Dann im Meldebuch über der Liste **„Winlink-Nachricht importieren…“**:

- **„Datei wählen…“** (`.json`, `.xml` oder `.b2f`), oder
- die Datei aus dem Dateimanager auf das Fenster oder das Meldebuch ziehen,
  oder
- den kopierten Text in das Feld einfügen und **„Text übernehmen“**.

Die Meldung öffnet sich als **neuer Eingang** im Formular („Neue Meldung von
Winlink“, daneben Nummer und Station des Absenders). Prüfen, ergänzen und
speichern: Erst Speichern vergibt die eigene Nummer, der Status beginnt bei
„erfasst“. Steht im Formular schon eine Eingabe, wird nichts übernommen;
erst speichern oder verwerfen.

Ziehen direkt aus der Weboberfläche von Pat geht nicht (das bräuchte eine
Netzwerkverbindung); zuerst die Datei speichern.

### Was übernommen wird

- Alle Felder der Meldung. Die Angaben des Absenders (Station, seine Nummer,
  sein Verlauf, Fehlversuche, frühere Fassungen) stehen bei der Meldung im
  Abschnitt **„Von Winlink übernommen“**, nur zum Lesen.
- **Bezug:** Ist die Meldung eine Antwort auf eine eigene Meldung, wird sie
  damit verknüpft, und die eigene Meldung wird beim Speichern
  „beantwortet“. Sonst steht der Bezug als Text da, mit der Station, z. B.
  `W1-003 (OE1XYZ)`: Nummern gelten nur bei der Station, die sie vergeben
  hat.
- **Dieselbe Meldung noch einmal:** „Bereits übernommen als …“, es ändert
  sich nichts. Ist sie beim Absender inzwischen weiter (z. B. Empfang
  bestätigt), werden nur seine Angaben aktualisiert; die eigenen Felder
  bleiben.
- **Eine eigene Meldung**, die zurückkommt, wird nicht übernommen; eigene
  Daten stellt die [Sicherung](backup.de.md) wieder her.
- **Andere Formulare** (z. B. ICS-213, IARU) und Nachrichten ohne Formular:
  nur Betreff, Text und Absender.
- Dateien über 1 MB, beschädigte Dateien und Meldungen aus einer neueren
  Version des Meldebuchs werden abgelehnt; es ändert sich nichts, die
  Meldung im Fenster sagt warum.

---

[← Notfunk-Anleitung](../index.de.md) · [Winlink-Formular installieren](winlink-formular.de.md)
{ .doc-nav }
