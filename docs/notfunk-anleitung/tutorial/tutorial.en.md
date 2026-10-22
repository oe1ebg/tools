# Tutorial: a message from the Lichtinsel to the staff

[← Notfunk logbook (English)](../index.en.md) · [Open the Notfunk logbook](../../notfunk/index.html)
{ .doc-nav }

The example: exercise "Blackout Wien". You are a radio amateur at the
Lichtinsel Floridsdorf. Ms Huber, head of nursing at a care home at
Brünner Straße 68, arrives on foot: the emergency generator only runs until
about 18:00, and 6 ventilated residents depend on the power. The home needs
diesel for the generator.
Callsigns and names are made up.

## 1. Prepare

1. [Open the logbook](../../notfunk/index.html) once with internet and install it
   as an app (browser menu: "Install app" / "Add to Home Screen"); afterwards
   it works offline ("offline bereit ✓" top right). For laptops without
   internet there is a single offline HTML file to carry on a USB stick.
2. **"+ Neuer Einsatz"** (new operation): operation name, station prefix
   **W1**, your station callsign, location, operator, "Für Stelle" **Stab**
   and the frequency of the local network. Then "Einsatz anlegen".

    ![New operation](../../img/notfunk-einsatz-neu.png)

   The prefix stands before every number. If the Lichtinsel has two
   devices, each gets its own prefix (W1, W2) so numbers never collide.

## 2. Take down the message

You transmit the message, so the direction is **Ausgang (↑)**.

1. **Richtung:** Ausgang. **Übermittlung:** Funk. **Funkstelle:** the
   callsign of the station you transmit to (OE1DEF, the K-Vorsorgestandort).
2. **Von:** "Pflegeheim Brünner Straße 68, Frau Huber"; **An:** "Stab". The
   sender is the person, not you.
3. **Dringlichkeit:** "Dringend" (to be transmitted before routine);
   "Notfall" is for immediate danger to life. When in doubt, ask the control
   station.
4. **Betreff** (subject) and **Ort** (location; the address search suggests
   matches offline).
5. **Inhalt – wörtlich:** the exact wording.
6. **Rücklesen** (recommended, not mandatory): read the message back to the
   person; when they say "right", tick the box, otherwise leave it empty.

    ![The form "Neue Meldung"](../../img/notfunk-tutorial-meldung.png)

7. **Save** with <kbd>⇧</kbd>+<kbd>Enter</kbd>. Only now the number is
   assigned: **W1-001**.

## 3. Transmit and record it

1. In the message's row click **"übertragen"** and enter who you transmitted
   to (time empty = now).
2. When the other station has confirmed receipt (and read back, if you did), enter **"Empfang
   bestätigt"**.
3. When the Meldesammelstelle reports a **reference** ("GZ 0412"), enter it.

    ![The message with its flow](../../img/notfunk-tutorial-ablauf.png)

## 4. Receive the reply

1. Open W1-001 and choose **"Antwort erfassen"**: the form opens as
   **Eingang** with sender and addressee swapped and the reference set.
2. Enter the exact wording of the reply, read it back, save (**W1-002**).
   W1-001 is now **beantwortet**.
3. Tell Ms Huber, and record that you passed it on.

    ![The logbook after the reply](../../img/notfunk-tutorial-buch.png)

## 5. At the end

Download a **backup (JSON)** (the status top right counts messages not yet
backed up), and print messages or the whole logbook as PDF. Details are in
the [manual](../index.en.md).
