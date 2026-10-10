// Confirmation log (/tools/confirm/): loads, a log can be created and a check-in
// logged, the offline location search answers, CSV and ADIF export download
// and the ADI file passes the strict ADIF 3.1.7 reader the unit tests use.
import { test, expect, downloadText } from './fixtures.mjs';
import { readADI } from '../adif-spec.mjs';

async function openNewLog(page, title) {
  await page.goto('tools/confirm/');
  // (the <h1> is hidden at phone widths)
  await expect(page).toHaveTitle('Bestätigungsverkehr');
  await expect(page.locator('#view-events')).toBeVisible();
  await expect.poll(() => page.evaluate(() => globalThis.CONFIRM_READY === true)).toBe(true);
  await page.getByRole('button', { name: '+ Neues Log' }).click();
  await page.locator('#new-event input[name="title"]').fill(title);
  await page.getByRole('button', { name: /Log anlegen/ }).click();
  await expect(page.locator('#view-log')).toBeVisible();
  await expect(page.locator('#log-title')).toHaveValue(title);
}

async function logCall(page, call) {
  await page.locator('#f-call').fill(call);
  await page.locator('#btn-save').click();
  await expect(page.locator('#log-body')).toContainText(call);
}

async function exportAs(page, kind) {
  await page.locator('#btn-export-menu').click();
  const download = page.waitForEvent('download');
  await page.locator(`#export-list [data-export="${kind}"]`).click();
  return download;
}

test('loads and shows the log list', async ({ page }) => {
  await page.goto('tools/confirm/');
  await expect(page.locator('#view-events')).toBeVisible();
  await expect(page.locator('#banner')).toBeHidden();
  // The app started (index.html shows a banner after 8 s otherwise).
  await expect.poll(() => page.evaluate(() => globalThis.CONFIRM_STARTED === true)).toBe(true);
  // Storage opened (not the #st-storage chip: Firefox asks the user before
  // navigator.storage.persist() resolves, so it stays "prüfe…" headless).
  await expect(page.locator('#st-backend')).toHaveText('IndexedDB');
});

test('logs a check-in and exports CSV and ADIF', async ({ page }) => {
  await openNewLog(page, 'E2E Rundspruch');
  await logCall(page, 'OE1ABC');
  await logCall(page, 'OE3XYZ');
  await expect(page.locator('#st-unique')).toHaveText('2');
  await expect(page.locator('#st-total')).toHaveText('2');

  const csvDownload = await exportAs(page, 'csv');
  expect(csvDownload.suggestedFilename()).toMatch(/_E2E-Rundspruch\.csv$/);
  const csv = await downloadText(csvDownload);
  expect(csv).toContain('OE1ABC');
  expect(csv).toContain('OE3XYZ');

  // An empty header (no frequency/mode) makes the ADIF export list what a
  // logbook program would miss first; export anyway.
  await page.locator('#btn-export-menu').click();
  const adifDownload = page.waitForEvent('download');
  await page.locator('#export-list [data-export="adif"]').click();
  const force = page.getByRole('button', { name: 'Trotzdem exportieren' });
  await Promise.race([adifDownload, force.waitFor()]);
  if (await force.isVisible()) await force.click();
  const adi = await adifDownload;
  expect(adi.suggestedFilename()).toMatch(/\.adi$/);
  const text = await downloadText(adi);
  expect(text).toMatch(/<EOH>/i);
  const { records } = readADI(text);
  expect(records.map(r => r.CALL)).toEqual(['OE1ABC', 'OE3XYZ']);
});

test('offline location search finds a landmark', async ({ page }) => {
  await page.goto('tools/confirm/');
  await expect.poll(() => page.evaluate(() => globalThis.CONFIRM_READY === true)).toBe(true);
  await page.getByRole('button', { name: /Standort/ }).click();
  await expect(page.locator('#loc-panel')).toBeVisible();
  await page.locator('#loc-q').fill('Donauturm');
  await expect(page.locator('#loc-results .loc-cand').first()).toContainText('Donauturm', { timeout: 30_000 });
  await expect(page.locator('#loc-status')).toHaveClass(/ok/);
});

test('two immediate submits create one line with number 1', async ({ page }) => {
  await openNewLog(page, 'E2E Doppelt');
  await page.locator('#f-call').fill('OE1ABC');
  // Enter and button in the same tick: the second must be ignored.
  await page.evaluate(() => {
    const form = document.querySelector('#entry-form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#log-body')).toContainText('OE1ABC');
  await expect(page.locator('#st-total')).toHaveText('1');
  const backup = JSON.parse(await downloadText(await exportAs(page, 'json')));
  const { event, entries } = backup.events[0];
  expect(entries.map(e => e.seq)).toEqual([1]);
  expect(event.nextSeq).toBe(2);
  // the guard is released: the next line is number 2
  await logCall(page, 'OE3XYZ');
  const again = JSON.parse(await downloadText(await exportAs(page, 'json')));
  expect(again.events[0].entries.map(e => e.seq).sort()).toEqual([1, 2]);
});

test('importing a backup that reuses a line id leaves the existing log untouched', async ({ page }) => {
  await openNewLog(page, 'E2E Bestand');
  await logCall(page, 'OE1ABC');
  const backup = JSON.parse(await downloadText(await exportAs(page, 'json')));
  const orig = backup.events[0];
  // Same line id (and a revision of it), fresh event id, other callsign.
  const foreign = JSON.parse(JSON.stringify(orig));
  foreign.event.id = 'fremdes-log';
  foreign.event.title = 'E2E Fremd';
  foreign.entries[0].eventId = 'fremdes-log';
  foreign.entries[0].call = 'OE9ZZZ';
  foreign.revisions = [{ id: 'rev-1', eventId: 'fremdes-log', entryId: foreign.entries[0].id, savedAt: foreign.entries[0].created, reason: 'edit', data: { ...orig.entries[0], eventId: 'fremdes-log' } }];
  await page.getByRole('button', { name: '← Logs' }).click();
  await expect(page.locator('#view-events')).toBeVisible();
  await page.locator('#import-file').setInputFiles({
    name: 'fremd.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...backup, events: [foreign] })),
  });
  await expect(page.locator('#import-msg')).toContainText('1 Log importiert');
  await expect(page.locator('#import-msg')).toContainText('als Kopie');
  await expect(page.locator('#import-msg')).toContainText('nichts wurde überschrieben');
  // Open the original: still OE1ABC, still its own log.
  await page.locator('#event-list').getByText('E2E Bestand', { exact: true }).first().click();
  await expect(page.locator('#log-body')).toContainText('OE1ABC');
  await expect(page.locator('#log-body')).not.toContainText('OE9ZZZ');
  await expect(page.locator('#st-total')).toHaveText('1');
});

test('a malformed backup is rejected as a whole and changes nothing', async ({ page }) => {
  await openNewLog(page, 'E2E Unberührt');
  await logCall(page, 'OE1ABC');
  const backup = JSON.parse(await downloadText(await exportAs(page, 'json')));
  const bad = JSON.parse(JSON.stringify(backup.events[0]));
  bad.event.id = 'kaputt';
  bad.entries = [{ id: 'x', eventId: 'kaputt', seq: 'eins', call: 'OE1X', ts: 'gestern' }];
  const valid = JSON.parse(JSON.stringify(backup.events[0]));
  valid.event.id = 'gueltig';
  valid.event.title = 'E2E Gültig';
  valid.entries[0] = { ...valid.entries[0], id: 'gueltig-1', eventId: 'gueltig' };
  await page.getByRole('button', { name: '← Logs' }).click();
  await page.locator('#import-file').setInputFiles({
    name: 'kaputt.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...backup, events: [valid, bad] })),
  });
  await expect(page.locator('#import-msg')).toContainText('Nicht importiert');
  await expect(page.locator('#import-msg')).toContainText('es wurde nichts geändert');
  // not even the valid first log was added
  await expect(page.locator('#event-list')).not.toContainText('E2E Gültig');
  await expect(page.locator('#event-list')).toContainText('E2E Unberührt');
});

test('service worker installs the offline copy', async ({ page, browserName }) => {
  // Playwright drives service workers reliably only in Chromium.
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await page.goto('tools/confirm/');
  await expect(page.locator('#st-offline')).toHaveText(/offline bereit/, { timeout: 45_000 });
});
