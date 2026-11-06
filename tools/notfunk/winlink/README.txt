Winlink-Formular „OE Notfunk Meldung“ (Entwurf)
================================================

Schickt eine Meldung aus dem Notfunk-Meldebuch über Winlink. Der Empfänger
sieht die ganze Meldung mit Verlauf und kann sie ohne Abtippen in sein
Meldebuch übernehmen. Ohne Meldebuch lässt sich das Formular auch von Hand
ausfüllen.

Installieren
------------
Winlink Express: den Ordner „OE Notfunk“ nach
  C:\RMS Express\Global Folders\Templates\
kopieren. Neue Nachricht -> Select Template -> OE Notfunk -> OE_Notfunk_Meldung.

Pat: den Ordner „OE Notfunk“ in den Formular-Ordner von Pat kopieren
(„pat env“ zeigt ihn als PAT_FORMS_PATH), z. B.
  Linux/Raspberry Pi: ~/.local/share/pat/Standard_Forms/
  macOS: ~/Library/Application Support/pat/Standard_Forms/
Ein Update der Standard-Formulare lässt den Ordner stehen.
Neue Nachricht -> Template -> OE Notfunk -> OE_Notfunk_Meldung.

Senden
------
1. Im Meldebuch die Meldung für Winlink exportieren (Datei <Nummer>.winlink.json).
2. Formular öffnen, „Aus Meldebuch laden“, Datei wählen (oder ihren Inhalt
   einfügen), Winlink-Adresse des Empfängers eintragen,
   „Nachricht erstellen“.
3. Winlink Express legt die Nachricht in den Postausgang; in Pat im
   Nachrichtenfenster „Send“ wählen. Übertragen wird bei der nächsten
   Verbindung.

Empfangen
---------
Die Nachricht öffnen: das Formular zeigt die ganze Meldung. Unter
„Für das Meldebuch“ auf „Kopieren“ und im Meldebuch beim Import einfügen,
oder „Speichern“. In Pat ist Speichern dort gesperrt: kopieren oder den
Anhang RMS_Express_Form_OE_Notfunk_Meldung_Viewer.xml der Nachricht
herunterladen; das Meldebuch liest auch diese Datei.

Datum und Zeit sind immer in UTC (JJJJ-MM-TT HH:MM).
