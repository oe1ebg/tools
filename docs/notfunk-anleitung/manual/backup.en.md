# Backup and restore

[← Notfunk logbook (English)](../index.en.md) · [Open the Notfunk logbook](../../notfunk/index.html)
{ .doc-nav }

All data is stored only in the browser of this device. A backup file protects
against loss and lets you move to another device.

## Backing up

**"Sichern (JSON)"** downloads a file with the whole operation: all messages,
including deleted ones, with all versions. Clicking the backup status at the
top right also backs up.

- The file is **not encrypted**. Keep it in a place you control (USB stick,
  another computer).
- "Sicherung gestartet 14:40" (backup started 14:40) only means that the
  download has begun. Check that the file really arrived, and try the restore
  once.
- For a very large operation the logbook splits the backup into several files
  itself ("…_teil-1-von-3.json"). Allow the browser to make several downloads
  and check that all arrived. If the logbook says "Zu groß für eine einzige
  Sicherung" (too large for a single backup), export the registry (see below)
  and start a new operation for further messages; nothing is downloaded in
  this case.

## Restoring

On the start page **"Wiederherstellen…"**, then choose the backup file, also
on another device.

- With split backups, select **all parts together**. If a part is missing,
  nothing is imported, and the message names the missing part.
- The logbook checks the file completely before changing anything. If it is
  unusable ("Nicht importiert"), everything stays unchanged.
- Individual faulty entries are left out and listed with the reason; the rest
  is taken over. The result says how many messages are new and how many were
  updated. Newer messages that already exist are not overwritten, and the
  numbers never go back.
- Messages whose number is already assigned to a different message are listed
  under "Nicht übernommen" (not taken over) with the number.
- Logbooks of several devices can be merged this way if each device has its
  own station prefix.

## Registry for Excel

**"Geschäftsbuch (CSV)"** writes a table with one row per message: number,
reference of the Meldesammelstelle, date, time (local), direction, subject,
content, urgency, radio station, status, handover and reference. It opens in
Excel or LibreOffice.

## Protecting the data

- Data and backups are unencrypted. Use a screen lock and disk encryption, and
  do not share the device through a common user account.
- The version history protects against mistakes, not against tampering.
- The offline file and the page on the network have **separate** data. To move
  across, use the backup.
- Personal data must be deleted when no longer needed (Richtlinie Notfunk
  Wien, section on data protection). The logbook never deletes by itself.

Next: [When something does not work](../reference/notices.en.md)
