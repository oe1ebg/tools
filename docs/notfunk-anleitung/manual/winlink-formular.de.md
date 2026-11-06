# Winlink-Formular installieren

[← Notfunk-Anleitung](../index.de.md) · [Notfunk-Meldebuch öffnen](../../notfunk/index.html)
{ .doc-nav }

Das Winlink-Formular **„OE Notfunk Meldung“** braucht jede Station, die
Meldungen mit dem Notfunk-Meldebuch über Winlink **sendet** oder
**empfangen und ins Meldebuch übernehmen** will (siehe
[Winlink](winlink.de.md)). Es wird einmal installiert und danach nur bei
einer neuen Version ersetzt. Eine Station ohne das Formular liest die
Meldungen trotzdem: als einfachen Text, ohne die Ansicht mit Verlauf.

Diese Anleitung geht Schritt für Schritt vor; man braucht sie selten, darum
ausführlich.

## 1. Herunterladen und auspacken

1. [**oe-notfunk-meldung-winlink.zip** herunterladen](../../downloads/oe-notfunk-meldung-winlink.zip){ download="oe-notfunk-meldung-winlink.zip" }.
2. Auspacken:
    - **Windows:** rechte Maustaste auf die Datei → **„Alle extrahieren…“** →
      „Extrahieren“.
    - **macOS:** Doppelklick auf die Datei.
    - **Linux / Raspberry Pi:** `unzip oe-notfunk-meldung-winlink.zip`
3. Darin liegen der Ordner **„OE Notfunk“** mit drei Dateien
   (`OE_Notfunk_Meldung.txt`, `OE_Notfunk_Meldung_Initial.html`,
   `OE_Notfunk_Meldung_Viewer.html`) und `README.txt` (Kurzanleitung).

Wichtig: Kopiert wird immer der **ganze Ordner „OE Notfunk“**, nicht die
einzelnen Dateien, und nicht ein Ordner, der ihn noch einmal enthält.

## 2a. Winlink Express (Windows)

!!! note "Noch nicht getestet"
    Diese Schritte folgen der Dokumentation von Winlink Express; wir
    konnten sie mit Winlink Express selbst noch nicht ausprobieren.

1. Winlink Express beenden.
2. Im Explorer den Ordner `C:\RMS Express\Global Folders\` öffnen. Ist
   Winlink Express anderswo installiert: der Ordner neben
   `RMS Express.exe`.
3. Gibt es darin keinen Ordner **„Templates“**, ihn anlegen (rechte
   Maustaste → Neu → Ordner → `Templates`).
4. Den Ordner **„OE Notfunk“** nach `C:\RMS Express\Global Folders\Templates\`
   kopieren. Danach gibt es
   `C:\RMS Express\Global Folders\Templates\OE Notfunk\OE_Notfunk_Meldung.txt`.
    - Nur für ein Rufzeichen statt für alle: stattdessen nach
      `C:\RMS Express\<RUFZEICHEN>\Templates\`.
5. Winlink Express starten. **Neue Nachricht** → **„Select Template“** →
   **Global Templates** → **OE Notfunk** → **OE_Notfunk_Meldung**.

## 2b. MacWinlink (macOS)

!!! note "Noch nicht getestet"
    Wir prüfen diese Schritte noch mit MacWinlink 0.99.

1. MacWinlink öffnen, die **Forms Library** öffnen.
2. **Import** → im ausgepackten Ordner **„OE Notfunk“** die Datei
   `OE_Notfunk_Meldung.txt` wählen. Die beiden `.html`-Dateien müssen daneben
   im selben Ordner liegen.
3. Entfernen: in der Forms Library rechte Maustaste auf das Formular →
   **„Delete…“**.

## 2c. Pat (Linux, Raspberry Pi, macOS, Windows)

1. Den Formular-Ordner von Pat finden: im Terminal

    ```
    pat env
    ```

    Die Zeile `PAT_FORMS_PATH` nennt ihn. Üblich sind
    `~/.local/share/pat/Standard_Forms` (Linux, Raspberry Pi) und
    `~/Library/Application Support/pat/Standard_Forms` (macOS).
2. Den Ordner **„OE Notfunk“** dorthin kopieren. Der Name enthält ein
   Leerzeichen, darum in Anführungszeichen, z. B. unter Linux:

    ```
    unzip oe-notfunk-meldung-winlink.zip -d /tmp/oe-notfunk
    mkdir -p ~/.local/share/pat/Standard_Forms
    cp -r "/tmp/oe-notfunk/OE Notfunk" ~/.local/share/pat/Standard_Forms/
    ```

    macOS:

    ```
    cp -r "OE Notfunk" ~/Library/Application\ Support/pat/Standard_Forms/
    ```

3. Pat muss nicht neu gestartet werden. In der Weboberfläche: **Neue
   Nachricht** → **Template** → **OE Notfunk** → **OE_Notfunk_Meldung**.

Ein Update der Standard-Formulare von Pat („Update forms“ bzw.
`pat templates update`) lässt den Ordner „OE Notfunk“ stehen (geprüft im
Quelltext von Pat 1.0).

## 3. Prüfen

Das Formular öffnen wie oben. Es zeigt die Überschrift **„Notfunk-Meldung“**
und darunter **„Winlink-Formular „OE Notfunk Meldung“ · Version 1.0“**, dazu
„Aus Meldebuch laden“. Dann ist es richtig installiert.

## Neue Version, Entfernen

- **Neue Version:** die neue Zip-Datei auspacken und den Ordner
  „OE Notfunk“ am selben Ort **ersetzen** (alten Ordner löschen, neuen
  hineinkopieren; MacWinlink: löschen und neu importieren). Die Version
  steht unter der Überschrift des Formulars. Sender und Empfänger sollten
  dieselbe Version verwenden.
- **Entfernen:** den Ordner „OE Notfunk“ löschen (MacWinlink: rechte
  Maustaste → „Delete…“).

## Wenn etwas nicht klappt

- **Das Formular fehlt in der Liste.** Liegt der Ordner am richtigen Ort?
  Häufig ist er doppelt verschachtelt (`…\Templates\OE Notfunk\OE Notfunk\`)
  nach dem Auspacken: dann den inneren Ordner nach oben verschieben. Bei
  Pat mit `pat env` den Pfad prüfen; Winlink Express neu starten.
- **Das Formular sagt, es sei „nicht in einem Winlink-Programm geöffnet“,
  und der Knopf zum Erstellen fehlt.** Die HTML-Datei wurde direkt per
  Doppelklick geöffnet. Senden geht nur aus Winlink Express, MacWinlink oder
  Pat: dort eine neue Nachricht beginnen und das Formular wählen.
- **Der Empfänger sieht nur einfachen Text statt der Meldung mit Verlauf.**
  Bei ihm ist das Formular nicht installiert. Er kann es nachinstallieren
  und die Nachricht neu öffnen; ins Meldebuch übernehmen kann er sie auch
  ohne Formular über den Anhang `RMS_Express_Form_OE_Notfunk_Meldung_Viewer.xml`.

---

[← Notfunk-Anleitung](../index.de.md) · [Winlink: senden und empfangen](winlink.de.md)
{ .doc-nav }
