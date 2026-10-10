// Notfunk-Meldebuch (/tools/notfunk/): an operation is created, messages get
// gapless numbers (a deleted one keeps its number), the status moves on,
// a reply marks the original answered, an edit keeps a revision, the
// Geschäftsbuch CSV downloads, the print layout shows only the form (one
// A4 page), the help opens and closes without touching the form.
import { test, expect, downloadText } from './fixtures.mjs';

async function openNewOp(page, name, prefix) {
  await page.goto('tools/notfunk/');
  await expect(page).toHaveTitle('Notfunk-Meldebuch');
  await expect(page.locator('#view-ops')).toBeVisible();
  // the buttons work only once the app has started
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await page.getByRole('button', { name: '+ Neuer Einsatz' }).click();
  await page.locator('#n-name').fill(name);
  await page.locator('#n-prefix').fill(prefix);
  await page.locator('#n-operator').fill('oe1ebg');
  await page.getByRole('button', { name: 'Einsatz anlegen' }).click();
  await expect(page.locator('#view-book')).toBeVisible();
  await expect(page.locator('#book-title')).toHaveText(name);
}

async function addMessage(page, from, subject, text = `${subject}, wörtlich.`) {
  await page.locator('#m-from').fill(from);
  await page.locator('#m-peer').fill('OE1ABC');
  await page.locator('#m-subject').fill(subject);
  await page.locator('#m-text').fill(text);
  await page.locator('#m-readback').check();
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText(subject);
}

const numbers = page => page.locator('#book-body td.num').allTextContents();

test('loads and shows the operations', async ({ page }) => {
  await page.goto('tools/notfunk/');
  await expect(page.locator('#view-ops')).toBeVisible();
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_STARTED === true)).toBe(true);
  await expect(page.locator('#st-backend')).toHaveText('IndexedDB');
  await expect(page.locator('.banner.draft')).toContainText('Entwurf');
});

test('numbers, status, reply, edit, delete and CSV', async ({ page }) => {
  await openNewOp(page, 'E2E Übung', 'w1');
  await expect(page.locator('#form-number')).toHaveText('→ W1-001');
  await addMessage(page, 'Lichtinsel 3', 'Wasser');
  await addMessage(page, 'Lichtinsel 4', 'Strom');
  await addMessage(page, 'Lichtinsel 5', 'Diesel');
  expect(await numbers(page)).toEqual(['W1-003', 'W1-002', 'W1-001']);

  // hand W1-001 over from the table
  await page.getByRole('button', { name: 'W1-001 übergeben' }).click();
  await expect(page.locator('#book-body tr', { hasText: 'W1-001' })).toContainText('übergeben');

  // delete W1-002: the number stays taken
  await page.locator('#book-body a', { hasText: 'W1-002' }).click();
  await expect(page.locator('#msg-title')).toHaveText('W1-002');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Löschen' }).click();
  await expect(page.locator('#msg-detail')).toContainText('gelöscht');
  await page.getByRole('button', { name: '← Meldebuch' }).click();
  await expect.poll(() => numbers(page)).toEqual(['W1-003', 'W1-001']);
  await expect(page.locator('#form-number')).toHaveText('→ W1-004');

  // reply to W1-001 (opened by a click on its row, not the number): the
  // reply gets W1-004, the original is answered
  await page.locator('#book-body tr', { has: page.locator('td.num', { hasText: 'W1-001' }) }).locator('td.content').click();
  await page.getByRole('button', { name: 'Antwort erfassen' }).click();
  await expect(page.locator('#form-reply')).toContainText('Antwort auf W1-001');
  await expect(page.locator('#m-to')).toHaveValue('Lichtinsel 3');
  await page.locator('#m-text').fill('Tankwagen um 16 Uhr.');
  await page.locator('#btn-save').click();
  await expect.poll(() => numbers(page)).toEqual(['W1-004', 'W1-003', 'W1-001']);
  await expect(page.locator('#book-body tr', { hasText: 'W1-001' })).toContainText('beantwortet');

  // edit W1-003: one earlier version kept, the number unchanged
  await page.locator('#book-body a', { hasText: 'W1-003' }).click();
  await page.getByRole('button', { name: 'Bearbeiten' }).click();
  await page.locator('#m-subject').fill('Diesel 60 Liter');
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body tr', { hasText: 'W1-003' })).toContainText('Diesel 60 Liter');
  await page.locator('#book-body a', { hasText: 'W1-003' }).click();
  await expect(page.locator('#msg-detail')).toContainText('geändert; vorher');
  await page.getByRole('button', { name: '← Meldebuch' }).click();

  const csv = page.waitForEvent('download');
  await page.locator('#btn-csv').click();
  const download = await csv;
  expect(download.suggestedFilename()).toMatch(/^meldebuch-W1-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await downloadText(download);
  expect(text.split('\r\n')[0]).toContain('Notfunk-Nr.;Referenz Meldesammelstelle;Datum;Uhrzeit');
  for (const n of ['W1-001', 'W1-003', 'W1-004']) expect(text).toContain(n);
  expect(text).not.toContain('W1-002');
});

test('keyboard: Shift+Enter saves, warnings ask once, Esc asks before discarding', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-08T10:00:00Z')); // 12:00
  await openNewOp(page, 'E2E Tastatur', 'k1');
  // date and time show "now" from the start, running with the clock
  await expect(page.locator('#m-date')).toHaveValue('2026-10-08');
  await expect(page.locator('#m-time')).toHaveValue('12:00');
  await expect(page.locator('#m-time')).toHaveClass(/\blive\b/);
  await page.locator('#m-from').fill('LI 9');
  // the first keystroke of the message keeps that moment
  await expect(page.locator('#m-time')).not.toHaveClass(/\blive\b/);
  await expect(page.locator('#m-time')).toHaveValue('12:00');
  await page.locator('#m-subject').fill('Probe');
  // missing text: an error at the field, nothing saved
  await page.locator('#m-subject').press('Shift+Enter');
  await expect(page.locator('#m-text-err')).toHaveText('Inhalt fehlt');
  await expect(page.locator('#m-text')).toBeFocused();
  // Enter in the text is a new line
  await page.locator('#m-text').type('Zeile 1');
  await page.locator('#m-text').press('Enter');
  await page.locator('#m-text').type('Zeile 2');
  await expect(page.locator('#m-text')).toHaveValue('Zeile 1\nZeile 2');
  // warnings (no Funkstelle): asked once, marked at the field, then saved
  await page.locator('#m-text').press('Control+Enter');
  await expect(page.locator('#warn-bar')).toBeVisible();
  await expect(page.locator('#warn-list')).toContainText('Funkstelle fehlt');
  await expect(page.locator('#m-peer-warn')).toHaveText('Funkstelle fehlt');
  await expect(page.locator('#m-peer')).toHaveAttribute('data-warned', 'true');
  // a time in the future: marked at date and time too
  await page.locator('#m-time').fill('23:59');
  await page.locator('#m-text').press('Control+Enter');
  await expect(page.locator('#m-time-warn')).toHaveText('Zeit liegt in der Zukunft');
  await expect(page.locator('#m-time')).toHaveAttribute('data-warned', 'true');
  await expect(page.locator('#m-date')).toHaveAttribute('data-warned', 'true');
  await page.locator('#btn-warn-back').click();
  await expect(page.locator('#m-time-warn')).toBeEmpty();
  await expect(page.locator('#m-time')).not.toHaveAttribute('data-warned', 'true');
  await page.locator('#m-time').fill('12:00');
  await page.locator('#m-text').press('Control+Enter');
  await expect(page.locator('#warn-bar')).toBeVisible();
  await page.locator('#m-text').press('Shift+Enter');
  await expect(page.locator('#book-body')).toContainText('K1-001');
  // Esc on a filled form asks; Esc again keeps it
  await page.locator('#m-subject').fill('halb');
  await page.locator('#m-subject').press('Escape');
  await expect(page.locator('#discard-bar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#discard-bar')).toBeHidden();
  await expect(page.locator('#m-subject')).toHaveValue('halb');
  await expect(page.locator('#m-subject')).toBeFocused();
  // discard, then undo
  await page.locator('#m-subject').press('Escape');
  await page.getByRole('button', { name: 'Verwerfen', exact: true }).last().click();
  await expect(page.locator('#m-subject')).toHaveValue('');
  await page.getByRole('button', { name: 'Rückgängig' }).click();
  await expect(page.locator('#m-subject')).toHaveValue('halb');
});

test('time: Austrian local time; in the repeated hour the form asks MESZ or MEZ', async ({ page }) => {
  // 02:10 MEZ on 25 Oct 2026: the second 02:10 of that night
  await page.clock.setFixedTime(new Date('2026-10-25T01:10:00Z'));
  await openNewOp(page, 'E2E Zeitumstellung', 'z1');
  await expect(page.locator('#clock-local')).toHaveText('02:10 MEZ');
  await page.locator('#m-from').fill('LI 9');
  await expect(page.locator('#m-date')).toHaveValue('2026-10-25');
  await expect(page.locator('#m-time')).toHaveValue('02:10');
  await expect(page.locator('#m-zone')).toBeVisible();
  await expect(page.locator('#m-zone')).toHaveValue('MEZ');
  await page.locator('#m-time').fill('03:10');
  await expect(page.locator('#m-zone')).toBeHidden();
  await page.locator('#m-time').fill('02:30');
  await page.locator('#m-zone').selectOption('MESZ');
  await page.locator('#m-peer').fill('OE1ABC');
  await page.locator('#m-subject').fill('Zeitumstellung');
  await page.locator('#m-text').fill('Probe in der doppelten Stunde.');
  await page.locator('#m-readback').check();
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText('02:30 MESZ');
});

test('pickers: calendar and time grid write YYYY-MM-DD and 24-hour HH:MM', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-08T12:05:00Z')); // 14:05
  await openNewOp(page, 'E2E Auswahl', 'p1');
  const form = page.locator('#msg-form');
  await form.getByRole('button', { name: 'Kalender' }).first().click();
  const cal = form.getByRole('dialog', { name: 'Kalender' }).first();
  await expect(cal).toContainText('Oktober 2026');
  await cal.getByRole('button', { name: 'Voriger Monat' }).click();
  await expect(cal).toContainText('September 2026');
  await cal.getByRole('button', { name: '30. September 2026' }).click();
  await expect(page.locator('#m-date')).toHaveValue('2026-09-30');
  await expect(cal).toBeHidden();
  await form.getByRole('button', { name: 'Uhrzeit wählen' }).first().click();
  const grid = form.getByRole('dialog', { name: 'Uhrzeit wählen' }).first();
  await grid.getByRole('button', { name: '21 Uhr' }).click();
  await grid.getByRole('button', { name: '21:45' }).click();
  await expect(page.locator('#m-time')).toHaveValue('21:45');
  // empty field: opens on now; Jetzt / Heute fill it
  await page.locator('#m-date').fill('');
  await form.getByRole('button', { name: 'Kalender' }).first().click();
  await expect(cal).toContainText('Oktober 2026');
  await cal.getByRole('button', { name: 'Heute' }).click();
  await expect(page.locator('#m-date')).toHaveValue('2026-10-08');
  await form.getByRole('button', { name: 'Uhrzeit wählen' }).first().click();
  await grid.getByRole('button', { name: 'Jetzt' }).click();
  await expect(page.locator('#m-time')).toHaveValue('14:05');
  // Esc closes without a change
  await form.getByRole('button', { name: 'Kalender' }).first().click();
  await page.keyboard.press('Escape');
  await expect(cal).toBeHidden();
  await expect(page.locator('#m-date')).toHaveValue('2026-10-08');
});

test('help: F1 opens it, Esc closes it, the form and the focus stay', async ({ page }) => {
  await openNewOp(page, 'E2E Hilfe', 'q1');
  await page.locator('#m-to').fill('Stab S4');
  await page.locator('#m-to').press('F1');
  await expect(page.locator('#help-dlg')).toBeVisible();
  await expect(page.locator('#help-dlg')).toContainText('Funkstelle');
  // the same words as the Einsatz fields
  await expect(page.locator('#help-dlg')).toContainText('Für Stelle');
  await expect(page.locator('#help-dlg')).toContainText('Standort der Station');
  await page.keyboard.press('Escape');
  await expect(page.locator('#help-dlg')).toBeHidden();
  await expect(page.locator('#m-to')).toBeFocused();
  await expect(page.locator('#m-to')).toHaveValue('Stab S4');
  await page.getByRole('button', { name: 'Hilfe' }).click();
  await expect(page.locator('#help-dlg')).toBeVisible();
  await page.getByRole('button', { name: 'Schließen (Esc)' }).click();
  await expect(page.locator('#help-dlg')).toBeHidden();
});

test('handover: steps with who and when, the staff reference apart from the number', async ({ page }) => {
  await openNewOp(page, 'E2E Übergabe', 'u1');
  await addMessage(page, 'Lichtinsel 2', 'Wasser');
  await page.locator('#book-body a', { hasText: 'U1-001' }).click();
  await page.getByLabel('Übergeben an').fill('Meldesammelstelle');
  await page.getByRole('button', { name: 'Übergabe eintragen' }).click();
  await expect(page.locator('#msg-detail')).toContainText('an Meldesammelstelle');
  await page.getByLabel('Übernommen durch').fill('S6 Huber');
  await page.getByRole('button', { name: 'Übernahme eintragen' }).click();
  await expect(page.locator('#msg-detail')).toContainText('durch S6 Huber');
  await expect(page.getByRole('button', { name: 'Übernahme eintragen' })).toHaveCount(0);
  await page.getByLabel('Referenz / Geschäftsbuch-Nr.').fill('GZ 0412');
  await page.getByRole('button', { name: 'Referenz eintragen' }).click();
  await expect(page.locator('#msg-detail .detail-tags')).toContainText('Ref. GZ 0412');
  await page.getByRole('button', { name: '← Meldebuch' }).click();
  const row = page.locator('#book-body tr', { hasText: 'U1-001' });
  await expect(row).toContainText('übernommen');
  await expect(row).toContainText('Ref. GZ 0412');
});

test('print: one A4 page, white, the staff block on top', async ({ page, browserName }) => {
  await openNewOp(page, 'E2E Druck', 'p1');
  await addMessage(page, 'Lichtinsel 12', 'Aggregat ausgefallen');
  await page.evaluate(() => { globalThis.print = () => {}; });
  await page.getByRole('button', { name: 'Ausdruck P1-001 (Meldeaufnahmeformular)' }).click();
  // the first time: how to set up the print dialog
  await expect(page.locator('#print-dlg')).toBeVisible();
  await expect(page.locator('#print-dlg')).toContainText('Kopf- und Fußzeilen');
  await page.locator('#print-dlg-ok').click();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#print-sheet .pf-num')).toHaveText('P1-001');
  await expect(page.locator('#print-sheet .pf-dir.on')).toContainText('EINGANG');
  await expect(page.locator('#print-sheet .pf-staff')).toContainText('Nur von der Meldesammelstelle auszufüllen');
  await expect(page.locator('#view-book')).toBeHidden();
  await expect(page.locator('#site-header')).toBeHidden();
  // one page in Safari too: no page margin while the form prints, and the
  // sheet fits WebKit's A4 page (it prints 1 px as 0.8 pt: 744 × 1052 px)
  const pageMargin = () => page.evaluate(() => [...document.styleSheets].flatMap(s => [...s.cssRules])
    .find(r => r instanceof CSSPageRule).style.marginTop);
  expect(await pageMargin()).toBe('0px');
  const box = await page.locator('#print-sheet .pf-sheet').boundingBox();
  expect(box.height).toBeLessThanOrEqual(1052);
  if (browserName === 'chromium') {
    const pdf = (await page.pdf({ preferCSSPageSize: true })).toString('latin1');
    expect(pdf.match(/\/Type\s*\/Page[^s]/g)).toHaveLength(1);
  }
  await page.evaluate(() => globalThis.dispatchEvent(new Event('afterprint')));
  expect(await pageMargin()).toBe('12mm');
  await page.emulateMedia({ media: 'screen' });
  await expect(page.locator('#print-sheet')).toBeHidden();
});

test('Einsatz header: a change applies to new messages, the code stays once used', async ({ page }) => {
  await openNewOp(page, 'E2E Header', 'h1');
  await page.locator('#op-panel > summary').click();
  await expect(page.locator('#e-prefix')).toBeEditable();
  await addMessage(page, 'LI 1', 'Erste');
  await expect(page.locator('#e-prefix')).not.toBeEditable();
  // a complete call that isn't in the callsign list: Enter keeps it, also
  // once the suggestions (100 ms after typing, e.g. OE3XYL) are there
  await page.locator('#e-operator').fill('oe3xyz');
  await page.waitForTimeout(300);
  await page.locator('#e-operator').press('Enter');
  await expect(page.locator('#op-sum')).toContainText('Op OE3XYZ');
  await addMessage(page, 'LI 2', 'Zweite');
  await expect(page.locator('#book-body tr', { hasText: 'H1-002' })).toContainText('OE3XYZ');
  await expect(page.locator('#book-body tr', { hasText: 'H1-001' })).toContainText('OE1EBG');
  // relay lookup from the ÖVSV list, as in the confirmation log: a pick
  // also sets the frequency
  await page.locator('#e-via').fill('oe1x');
  await expect(page.locator('#e-via-pop .ac-item').first()).toBeVisible();
  await page.locator('#e-via').press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#e-via')).toHaveValue(/^OE1X/);
  await expect(page.locator('#e-freq')).not.toHaveValue('');
  await expect(page.locator('#op-sum')).toContainText('via OE1X');
});

test('print: an empty form to print a stack of', async ({ page }) => {
  await page.goto('tools/notfunk/');
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await page.evaluate(() => { globalThis.print = () => {}; });
  await page.getByRole('button', { name: 'Leeres Formular drucken / PDF' }).click();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#print-sheet .pf-sheet.blank')).toBeVisible();
  await expect(page.locator('#print-sheet .pf-box.on, #print-sheet .pf-dot.on')).toHaveCount(0);
  await expect(page.locator('#print-sheet')).toContainText('Dringlichkeit');
  await expect(page.locator('#print-sheet')).not.toContainText('Stab herhören!');
  await expect(page.locator('#view-ops')).toBeHidden();
});

test('service worker installs the offline copy', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await page.goto('tools/notfunk/');
  await expect(page.locator('#st-offline')).toHaveText(/offline bereit/, { timeout: 45_000 });
});
