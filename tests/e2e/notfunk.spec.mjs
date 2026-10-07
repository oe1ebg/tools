// Notfunk-Meldebuch (/notfunk/): an operation is created, messages get
// gapless numbers (a deleted one keeps its number), the status moves on,
// a reply marks the original answered, an edit keeps a revision, the
// Geschäftsbuch CSV downloads and the print layout shows only the form.
import { test, expect, downloadText } from './fixtures.mjs';

async function openNewOp(page, name, prefix) {
  await page.goto('notfunk/');
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
  await page.locator('#m-subject').fill(subject);
  await page.locator('#m-text').fill(text);
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText(subject);
}

const numbers = page => page.locator('#book-body td.num').allTextContents();

test('loads and shows the operations', async ({ page }) => {
  await page.goto('notfunk/');
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

  // forward W1-001 from the table
  await page.getByRole('button', { name: 'W1-001 weiterleiten' }).click();
  await expect(page.locator('#book-body tr', { hasText: 'W1-001' })).toContainText('weitergeleitet');

  // delete W1-002: the number stays taken
  await page.locator('#book-body a', { hasText: 'W1-002' }).click();
  await expect(page.locator('#msg-title')).toHaveText('W1-002');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Löschen' }).click();
  await expect(page.locator('#msg-detail')).toContainText('gelöscht');
  await page.getByRole('button', { name: '← Meldebuch' }).click();
  await expect.poll(() => numbers(page)).toEqual(['W1-003', 'W1-001']);
  await expect(page.locator('#form-number')).toHaveText('→ W1-004');

  // reply to W1-001: the reply gets W1-004, the original is answered
  await page.locator('#book-body a', { hasText: 'W1-001' }).click();
  await page.getByRole('button', { name: 'Antwort erfassen' }).click();
  await expect(page.locator('#form-reply')).toContainText('W1-001');
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
  expect(text.split('\r\n')[0]).toContain('GZ;Datum;Uhrzeit');
  for (const n of ['W1-001', 'W1-003', 'W1-004']) expect(text).toContain(n);
  expect(text).not.toContain('W1-002');
});

test('keyboard: Shift+Enter saves, Esc discards with undo', async ({ page }) => {
  await openNewOp(page, 'E2E Tastatur', 'k1');
  await page.locator('#m-from').fill('LI 9');
  await page.locator('#m-subject').fill('Probe');
  await page.locator('#m-subject').press('Shift+Enter');
  await expect(page.locator('#book-body')).toContainText('K1-001');
  await page.locator('#m-subject').fill('halb');
  await page.locator('#m-subject').press('Escape');
  await expect(page.locator('#m-subject')).toHaveValue('');
  await page.getByRole('button', { name: 'Rückgängig' }).click();
  await expect(page.locator('#m-subject')).toHaveValue('halb');
});

test('print: only the Meldeaufnahmeformular', async ({ page }) => {
  await openNewOp(page, 'E2E Druck', 'p1');
  await addMessage(page, 'Lichtinsel 12', 'Aggregat ausgefallen');
  await page.evaluate(() => { globalThis.print = () => {}; });
  await page.getByRole('button', { name: 'Meldeaufnahmeformular P1-001 drucken' }).click();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#print-sheet .pf-num')).toHaveText('P1-001');
  await expect(page.locator('#print-sheet')).toContainText('Vom Stab auszufüllen: Geschäftszahl, Auszeichnung');
  await expect(page.locator('#view-book')).toBeHidden();
  await expect(page.locator('#site-header')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await expect(page.locator('#print-sheet')).toBeHidden();
});

test('Einsatz header: a change applies to new messages, the code stays once used', async ({ page }) => {
  await openNewOp(page, 'E2E Header', 'h1');
  await page.locator('#op-panel > summary').click();
  await expect(page.locator('#e-prefix')).toBeEditable();
  await addMessage(page, 'LI 1', 'Erste');
  await expect(page.locator('#e-prefix')).not.toBeEditable();
  await page.locator('#e-operator').fill('oe3xyz');
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
  await page.goto('notfunk/');
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await page.evaluate(() => { globalThis.print = () => {}; });
  await page.getByRole('button', { name: 'Leeres Formular drucken / PDF' }).click();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#print-sheet .pf-sheet.blank')).toBeVisible();
  await expect(page.locator('#print-sheet .pf-box.on')).toHaveCount(0);
  await expect(page.locator('#print-sheet')).toContainText('Stab herhören!');
  await expect(page.locator('#view-ops')).toBeHidden();
});

test('service worker installs the offline copy', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await page.goto('notfunk/');
  await expect(page.locator('#st-offline')).toHaveText(/offline bereit/, { timeout: 45_000 });
});
