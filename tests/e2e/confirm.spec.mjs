// Confirmation log (/confirm/): loads, a log can be created and a check-in
// logged, the offline location search answers, CSV and ADIF export download
// and the ADI file passes the strict ADIF 3.1.7 reader the unit tests use.
import { test, expect, downloadText } from './fixtures.mjs';
import { readADI } from '../adif-spec.mjs';

async function openNewLog(page, title) {
  await page.goto('confirm/');
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
  await page.goto('confirm/');
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
  await page.goto('confirm/');
  await expect.poll(() => page.evaluate(() => globalThis.CONFIRM_READY === true)).toBe(true);
  await page.getByRole('button', { name: /Standort/ }).click();
  await expect(page.locator('#loc-panel')).toBeVisible();
  await page.locator('#loc-q').fill('Donauturm');
  await expect(page.locator('#loc-results .loc-cand').first()).toContainText('Donauturm', { timeout: 30_000 });
  await expect(page.locator('#loc-status')).toHaveClass(/ok/);
});

test('service worker installs the offline copy', async ({ page, browserName }) => {
  // Playwright drives service workers reliably only in Chromium.
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await page.goto('confirm/');
  await expect(page.locator('#st-offline')).toHaveText(/offline bereit/, { timeout: 45_000 });
});
