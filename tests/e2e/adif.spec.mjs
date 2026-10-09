// ADIF editor (/tools/adif/): a file loads into the table, the .adi export passes
// the strict ADIF 3.1.7 reader, CSV export downloads.
import { fileURLToPath } from 'node:url';
import { test, expect, downloadText } from './fixtures.mjs';
import { readADI } from '../adif-spec.mjs';
import { validateAdif } from '../../tools/shared/js/adif-validate.js';

const SAMPLE = fileURLToPath(new URL('fixtures/sample.adi', import.meta.url));

async function loadSample(page) {
  await page.goto('tools/adif/');
  await expect(page).toHaveTitle('ADIF Editor');
  await expect(page.locator('#btn-export')).toBeDisabled();
  await page.locator('#file-input').setInputFiles(SAMPLE);
  await expect(page.locator('#drop table')).toBeVisible();
  await expect(page.locator('#stats')).toContainText('3 QSOs');
}

test('loads an .adi file and exports it again', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  const body = page.locator('#drop table tbody');
  for (const call of ['OE1ABC', 'OE3XYZ', 'DL1AA']) await expect(body).toContainText(call);
  await expect(page.locator('#file-info')).toContainText('sample.adi: ADIF 3.1.7');

  await expect(page.locator('#btn-export')).toBeEnabled();
  const adiDownload = page.waitForEvent('download');
  await page.locator('#btn-export').click();
  const adi = await adiDownload;
  expect(adi.suggestedFilename()).toBe('sample.adi'); // named after the loaded file
  const { records } = readADI(await downloadText(adi));
  expect(records.map(r => r.CALL)).toEqual(['OE1ABC', 'OE3XYZ', 'DL1AA']);
  expect(records[2].MY_SOTA_REF).toBe('OE/WI-001');

  const csvDownload = page.waitForEvent('download');
  await page.locator('#btn-export-csv').click();
  const csv = await downloadText(await csvDownload);
  expect(csv.split(/\r?\n/)[0]).toContain('CALL');
  expect(csv).toContain('OE3XYZ');
});

test('compliance panel names the spec, the cross-check tools and this build', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  const panel = page.locator('#compliance');
  await panel.locator('summary').click();
  await expect(panel).toContainText('ADIF 3.1.7');
  await expect(panel.getByRole('link', { name: 'adifmt' })).toHaveAttribute('rel', 'noopener');
  await expect(panel.getByRole('link', { name: 'adif-checker' })).toBeVisible();
  // build-info.js (scripts/build_adif.py): a commit link, unless built outside git
  const commit = await page.evaluate(() => globalThis.ADIF_BUILD?.commit);
  expect(commit).toBeTruthy();
  if (commit === 'dev') await expect(panel).toContainText('Development build');
  else await expect(panel.getByRole('link', { name: 'checks for this commit' })).toHaveAttribute('href', /\/commit\/[0-9a-f]+\/checks$/);
});

// The official ADIF test QSOs: 6197 QSOs × 180 fields. The table body is
// virtualized (tools/adif/js/table.js): only the rows around the visible
// part exist; an edit at the end of the log survives scrolling away and
// back and lands in the export.
const OFFICIAL = fileURLToPath(new URL('../fixtures/adif-spec/test-qsos.adi', import.meta.url));

test('a large log loads fast, scrolls and exports edits', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('tools/adif/');
  const start = Date.now();
  await page.locator('#file-input').setInputFiles(OFFICIAL);
  await expect(page.locator('#stats')).toContainText('6197 QSOs', { timeout: 30_000 });
  await expect(page.locator('#validation-summary')).toContainText('ADIF valid');
  // generous: ~0.15 s in desktop Chromium, 4.4 s before the virtual table
  expect(Date.now() - start).toBeLessThan(20_000);
  const rows = page.locator('#drop tbody tr[data-ri]');
  expect(await rows.count()).toBeGreaterThan(5);
  expect(await rows.count()).toBeLessThan(400);

  await page.locator('#drop').evaluate(d => { d.scrollTop = d.scrollHeight; });
  const lastCall = page.locator('#drop tbody tr[data-ri="6196"] td[data-col="CALL"]');
  await expect(lastCall).toBeVisible();
  expect(await rows.count()).toBeLessThan(400);
  await lastCall.click();
  await lastCall.fill('OE1ZZZ');
  await lastCall.press('Enter'); // last row: takes the value
  await expect(page.locator('#validation-summary')).toContainText('current log');

  await page.locator('#drop').evaluate(d => { d.scrollTop = 0; });
  await expect(page.locator('#drop tbody tr[data-ri="0"]')).toBeVisible();
  await expect(lastCall).toHaveCount(0); // scrolled out of the DOM
  await page.locator('#drop').evaluate(d => { d.scrollTop = d.scrollHeight; });
  await expect(lastCall).toHaveText('OE1ZZZ');

  const adiDownload = page.waitForEvent('download');
  await page.locator('#btn-export').click();
  // (the strict reader of adif-spec.mjs rejects the official file's
  // application-defined fields without a type indicator; see the README's
  // known gaps)
  const check = validateAdif(await downloadText(await adiDownload), { today: '20991231' });
  expect(check.errors).toBe(0);
  expect(check.records).toHaveLength(6197);
  expect(check.records[6196].fields.CALL).toBe('OE1ZZZ');
});
