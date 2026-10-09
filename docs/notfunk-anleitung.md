# Notfunk-Meldebuch: Anleitung

[Notfunk-Meldebuch öffnen <span aria-hidden="true">→</span>](notfunk/index.html){ .tool-launch }
[Alle Tools](index.md) ·
[Offline-Datei](notfunk/notfunk-offline.html){ download="notfunk-meldebuch-offline.html" } ·
[Datenquellen](data-sources.md#notfunk-meldebuch) ·
[Quellcode](https://github.com/oe1ebg/tools/tree/main/tools/notfunk)
{ .tool-actions }

Das [Notfunk-Meldebuch](notfunk/index.html) ist ein Meldebuch für den
Notfunk: Meldungen aufnehmen, lückenlos nummerieren, an die
Meldesammelstelle übergeben, übertragen und ausdrucken. Es läuft vollständig
im Browser und ohne Internet; alle Daten bleiben auf dem Gerät.

!!! warning "Entwurf"
    Das Meldungsformat ist noch nicht mit dem Notfunkreferat Wien und der
    Meldesammelstelle abgestimmt. Felder, Bezeichnungen und die
    Dringlichkeitsstufen können sich ändern. Für Übungen gedacht.

Die Kurzfassung steht im Werkzeug selbst: **„? Hilfe“** oben im Formular oder
<kbd>F1</kbd>.

## Kurz: so geht's los

1. [Notfunk-Meldebuch öffnen](notfunk/index.html), einmal mit Internet;
   danach läuft es auch offline ([Vorbereitung](#vorbereitung)).
2. „+ Neuer Einsatz“: Name und Stationskürzel eintragen
   ([Einen Einsatz anlegen](#einen-einsatz-anlegen)).
3. Die erste Meldung aufnehmen und speichern; dabei wird die Nummer vergeben
   ([Eine Meldung aufnehmen](#eine-meldung-aufnehmen)).
4. Regelmäßig eine Sicherung (JSON) herunterladen
   ([Exporte und Sicherung](#exporte-und-sicherung)).

## Vorbereitung

**Offline verwenden.** Beim ersten Öffnen mit Internet lädt das Meldebuch
alles, was es braucht (Rufzeichenliste, Relaisliste, Wiener Adressen). Danach
funktioniert es ohne Verbindung. „offline bereit ✓“ oben rechts zeigt das an.
Am Handy oder Tablet über „Zum Startbildschirm hinzufügen“ als App ablegen.
Für Laptops ohne Internet gibt es die **Offline-Datei** (eine HTML-Datei,
etwa 6 MB, unten auf der Startseite des Werkzeugs), etwa für einen
USB-Stick.

**Daten sichern.** „Speicher dauerhaft ✓“ heißt, der Browser löscht die Daten
nicht von selbst. Steht dort „nicht dauerhaft“, ist eine regelmäßige
Sicherung umso wichtiger. Der Sicherungsstand steht oben rechts
(„Letzte Sicherung 14:40 · 3 Meldungen ungesichert“); ein Klick darauf lädt
eine neue Sicherung (JSON) herunter.

## Einen Einsatz anlegen

![Neuer Einsatz](img/notfunk-einsatz-neu.png)

| Feld | Bedeutung | Beispiel |
| --- | --- | --- |
| Einsatz / Übung | Name des Einsatzes | Übung Blackout Wien |
| Stationskürzel | steht vor jeder Nummer; jedes Gerät bzw. jede Station eines Einsatzes bekommt ein eigenes | W1 |
| Station | Name der eigenen Station | Lichtinsel 12 Floridsdorf |
| Operator | wer am Gerät aufnimmt | OE1EBG |
| Eigene Stelle | Adressat eingehender und Absender ausgehender Meldungen, solange nichts anderes eingetragen ist | Stab |
| Frequenz, Relais | Vorgabe für neue Meldungen | 145,500 · OE1XUU |

Alles außer dem Stationskürzel lässt sich später im aufklappbaren Feld
**„Einsatz“** über dem Formular ändern; Änderungen gelten für neue Meldungen.
Das Stationskürzel bleibt fest, sobald die erste Meldung gespeichert ist.

**Schichtwechsel:** im Feld „Einsatz“ den Operator ändern (oder oben im
Formular auf „Aufnahme OE1EBG“ klicken). Gespeicherte Meldungen behalten den
Operator, der sie aufgenommen hat.

## Der Ablauf einer Meldung

1. **Wortlaut aufnehmen:** den Inhalt wörtlich, wie übermittelt.
2. **Rücklesen bestätigen:** beim Eingang zurücklesen, der Absender bestätigt.
   Beim Ausgang liest die Gegenstelle zurück.
3. **Meldung sichern:** Speichern vergibt die Notfunk-Nummer.
4. **Übergabe bzw. Übertragung dokumentieren:** bei der Meldung „übergeben“
   (Eingang) bzw. „übertragen“ (Ausgang) eintragen, danach die Bestätigung.
5. **Externe Referenz ergänzen:** die Nummer, die die Meldesammelstelle
   zurückmeldet.

„Übergeben“ oder „übertragen“ heißt nie, dass ein Auftrag im Inhalt erledigt
ist.

## Eine Meldung aufnehmen

![Formular „Neue Meldung“](img/notfunk-meldung.png)

Das Formular steht im Meldebuch ganz oben. Die nächste Nummer wird angezeigt
(„→ W1-008“), aber erst beim Speichern vergeben.

### Die Felder

| Feld | Bedeutung | Beispiel |
| --- | --- | --- |
| Richtung | Eingang (↓) oder Ausgang (↑) | |
| Empfangen am / Gesendet am | wann die Meldung übermittelt wurde, Ortszeit (MEZ/MESZ). Wird beim ersten Tastendruck mit Datum und Uhrzeit vorbelegt und kann korrigiert werden. | 14:05 oder 2026-10-08 14:05 |
| Übermittlung | Funk, Telefon, mündlich, Melder, E-Mail, Fax, anders | Funk |
| Gegenstelle | die Funkstation, von der die Meldung gehört wurde (Eingang) bzw. an die sie gesendet wird (Ausgang); nur bei Funk | OE1ABC |
| Frequenz MHz, Relais | Vorgabe aus dem Einsatz; Komma oder Punkt | 145,500 · OE1XUU |
| Von (Absender) | wer die Meldung fachlich aufgibt | FF Floridsdorf, Einsatzleiter |
| An (Adressat) | für wen sie bestimmt ist | Stab, S4 |
| Meldungsart | Meldung, Auftrag, Frage, Anforderung, Lagemeldung | |
| Dringlichkeit | Routine, Dringend, Notfall (siehe unten) | |
| Stab herhören! | die Meldung soll sofort im Stab angesagt werden | |
| Betreff | kurzer Betreff | Stromausfall Pflegeheim |
| Ort / Einsatzstelle | wo das gemeldete Ereignis ist; Adresse, Ort, Locator oder UTMREF | Brünner Straße 68 |
| Inhalt – wörtlich | der Wortlaut; <kbd>Enter</kbd> macht eine neue Zeile | |
| Rücklesen | „Rücklesen erfolgt und vom Absender als richtig bestätigt“ | |

Pflichtfelder sind mit * markiert: Empfangen/Gesendet am, Von, An, Betreff
und Inhalt. Fehlt eines, steht der Hinweis direkt am Feld und der Cursor
springt dorthin.

Unter **„Weitere Felder“**:

| Feld | Bedeutung | Beispiel |
| --- | --- | --- |
| Bezug | Antwort, Korrektur oder Ergänzung zu einer anderen Meldung, mit deren Nummer | Antwort auf W1-003 |
| Verteiler | wer die Meldung noch bekommt | S3, S4 |
| Ursprungsstation | Station, bei der die Meldung ursprünglich aufgegeben wurde (bei Weitergaben) | OE3XYZ |
| Ursprungsort | Ort der ursprünglichen Aufgabe | Wolkersdorf |
| Aufgabezeit | wann die Meldung dort aufgegeben wurde | 13:50 |
| Stichzeit | nur bei Lagemeldungen: auf welchen Zeitpunkt sich die Lage bezieht | 14:00 |
| Anmerkungen / weitere Veranlassung | eigene Notizen | |

### Wer ist wer

- **Von / An** sind Absender und Adressat der Meldung selbst, etwa
  „FF Floridsdorf, Einsatzleiter“ an „Stab“.
- Die **Gegenstelle** ist die Funkstation, über die die Meldung kam oder an
  die sie geht. Bei Weitergaben ist sie oft nicht die
  **Ursprungsstation**.
- Der **Operator** ist, wer hier am Gerät aufnimmt.

### Orte

- **Ort / Einsatzstelle:** wo das Ereignis ist.
- **Ursprungsort:** wo die Meldung aufgegeben wurde.
- **Stationsstandort:** wo die eigene Station steht; gehört zum Einsatz, nicht
  zur Meldung.

Die Ortssuche schlägt Wiener Adressen, Orte, Plätze und Haltestellen vor und
für ganz Österreich Postleitzahlen, Gemeinden und Bezirke. Ein Vorschlag
ergänzt Postleitzahl und Locator. Der eingetippte Text bleibt, wenn nichts
passt, und der **Inhalt der Meldung wird nie verändert**.

### Zeiten

- **Empfangen am / Gesendet am:** wann die Meldung übermittelt wurde.
- **Erfasst am:** wann sie hier gespeichert wurde (automatisch).
- **Aufgabezeit:** wann sie bei der Ursprungsstation aufgegeben wurde.
- **Stichzeit:** worauf sich eine Lagemeldung bezieht.

**Nachtrag vom Papier:** das tatsächliche Datum und die Uhrzeit eintragen
(`2026-10-08 13:20`). Liegt die Zeit mehr als eine Stunde zurück, fragt das
Formular beim Speichern nach. Weil die Zeit mit Datum vorbelegt wird, bleibt
auch eine Meldung richtig, die vor Mitternacht begonnen und danach
gespeichert wird.

### Speichern, Hinweise, Verwerfen

![Hinweis vor dem Speichern](img/notfunk-hinweis.png)

- <kbd>⇧</kbd>+<kbd>Enter</kbd> oder <kbd>Strg</kbd>+<kbd>Enter</kbd> (am Mac auch <kbd>⌘</kbd>+<kbd>Enter</kbd>) speichert,
  aus jedem Feld.
- Fehlt nur etwas, das nicht zwingend ist (Gegenstelle, Rücklesen) oder liegt
  die Zeit weit zurück, erscheint **„Vor dem Speichern prüfen“**. Noch einmal
  <kbd>⇧</kbd>+<kbd>Enter</kbd> oder „Trotzdem speichern“ speichert.
- <kbd>Esc</kbd> schließt zuerst offene Vorschläge. Bei ausgefülltem Formular fragt
  es dann **„Eingabe verwerfen?“**; ein zweites <kbd>Esc</kbd> heißt „weiter
  erfassen“. Nach dem Verwerfen holt „Rückgängig“ alles zurück.
- Der halb ausgefüllte **Entwurf** wird laufend gesichert („✓ Entwurf
  gesichert“) und ist auch nach einem Neuladen noch da.

### Dringlichkeit und „Stab herhören!“

| Stufe | Bedeutung (vorläufig) |
| --- | --- |
| Routine | alles, was in der normalen Reihenfolge bearbeitet wird |
| Dringend | vor Routine-Meldungen übermitteln und bearbeiten |
| Notfall | Gefahr für Leib und Leben oder unmittelbar drohender großer Schaden: sofort |

**„Stab herhören!“** fordert an, dass die Meldung sofort im Stab angesagt
wird. Das Kästchen sagt nur, dass angesagt werden *soll*: die Ansage selbst
wird bei der Meldung mit Zeit und Person eingetragen. Bis dahin steht im
Meldebuch „Stab herhören! – Ansage offen“.

## Das Meldebuch

![Meldebuch](img/notfunk-meldebuch.png)

Die Meldungen stehen neueste zuerst. Oben die Zusammenfassung: offene
Notfälle, noch nicht bestätigte Meldungen, die Nummern und ob sie lückenlos
sind. Filter: alle, offen, Eingang, Ausgang, Notfall + Dringend, dazu die
Suche (Nummer, Referenz, Betreff, Station, Text).

Der **Status** hängt von der Richtung ab:

| Richtung | 1 | 2 | 3 | danach |
| --- | --- | --- | --- | --- |
| ↓ Eingang | erfasst | übergeben | übernommen | beantwortet |
| ↑ Ausgang | zur Übertragung | übertragen | Empfang bestätigt | beantwortet |

Der Knopf in der Zeile trägt den nächsten Schritt mit der aktuellen Zeit ein
(„übergeben“, „Übernahme bestätigt“, „übertragen“, „Empfang bestätigt“). Mit
Angaben (an wen, durch wen, wann) geht es bei der Meldung selbst.
„Beantwortet“ entsteht von selbst, wenn eine Antwort mit Bezug gespeichert
wird.

## Eine Meldung im Detail

![Meldung im Detail](img/notfunk-meldung-detail.png)

Ein Klick auf die Nummer öffnet die Meldung: Wortlaut, alle Angaben und
rechts der **Ablauf**.

- **Eingang:** „Übergeben an“ (z. B. Meldesammelstelle) mit Zeitpunkt, dann
  „Übernommen durch“ mit Zeitpunkt.
- **Ausgang:** „Übertragen an“ (die Gegenstelle) mit Zeitpunkt und ob sie
  zurückgelesen hat, dann „Empfang bestätigt durch“. Klappt eine Übertragung
  nicht oder gibt es eine Rückfrage: „Fehlversuch / Rückfrage eintragen“.
- Zeitpunkt leer = jetzt; sonst `14:10` oder `2026-10-08 14:10`.

**Referenz der Meldesammelstelle:** die Nummer, unter der die
Meldesammelstelle die Meldung führt (Geschäftsbuch). Sie wird hier
eingetragen, sobald sie zurückgemeldet wird, und steht dann im Meldebuch, in
der CSV und auf dem Ausdruck neben der Notfunk-Nummer. So lassen sich die
beiden Listen zuordnen. Die Notfunk-Nummer (`W1-007`) ist **nicht** die
Geschäftsbuchnummer.

Weiter bei der Meldung: **Antwort erfassen** (Richtung, Absender und Adressat
vertauscht, Bezug gesetzt), **Bearbeiten** (die vorige Fassung bleibt
gespeichert), **Ausdruck / PDF**, **Löschen** (die Nummer bleibt vergeben,
wiederherstellbar unter „Gelöschte Meldungen“).

## Ausdruck und PDF

![Ausdruck einer Meldung](img/notfunk-ausdruck.png)

Eine Meldung wird auf **eine A4-Seite** gedruckt: weißes Papier, dünne
Linien, keine schwarzen Flächen, auch aus der dunklen Ansicht.

- Oben die Richtung (**↓ EINGANG** oder **↑ AUSGANG**, die gewählte mit
  dickem Rahmen und ✕) und die Notfunk-Nummer.
- Darunter der Block **„Nur von der Meldesammelstelle / dem Stab
  auszufüllen“**: Referenz / Geschäftsbuch-Nr. (vorbelegt, wenn schon
  bekannt), Federführend, Mitwirkend, Zur Kenntnis.
- Datum, Uhrzeit und Zeitbasis in einem Feld: „08.10.2026 · 14:05 MESZ“, dazu
  UTC und die Erfassungszeit.
- Unten die Übergabe (Eingang) bzw. Übertragung (Ausgang).

![Druckhinweis](img/notfunk-druckhinweis.png)

**Druckeinstellungen.** Vor dem ersten Druck erinnert ein Hinweis daran, im
Druckdialog **„Kopf- und Fußzeilen“ auszuschalten**, A4 und 100 % zu wählen.
Chrome und Edge lassen Kopf- und Fußzeilen bei diesem Blatt ohnehin weg.
Als PDF: Ziel „Als PDF sichern“ bzw. „Als PDF speichern“.

**Lange Meldungen.** Passt der Text nicht, werden zuerst die Abstände kleiner,
dann die Schrift (höchstens bis 10 pt). Reicht auch das nicht (etwa ab 2.500
Zeichen), sagt das Werkzeug vor dem Druck, wie viele Seiten es werden; jede
Seite trägt die Nummer. Es wird nie etwas abgeschnitten.

**Leere Formulare** für die Arbeit ohne Gerät: „Leeres Formular drucken /
PDF“ auf der Startseite (bzw. „Leeres Formular“ im Meldebuch), die Anzahl im
Druckdialog wählen. Das leere Formular hat dieselben Felder und Begriffe.

**Das Meldebuch drucken:** „Drucken / PDF…“ im Meldebuch, optional mit
Zeitraum.

## Exporte und Sicherung

- **Geschäftsbuch (CSV):** eine Zeile pro Meldung, für Excel. Spalten u. a.
  Notfunk-Nr., Referenz Meldesammelstelle, Datum, Uhrzeit, Ein/Aus, Betreff,
  Inhalt, Dringlichkeit, Gegenstelle, Status, Übergabe, Bezug.
- **Sicherung (JSON):** der ganze Einsatz mit gelöschten Meldungen und allen
  Fassungen. Auf der Startseite mit „Sicherung importieren…“ wieder
  einspielen, auch auf einem anderen Gerät. Bücher mehrerer Geräte lassen
  sich so zusammenführen, wenn jedes Gerät ein eigenes Stationskürzel hat.

## Tastatur

| Taste | Wirkung |
| --- | --- |
| <kbd>Tab</kbd> / <kbd>Enter</kbd> | nächstes Feld (im Inhalt: <kbd>Enter</kbd> = neue Zeile) |
| <kbd>⇧</kbd>+<kbd>Tab</kbd> | vorheriges Feld |
| <kbd>1</kbd> – <kbd>7</kbd>, <kbd>←</kbd> <kbd>→</kbd> | Auswahl in Richtung, Übermittlung, Dringlichkeit |
| <kbd>↓</kbd> <kbd>↑</kbd>, <kbd>Enter</kbd> | Vorschläge durchgehen und übernehmen (Von, An, Gegenstelle, Relais, Orte, Ursprung) |
| <kbd>Leertaste</kbd> | Kästchen setzen (Stab herhören!, Rücklesen) |
| <kbd>⇧</kbd>+<kbd>Enter</kbd>, <kbd>Strg</kbd>+<kbd>Enter</kbd> | speichern |
| <kbd>Esc</kbd> | Vorschläge schließen, dann „Eingabe verwerfen?“; noch einmal = weiter erfassen |
| <kbd>F1</kbd>, <kbd>?</kbd> | Hilfe (<kbd>?</kbd> nur außerhalb von Textfeldern); <kbd>Esc</kbd> schließt sie |

## Hilfe im Werkzeug

![Hilfe](img/notfunk-hilfe.png)

„? Hilfe“ oder <kbd>F1</kbd> öffnet die Kurzhilfe über dem Formular. Die Eingabe
bleibt, wie sie ist; nach dem Schließen ist der Cursor wieder im vorigen
Feld.

## Offene Abstimmungen

Mit der Meldesammelstelle bzw. dem Stab abzustimmen:

- Bezeichnung und Nummernschema der externen Referenz.
- Dringlichkeitsstufen und ihre Bedeutung.
- Verfahren für „Stab herhören!“.
- Welche Übergabe- und Empfangsbestätigungen nötig sind.
- Umgang mit Meldungen, die nicht lesbar auf eine Seite passen.

---

[Notfunk-Meldebuch öffnen <span aria-hidden="true">→</span>](notfunk/index.html){ .tool-launch }
{ .tool-actions }
