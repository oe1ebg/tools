// Notfunk-Meldebuch and Winlink (issue #179): „Für Winlink exportieren…“
// downloads the file for the form and a .b2f for Pat; „Winlink-Nachricht
// importieren…“ takes a file (picker, dropped) or pasted text into the form
// for review, saves it with the sender's record, and reports duplicates and
// own messages without writing anything.
import { test, expect, downloadText, offlineSettled } from './fixtures.mjs';

async function openOp(page) {
  await page.goto('tools/notfunk/');
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await offlineSettled(page);
  await page.getByRole('button', { name: '+ Neuer Einsatz' }).click();
  await page.locator('#n-name').fill('Winlink-Übung');
  await page.locator('#n-prefix').fill('W1');
  await page.locator('#n-call').fill('OE1XYZ');
  await page.locator('#n-operator').fill('OE1XYZ');
  await page.getByRole('button', { name: 'Einsatz anlegen' }).click();
  await expect(page.locator('#view-book')).toBeVisible();
}

async function outgoing(page) {
  await page.locator('label[for="m-dir-out"]').click();
  await page.locator('label[for="m-channel-winlink"]').click();
  await page.locator('#m-to').fill('Bezirksstab / OE3ABC');
  await page.locator('#m-subject').fill('Notstrom „dringend“');
  await page.locator('#m-text').fill('Benötigen 2× Aggregat, Kosten bis 1.500 € <frei> & "jetzt".\nZweite Zeile 📻');
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText('Notstrom');
}

test('export: the file for the form and the .b2f for Pat; own message coming back is refused', async ({ page }) => {
  await openOp(page);
  await outgoing(page);
  await page.locator('#book-body a', { hasText: 'W1-001' }).click();
  await page.getByRole('button', { name: 'Für Winlink exportieren…' }).click();
  const dlg = page.locator('#wl-export-dlg');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('Winlink-Adresse des Empfängers')).toHaveValue('OE3ABC');
  await expect(dlg).toContainText(/Größe: \d+,\d KB \(höchstens 120 KB\)/);
  await expect(dlg).toContainText('als „?“');

  const json = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Datei für das Formular speichern' }).click();
  const file = await json;
  expect(file.suggestedFilename()).toBe('W1-001.winlink.json');
  const text = await downloadText(file);
  expect(text).toMatch(/^[\x20-\x7e]+\n?$/);
  const payload = JSON.parse(text);
  expect(payload.format).toBe('oe1ebg-notfunk-winlink');
  expect(payload.station.call).toBe('OE1XYZ');
  expect(payload.message.text).toContain('1.500 € <frei> & "jetzt".\nZweite Zeile 📻');
  await expect(dlg.getByRole('status')).toContainText('Download von „W1-001.winlink.json“ gestartet');

  // an empty or odd recipient: no .b2f
  await dlg.getByLabel('Winlink-Adresse des Empfängers').fill('Stab Wien');
  await expect(dlg.getByRole('button', { name: 'Für Pat (.b2f) speichern' })).toBeDisabled();
  await expect(dlg).toContainText('ein Rufzeichen (z. B. OE3ABC)');
  await dlg.getByLabel('Winlink-Adresse des Empfängers').fill('oe3abc');
  const b2fDl = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Für Pat (.b2f) speichern' }).click();
  const b2f = await b2fDl;
  expect(b2f.suggestedFilename()).toMatch(/^[A-Z2-7]{12}\.b2f$/);
  const raw = await downloadText(b2f);
  expect(raw).toMatch(/^Mid: [A-Z2-7]{12}\r\nBody: \d+\r\n/);
  expect(raw).toContain('\r\nTo: OE3ABC\r\n');
  expect(raw).toContain('File: ');
  await dlg.getByRole('button', { name: 'Schließen' }).click();
  await expect(dlg).toBeHidden();
  // the status stays manual
  await expect(page.locator('#msg-detail .detail-tags')).toContainText('zur Übertragung');

  // the same file back into this book: own message, nothing written
  await page.getByRole('button', { name: '← Meldebuch' }).click();
  await page.getByRole('button', { name: 'Winlink-Nachricht importieren…' }).click();
  await page.locator('#wl-file').setInputFiles({ name: 'W1-001.winlink.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.locator('#wl-import-msg')).toContainText('Das ist die eigene Meldung W1-001');
  await page.locator('#btn-wl-import-close').click();
  await expect(page.locator('#form-number')).toHaveText('→ W1-002');
});

test('import: review in the form, save with the sender\'s record, again = already there; paste and drop', async ({ page }) => {
  await openOp(page);
  // a message of another station (B), as its export file
  const now = '2026-11-06T17:00:00.000Z';
  const payload = {
    format: 'oe1ebg-notfunk-winlink', version: 1, app: '0.9.0', exported: now,
    station: { call: 'OE3ABC', operation: 'Übung Tulln', prefix: 'K', operator: 'OE3ABC' },
    message: {
      id: 'b-k7', prefix: 'K', seq: 7, number: 'K-007', direction: 'out', ts: now, channel: 'winlink', radio: { freq: '', via: '' }, peer: '',
      type: 'lagemeldung', priority: 'emergency', from: { name: 'Bezirksstab', call: 'OE3ABC', contact: '' }, to: { name: 'Stab', call: '', contact: '' },
      distribution: [], subject: 'Pegel Donau', text: 'Pegel steigt, Damm „Nord“ hält.', stichzeit: null,
      origin: { station: '', place: '', filed: null, placeLoc: null }, readBack: false, location: null, locationText: '',
      refKind: null, refNumber: '', staffRef: '', remarks: '', operator: 'OE3ABC', stationCall: 'OE3ABC',
      status: [{ state: 'logged', at: now, by: 'OE3ABC', note: '' }, { state: 'forwarded', at: now, recorded: now, by: 'OE3ABC', to: 'OE1XYZ', who: '', note: '' }],
      attempts: [], created: now, updated: now, deleted: null,
    },
    revisions: [], ref: null,
  };
  const text = JSON.stringify(payload);
  await page.getByRole('button', { name: 'Winlink-Nachricht importieren…' }).click();
  await expect(page.locator('#wl-import-dlg')).toBeVisible();
  await page.locator('#wl-file').setInputFiles({ name: 'K-007.winlink.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.locator('#wl-import-dlg')).toBeHidden();
  await expect(page.locator('#form-title')).toHaveText('Neue Meldung von Winlink');
  await expect(page.locator('#form-source')).toHaveText('von K-007 (OE3ABC)');
  await expect(page.locator('#m-subject')).toHaveValue('Pegel Donau');
  await expect(page.locator('#m-subject')).toBeFocused();
  await expect(page.locator('#form-status')).toContainText('bitte prüfen und speichern');
  await expect(page.locator('#m-dir-in')).toBeChecked();
  await expect(page.locator('#m-channel-winlink')).toBeChecked();
  // nothing is stored before the operator saves; the draft keeps the source over a reload
  await expect(page.locator('#book-body')).not.toContainText('Pegel Donau');
  await expect(page.locator('#draft-status')).toContainText('Entwurf gesichert');
  await page.reload();
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await expect(page.locator('#form-source')).toHaveText('von K-007 (OE3ABC)');
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText('Pegel Donau');
  await page.locator('#book-body a', { hasText: 'W1-001' }).click();
  const card = page.locator('section.wl-source');
  await expect(card).toContainText('Von Winlink übernommen');
  await expect(card).toContainText('OE3ABC');
  await expect(card).toContainText('K-007');
  await expect(card).toContainText('übertragen · an OE1XYZ');
  await expect(page.locator('#msg-detail .detail-tags')).toContainText('erfasst');
  await page.getByRole('button', { name: '← Meldebuch' }).click();

  // the same message again: reported, nothing written
  await page.getByRole('button', { name: 'Winlink-Nachricht importieren…' }).click();
  await page.locator('#wl-paste').fill(text);
  await page.getByRole('button', { name: 'Text übernehmen' }).click();
  await expect(page.locator('#wl-import-msg')).toContainText('Bereits übernommen als W1-001');
  // a newer state at the sender: only its record is updated
  const newer = structuredClone(payload);
  newer.message.updated = '2026-11-06T17:30:00.000Z';
  newer.message.status.push({ state: 'acknowledged', at: newer.message.updated, recorded: newer.message.updated, by: 'OE3ABC', to: '', who: 'OE1XYZ', note: '' });
  await page.locator('#wl-paste').fill(JSON.stringify(newer));
  await page.getByRole('button', { name: 'Text übernehmen' }).click();
  await expect(page.locator('#wl-import-msg')).toContainText('die Angaben des Absenders (Verlauf, Fassungen) sind aktualisiert');
  // garbage and a newer format: German errors, nothing changes
  await page.locator('#wl-paste').fill('Hallo');
  await page.getByRole('button', { name: 'Text übernehmen' }).click();
  await expect(page.locator('#wl-import-msg')).toContainText('nicht erkannt');
  await page.locator('#wl-paste').fill(JSON.stringify({ ...payload, version: 9 }));
  await page.getByRole('button', { name: 'Text übernehmen' }).click();
  await expect(page.locator('#wl-import-msg')).toContainText('neueren Version');

  // another form (ICS-213) as pasted XML: subject, text and sender
  await page.locator('#wl-paste').fill('<?xml version="1.0"?><RMS_Express_Form><form_parameters><display_form>ICS213_Viewer.html</display_form><senders_callsign>OE5XYZ</senders_callsign></form_parameters><variables><fm_name>Einsatzleiter</fm_name><subjectline>Strom</subjectline><message>Ausfall Bezirk 21.</message></variables></RMS_Express_Form>');
  await page.getByRole('button', { name: 'Text übernehmen' }).click();
  await expect(page.locator('#m-subject')).toHaveValue('Strom');
  await expect(page.locator('#m-from')).toHaveValue('Einsatzleiter');
  await expect(page.locator('#form-status')).toContainText('Anderes Formular (ICS213_Viewer.html)');

  // with something in the form, a further import is refused (nothing typed is lost)
  await page.getByRole('button', { name: 'Winlink-Nachricht importieren…' }).click();
  await page.locator('#wl-paste').fill(text.replace('b-k7', 'b-k8').replace('K-007', 'K-008').replace('"seq":7', '"seq":8'));
  await page.getByRole('button', { name: 'Text übernehmen' }).click();
  await expect(page.locator('#wl-import-msg')).toContainText('Im Formular steht noch eine Eingabe');
  await page.locator('#btn-wl-import-close').click();
  await expect(page.locator('#m-subject')).toHaveValue('Strom');
  await page.locator('#btn-discard').click();
  await page.locator('#btn-discard-yes').click();

  // a file dropped onto the book
  await page.evaluate(t => {
    const dt = new DataTransfer();
    dt.items.add(new File([t], 'K-008.winlink.json', { type: 'application/json' }));
    const target = document.querySelector('#book-body');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, text.replace('b-k7', 'b-k8').replace('K-007', 'K-008').replace('"seq":7', '"seq":8'));
  await expect(page.locator('#form-source')).toHaveText('von K-008 (OE3ABC)');
});
