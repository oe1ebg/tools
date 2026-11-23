# Sicherung und Wiederherstellung

[← Notfunk-Anleitung](index.md) · [Notfunk-Meldebuch öffnen](../notfunk/index.html)
{ .doc-nav }

Alle Daten liegen nur im Browser dieses Geräts. Eine Sicherungsdatei schützt
vor Verlust und ermöglicht den Umzug auf ein anderes Gerät.

## Sichern

**„Sichern (JSON)“** lädt eine Datei mit dem ganzen Einsatz herunter: alle
Meldungen, auch gelöschte, mit allen Fassungen. Auch ein Klick auf den
Sicherungsstand oben rechts sichert.

- Die Datei ist **nicht verschlüsselt**. Bewahren Sie sie an einem Ort auf,
  den Sie kontrollieren (USB-Stick, anderer Rechner).
- „Sicherung gestartet 14:40“ heißt nur: Der Download hat begonnen. Prüfen
  Sie, dass die Datei wirklich angekommen ist, und probieren Sie die
  Wiederherstellung einmal aus.
- Bei einem sehr großen Einsatz teilt das Meldebuch die Sicherung selbst in
  mehrere Dateien („…_teil-1-von-3.json“). Erlauben Sie dem Browser
  mehrere Downloads und prüfen Sie, dass alle angekommen sind. Meldet das
  Meldebuch „Zu groß für eine einzige Sicherung“, exportieren Sie das
  Geschäftsbuch (siehe unten) und beginnen für weitere Meldungen einen neuen
  Einsatz; heruntergeladen wird in diesem Fall nichts.

## Wiederherstellen

Auf der Startseite **„Wiederherstellen…“**, dann die Sicherungsdatei wählen,
auch auf einem anderen Gerät.

- Bei geteilten Sicherungen markieren Sie **alle Teile gemeinsam**. Fehlt ein
  Teil, wird nichts importiert, und die Meldung nennt den fehlenden Teil.
- Das Meldebuch prüft die Datei vollständig, bevor es etwas ändert. Ist sie
  unbrauchbar („Nicht importiert“), bleibt alles unverändert.
- Einzelne fehlerhafte Einträge werden ausgelassen und mit Grund aufgelistet;
  der Rest wird übernommen. Das Ergebnis sagt, wie viele Meldungen neu und wie
  viele aktualisiert wurden. Bereits vorhandene, neuere Meldungen werden nicht
  überschrieben, und die Nummern gehen nie zurück.
- Meldungen, deren Nummer schon für eine andere Meldung vergeben ist, werden
  unter „Nicht übernommen“ mit der Nummer aufgelistet.
- Bücher mehrerer Geräte lassen sich so zusammenführen, wenn jedes Gerät sein
  eigenes Stationskürzel hat.

## Geschäftsbuch für Excel

**„Geschäftsbuch (CSV)“** schreibt eine Tabelle mit einer Zeile pro Meldung:
Nummer, Referenz der Meldesammelstelle, Datum, Uhrzeit (Ortszeit), Richtung,
Betreff, Inhalt, Dringlichkeit, Funkstelle, Status, Übergabe und Bezug. Sie
lässt sich in Excel oder LibreOffice öffnen.

## Daten schützen

- Die Daten und Sicherungen sind unverschlüsselt. Verwenden Sie
  Bildschirmsperre und Festplattenverschlüsselung und teilen Sie das Gerät
  nicht über ein gemeinsames Benutzerkonto.
- Der Verlauf der Fassungen schützt vor Versehen, nicht vor Manipulation.
- Die Offline-Datei und die Seite im Netz haben **getrennte** Daten. Zum
  Umziehen verwenden Sie die Sicherung.
- Personenbezogene Daten sind zu löschen, wenn sie nicht mehr gebraucht
  werden (Richtlinie Notfunk Wien, Abschnitt Datenschutz). Das Meldebuch
  löscht nie von selbst.

Weiter: [Wenn etwas nicht klappt](hinweise.md)
