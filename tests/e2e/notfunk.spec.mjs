// Notfunk-Meldebuch (/tools/notfunk/): an operation is created, messages get
// gapless numbers (a deleted one keeps its number), the status moves on,
// a reply marks the original answered, an edit keeps a revision, the
// Geschäftsbuch CSV downloads, the print layout shows only the form (one
// A4 page), the help opens and closes without touching the form.
import { test, expect, downloadText, offlineSettled } from './fixtures.mjs';

async function openNewOp(page, name, prefix) {
  await page.goto('tools/notfunk/');
  await expect(page).toHaveTitle('Notfunk-Meldebuch');
  await expect(page.locator('#view-ops')).toBeVisible();
  // the buttons work only once the app has started
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await offlineSettled(page);
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

// Issue #15: the book keeps its rows between renders (keyed by message and
// its `updated` token); search and filter show exactly the matching rows.
test('search, filter and a status step keep the rows of unchanged messages', async ({ page }) => {
  await openNewOp(page, 'E2E Zeilen', 'w1');
  await addMessage(page, 'Lichtinsel 3', 'Wasser');
  await addMessage(page, 'Lichtinsel 4', 'Strom');
  await addMessage(page, 'Lichtinsel 5', 'Diesel');
  const rows = page.locator('#book-body tr[data-id]');
  await expect(rows).toHaveCount(3);
  await page.evaluate(() => document.querySelectorAll('#book-body tr[data-id]').forEach((tr, i) => { tr.probe = i; }));
  const kept = () => page.evaluate(() => [...document.querySelectorAll('#book-body tr[data-id]')].map(tr => tr.probe ?? null));
  expect(await numbers(page)).toEqual(['W1-003', 'W1-002', 'W1-001']);

  // search: only the match, the same row node
  await page.locator('#book-search').fill('strom');
  await expect.poll(() => numbers(page)).toEqual(['W1-002']);
  expect(await kept()).toEqual([1]);
  await page.locator('#book-search').fill('gibtsnicht');
  await expect(page.locator('#book-body td.empty')).toContainText('Keine Meldung passt zum Filter.');
  await page.locator('#book-search').fill('');
  await expect.poll(() => numbers(page)).toEqual(['W1-003', 'W1-002', 'W1-001']);

  // filter: open messages, then incoming; all three are open and incoming
  await page.locator('[data-filter="out"]').click();
  await expect(page.locator('#book-body td.empty')).toBeVisible();
  await page.locator('[data-filter="all"]').click();
  await expect.poll(() => numbers(page)).toEqual(['W1-003', 'W1-002', 'W1-001']);
  await page.evaluate(() => document.querySelectorAll('#book-body tr[data-id]').forEach((tr, i) => { tr.probe = i; }));

  // a status step rebuilds that row only, and the order stays
  await page.getByRole('button', { name: 'W1-002 übergeben' }).click();
  await expect.poll(kept).toEqual([0, null, 2]);
  await expect(page.locator('#book-body tr', { hasText: 'W1-002' }).locator('.pill')).toContainText('übergeben');
  expect(await numbers(page)).toEqual(['W1-003', 'W1-002', 'W1-001']);

  // a click on a row still opens the message
  await page.locator('#book-body tr', { has: page.locator('td.num', { hasText: 'W1-001' }) }).locator('td.content').click();
  await expect(page.locator('#msg-title')).toHaveText('W1-001');
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
  // the book row: Von → An, below the Funkstelle and via relay or direct
  await expect(page.locator('#book-body tr', { hasText: 'H1-001' }).locator('td.parties')).toContainText('OE1ABC · direkt');
  // the own station's callsign, apart from the operator's
  await page.locator('#e-call').fill('oe1xks');
  await page.locator('#e-call').press('Tab');
  await expect(page.locator('#op-sum')).toContainText('OE1XKS');
  await expect(page.locator('#form-station')).toHaveText('Station OE1XKS · ');
  await expect(page.locator('#form-op')).toHaveText('OE1EBG');
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

// #11: the save is one transaction; what comes after it may fail without
// the message looking unsaved or a retry numbering it twice.
test('save: a failing station write after the commit warns only, the message is in the book, no duplicate', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function inject(...args) {
      if (this.name === 'stations') throw new DOMException('injected', 'DataError');
      return put.apply(this, args);
    };
  });
  await openNewOp(page, 'E2E Fehler', 'f1');
  await page.locator('#m-from').fill('Lichtinsel 3');
  await page.locator('#m-peer').fill('OE1ABC');
  await page.locator('#m-subject').fill('Wasser');
  await page.locator('#m-text').fill('Kein Wasser.');
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText('Wasser');
  expect(await numbers(page)).toEqual(['F1-001']);
  const banner = page.locator('#banner');
  await expect(banner).toContainText('F1-001 ist gespeichert');
  await expect(banner).not.toContainText('FEHLGESCHLAGEN');
  // the form is clear: the same text can't be saved again by a retry
  await expect(page.locator('#m-subject')).toHaveValue('');
  await expect(page.locator('#form-number')).toHaveText('→ F1-002');
  // a backup is built from what is stored
  const download = page.waitForEvent('download');
  await page.locator('#btn-backup').click();
  const backup = JSON.parse(await downloadText(await download));
  expect(backup.messages.map(m => m.number)).toEqual(['F1-001']);
});

test('two tabs: a stale edit is refused, the handover is not lost, the input stays', async ({ page, context }) => {
  await openNewOp(page, 'E2E Tabs', 't1');
  await addMessage(page, 'Lichtinsel 2', 'Wasser');
  // tab A starts editing T1-001
  await page.locator('#book-body a', { hasText: 'T1-001' }).click();
  const detailUrl = page.url();
  await page.getByRole('button', { name: 'Bearbeiten' }).click();
  await page.locator('#m-subject').fill('Wasser dringend');
  // tab B records the handover meanwhile
  const b = await context.newPage();
  await b.goto(detailUrl);
  await expect.poll(() => b.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await b.getByLabel('Übergeben an').fill('Meldesammelstelle');
  await b.getByRole('button', { name: 'Übergabe eintragen' }).click();
  await expect(b.locator('#msg-detail')).toContainText('an Meldesammelstelle');
  // tab A saves its edit: refused, with the current version loaded and the input kept
  await expect(page.locator('#book-body tr', { hasText: 'T1-001' })).toContainText('übergeben');
  await page.locator('#btn-save').click();
  await expect(page.locator('#banner')).toContainText('NICHT GESPEICHERT');
  await expect(page.locator('#banner')).toContainText('inzwischen geändert');
  await expect(page.locator('#m-subject')).toHaveValue('Wasser dringend');
  await expect(page.locator('#book-body tr', { hasText: 'T1-001' })).toContainText('Wasser');
  await expect(page.locator('#book-body tr', { hasText: 'T1-001' })).not.toContainText('dringend');
  // saving again (now based on the current version) keeps the handover
  await page.locator('#btn-save').click();
  const row = page.locator('#book-body tr', { hasText: 'T1-001' });
  await expect(row).toContainText('Wasser dringend');
  await expect(row).toContainText('übergeben');
  await b.close();
});

test('two tabs: a second draft is not saved over the first one silently', async ({ page, context }) => {
  await openNewOp(page, 'E2E Entwurf', 'e1');
  const b = await context.newPage();
  await b.goto(page.url());
  await expect.poll(() => b.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await expect(b.locator('#book-title')).toHaveText('E2E Entwurf');
  await page.locator('#m-from').fill('Tab A');
  await expect(page.locator('#draft-status')).toContainText('Entwurf gesichert');
  await b.locator('#m-from').fill('Tab B');
  await expect(b.locator('#banner')).toContainText('ENTWURF NICHT GESICHERT');
  await expect(b.locator('#m-from')).toHaveValue('Tab B');
  // B takes the other draft; A's draft is still the stored one
  await b.getByRole('button', { name: 'Den anderen Entwurf laden' }).click();
  await expect(b.locator('#m-from')).toHaveValue('Tab A');
  await b.close();
});

test('save while the draft debounce is pending: no draft of the saved message comes back', async ({ page }) => {
  await openNewOp(page, 'E2E Entwurf weg', 'd1');
  await page.locator('#m-from').fill('Lichtinsel 3');
  await page.locator('#m-peer').fill('OE1ABC');
  await page.locator('#m-subject').fill('Wasser');
  await page.locator('#m-text').fill('Kein Wasser.'); // the draft write is still pending (600 ms)
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText('Wasser');
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('#view-book')).toBeVisible();
  await expect(page.locator('#book-body')).toContainText('D1-001');
  await expect(page.locator('#m-subject')).toHaveValue('');
  await expect(page.locator('#m-text')).toHaveValue('');
  expect(await numbers(page)).toEqual(['D1-001']);
});

test('edit draft restore: a change made meanwhile is a conflict, the old text is not written back', async ({ page }) => {
  await openNewOp(page, 'E2E Entwurf Bearbeiten', 'b1');
  await addMessage(page, 'Lichtinsel 2', 'Wasser', 'old text');
  await page.locator('#book-body a', { hasText: 'B1-001' }).click();
  await page.getByRole('button', { name: 'Bearbeiten' }).click();
  await page.locator('#m-subject').fill('Wasser dringend');
  await page.waitForTimeout(1000); // the edit draft is saved (with the version it was opened on)
  // another tab changes the stored text meanwhile
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('oe1ebg-notfunk');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('messages', 'readwrite');
      const os = tx.objectStore('messages');
      const all = os.getAll();
      all.onsuccess = () => {
        const m = all.result[0];
        m.text = 'new text from tab B';
        m.updated = new Date(Date.parse(m.updated) + 60000).toISOString();
        os.put(m);
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await expect(page.locator('#m-subject')).toHaveValue('Wasser dringend');
  await page.locator('#btn-save').click();
  await expect(page.locator('#banner')).toContainText('NICHT GESPEICHERT');
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body tr', { hasText: 'B1-001' })).toContainText('Wasser dringend');
  await page.locator('#book-body a', { hasText: 'B1-001' }).click();
  await expect(page.locator('#msg-detail .verbatim')).toContainText('new text from tab B');
  await expect(page.locator('#msg-detail .verbatim')).not.toContainText('old text');
});

test('legacy edit draft (no base), message changed in between: shown, held back until reviewed', async ({ page }) => {
  await openNewOp(page, 'E2E Alter Entwurf', 'l1');
  await addMessage(page, 'Lichtinsel 2', 'Wasser', 'old text');
  await page.locator('#book-body a', { hasText: 'L1-001' }).click();
  await page.getByRole('button', { name: 'Bearbeiten' }).click();
  await page.locator('#m-subject').fill('Wasser dringend');
  await page.waitForTimeout(1000);
  // the draft as it was written before bases were kept (no base, no updated), and the message changed after it
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('oe1ebg-notfunk');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['drafts', 'messages'], 'readwrite');
      const drafts = tx.objectStore('drafts');
      const msgs = tx.objectStore('messages');
      drafts.getAll().onsuccess = ev => {
        const d = ev.target.result[0];
        delete d.base;
        delete d.updated;
        drafts.put(d);
        msgs.getAll().onsuccess = ev2 => {
          const m = ev2.target.result[0];
          m.text = 'new text from tab B';
          m.updated = new Date(Date.parse(d.saved) - 60000).toISOString(); // before the autosave, after the edit was opened
          msgs.put(m);
        };
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await expect(page.locator('#m-subject')).toHaveValue('Wasser dringend');
  await expect(page.locator('#banner')).toContainText('ENTWURF PRÜFEN');
  await expect(page.locator('#banner')).toContainText('Betreff');
  // saving is held back
  await page.locator('#btn-save').click();
  await expect(page.locator('#banner')).toContainText('ENTWURF PRÜFEN');
  await expect(page.locator('#book-body tr', { hasText: 'L1-001' })).not.toContainText('dringend');
  // applying the draft is an explicit choice
  await page.getByRole('button', { name: 'Entwurf auf die aktuelle Fassung anwenden' }).click();
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body tr', { hasText: 'L1-001' })).toContainText('Wasser dringend');
});

// #20: a typed Stichzeit survives a draft restore
test('draft restore keeps a Stichzeit typed as 1405', async ({ page }) => {
  await openNewOp(page, 'E2E Stichzeit', 's1');
  await page.locator('#m-type').selectOption('lagemeldung');
  await page.locator('#m-stichzeit').fill('1405'); // not left yet: the field still shows 1405
  await expect(page.locator('#draft-status')).toContainText('Entwurf gesichert');
  await page.reload();
  await expect(page.locator('#view-book')).toBeVisible();
  await expect(page.locator('#m-type')).toHaveValue('lagemeldung');
  await expect(page.locator('#m-stichzeit')).toHaveValue('14:05');
  // text that can't be read stays, with the warning at the field
  await page.locator('#m-stichzeit').fill('mitta');
  await page.waitForTimeout(1000); // the draft is saved 600 ms after the last keystroke
  await page.reload();
  await expect(page.locator('#m-stichzeit')).toHaveValue('mitta');
});

// Issue #15 review: a backup the tool wrote must be restorable. 1100 messages
// of 50000 characters (~56 MB) exceed the import limit as one file, so the
// export is written in parts; selected together they restore everything.
test('a backup beyond the import limit is exported in parts and restored from them', async ({ page, browser, baseURL, browserName }, testInfo) => {
  // ~55 MB in IndexedDB, the DOM and a second profile: Chromium only, and slow
  test.skip(browserName !== 'chromium', 'heavy (55 MB); one engine is enough');
  test.slow();
  test.setTimeout(360_000);
  await openNewOp(page, 'E2E Groß', 'G1');
  await page.evaluate(async () => {
    const { newMessage, messageFields } = await import(new URL('js/model.js', location.href).href);
    const { formatNumber } = await import(new URL('js/numbering.js', location.href).href);
    const open = await new Promise((res, rej) => { const r = indexedDB.open('oe1ebg-notfunk'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const op = await new Promise(res => { const q = open.transaction('operations').objectStore('operations').getAll(); q.onsuccess = () => res(q.result[0]); });
    const t = open.transaction(['messages', 'counters'], 'readwrite');
    const text = 'x'.repeat(50000);
    for (let i = 1; i <= 1100; i++) {
      const f = messageFields({ direction: 'in', ts: '2026-10-04T16:00:00.000Z', channel: 'funk', radio: { freq: '145.500' }, peer: 'OE1ABC', from: { name: 'Lichtinsel' }, to: { name: 'Stab' }, subject: `Groß ${i}`, text });
      t.objectStore('messages').put(newMessage(f, { prefix: op.prefix, seq: i, number: formatNumber(op.prefix, i) }, { id: `big${i}`, opId: op.id, operator: 'OE1EBG', stationCall: '', now: '2026-10-04T16:00:00.000Z' }));
    }
    t.objectStore('counters').put({ id: `${op.id}:${op.prefix}`, eventId: op.id, prefix: op.prefix, last: 1100 });
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    open.close();
  });
  await page.reload();
  await expect(page.locator('#book-body tr[data-id]')).toHaveCount(1100, { timeout: 60_000 });
  const downloads = [];
  page.on('download', d => downloads.push(d));
  const first = page.waitForEvent('download', { timeout: 120_000 });
  await page.locator('#btn-backup').click();
  // the part count is in the file name (_teil-n-von-M): wait for exactly that many
  const count = Number((await first).suggestedFilename().match(/_teil-\d+-von-(\d+)\.json$/)[1]);
  expect(count).toBeGreaterThanOrEqual(2);
  await expect.poll(() => downloads.length, { timeout: 120_000 }).toBe(count);
  await expect(page.locator('#book-status')).toContainText(`Download von ${count} Dateien gestartet`);
  await expect(page.locator('#st-backup')).toContainText('Noch keine Sicherung'); // not recorded for parts
  const paths = [];
  for (const d of downloads) {
    expect(d.suggestedFilename()).toMatch(/_teil-\d+-von-\d+\.json$/);
    const p = testInfo.outputPath(d.suggestedFilename());
    await d.saveAs(p);
    paths.push(p);
  }
  // a fresh browser profile: one part alone is refused, all together restore the operation
  const ctx = await browser.newContext({ baseURL, locale: 'de-AT', timezoneId: 'Europe/Vienna' });
  try {
    const b = await ctx.newPage();
    await b.goto('tools/notfunk/');
    await expect.poll(() => b.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
    await b.locator('#import-file').setInputFiles(paths.slice(0, 1));
    await expect(b.locator('#import-msg')).toContainText('es fehlen die Teile', { timeout: 60_000 });
    await expect(b.locator('#import-msg')).toContainText('nichts importiert');
    await b.locator('#import-file').setInputFiles(paths);
    await expect(b.locator('#import-msg')).toContainText('1100 Meldungen neu', { timeout: 180_000 });
    await b.getByRole('button', { name: /„E2E Groß“ öffnen/ }).click();
    await expect(b.locator('#book-body tr[data-id]')).toHaveCount(1100, { timeout: 60_000 });
  } finally {
    await ctx.close();
  }
});

// "📍 Standort" in the header, as in Confirm: the offline location search
// (Vienna), on the start page and inside an operation; the form keeps its
// input.
test('offline location search: Standort in the header finds a landmark', async ({ page }) => {
  await page.goto('tools/notfunk/');
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  const btn = page.getByRole('button', { name: /Standort/ });
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.click();
  await expect(page.locator('#loc-panel')).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#loc-q')).toBeFocused();
  await page.locator('#loc-q').fill('Donauturm');
  await expect(page.locator('#loc-results .loc-cand').first()).toContainText('Donauturm', { timeout: 30_000 });
  await expect(page.locator('#loc-status')).toHaveClass(/ok/);
  await page.locator('#loc-close').click();
  await expect(page.locator('#loc-panel')).toBeHidden();

  await openNewOp(page, 'E2E Standort', 's1');
  await page.locator('#m-text').fill('Halb getippt');
  await btn.click();
  await page.locator('#loc-q').fill('Stephansplatz');
  await expect(page.locator('#loc-results .loc-cand').first()).toContainText('Stephansplatz', { timeout: 30_000 });
  await btn.click();
  await expect(page.locator('#loc-panel')).toBeHidden();
  await expect(page.locator('#m-text')).toHaveValue('Halb getippt');
});

// "Karte" in the book: the messages of the book's list at their Ort on the
// offline map of Vienna (nothing requested), pins coloured by priority,
// a card with links to the messages; the map follows filter and search.
test('map: messages with an Ort as pins, priority colour, link to the message, follows the filter', async ({ page }) => {
  await openNewOp(page, 'E2E Karte', 'k1');
  const msg = async (from, subject, { loc, prio } = {}) => {
    await page.locator('#m-from').fill(from);
    await page.locator('#m-peer').fill('OE1ABC');
    await page.locator('#m-subject').fill(subject);
    if (loc) {
      await page.locator('#m-loc').fill(loc);
      await expect(page.locator('#m-loc-info')).toContainText('✓', { timeout: 30_000 });
      await page.locator('#m-loc').press('Escape');
    }
    await page.locator('#m-text').fill(`${subject}, wörtlich.`);
    if (prio) await page.locator(`label[for="m-prio-${prio}"]`).click();
    await page.locator('#m-readback').check();
    await page.locator('#btn-save').click();
    await expect(page.locator('#book-body')).toContainText(subject);
  };
  await msg('FF Floridsdorf', 'Stromausfall Pflegeheim', { loc: 'Brünner Straße 68', prio: 'priority' });
  await msg('Polizei', 'Lage Donauinsel', { loc: 'Donauturm' });
  await msg('Stab', 'Ohne Ort');

  const btn = page.getByRole('button', { name: 'Karte' });
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#map')).toBeVisible();
  await expect(page.locator('#map .map-pin')).toHaveCount(2);
  await expect(page.locator('#map .map-pin.prio-priority')).toHaveCount(1);
  await expect(page.locator('#map-unplaced')).toContainText('1 ohne Ort');
  // the form on top; the button right above the map it opens
  const [form, b, panel] = await Promise.all(['#msg-form', '#btn-map', '#map-panel'].map(s => page.locator(s).boundingBox()));
  expect(form.y + form.height).toBeLessThanOrEqual(b.y);
  expect(panel.y).toBeGreaterThanOrEqual(b.y + b.height);
  expect(panel.y - (b.y + b.height)).toBeLessThan(80);

  // the filter and the search narrow the map too
  await page.locator('#book-search').fill('Donauinsel');
  await expect(page.locator('#map .map-pin')).toHaveCount(1);
  await expect(page.locator('#map .map-pin.prio-priority')).toHaveCount(0);
  await page.locator('#book-search').fill('');
  await expect(page.locator('#map .map-pin')).toHaveCount(2);

  // a pin's card links to the message; leaving the book closes the map
  await page.locator('#map .map-pin.prio-priority').click();
  const link = page.locator('.leaflet-popup a', { hasText: 'K1-001' });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator('#view-msg')).toBeVisible();
  await page.getByRole('button', { name: '← Meldebuch' }).click();
  await expect(page.locator('#map-panel')).toBeHidden();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
});

// An Ort that the lookup doesn't know is saved as text, as the field says
// ("nicht zugeordnet – wird als Text gespeichert"): in the message, the
// edit form, the CSV and the map's list of places not on the map.
test('Ort: an unresolved place is kept as text', async ({ page }) => {
  await openNewOp(page, 'E2E Ort als Text', 't1');
  await page.locator('#m-from').fill('FF Floridsdorf');
  await page.locator('#m-peer').fill('OE1ABC');
  await page.locator('#m-subject').fill('Sammelplatz');
  await page.locator('#m-loc').fill('Hinterhof beim Zirkuszelt');
  await expect(page.locator('#m-loc-info')).toContainText('nicht zugeordnet', { timeout: 30_000 });
  await page.locator('#m-text').fill('Sammelplatz, wörtlich.');
  await page.locator('#m-readback').check();
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText('Sammelplatz');

  await page.getByRole('button', { name: 'Karte' }).click();
  await expect(page.locator('#map-unplaced')).toContainText('1 Meldung mit nicht zugeordnetem Ort: T1-001');
  await page.getByRole('button', { name: 'Karte' }).click();

  await page.locator('#book-body tr[data-id]').first().click();
  await expect(page.locator('#view-msg')).toContainText('Hinterhof beim Zirkuszelt (nicht zugeordnet)');
  await page.getByRole('button', { name: 'Bearbeiten' }).first().click();
  await expect(page.locator('#m-loc')).toHaveValue('Hinterhof beim Zirkuszelt');
});
