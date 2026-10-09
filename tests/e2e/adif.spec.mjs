// ADIF editor (/tools/adif/): a file loads into the table, the .adi export passes
// the strict ADIF 3.1.7 reader, CSV export downloads.
import { fileURLToPath } from 'node:url';
import { test, expect, downloadText } from './fixtures.mjs';
import { readADI } from '../adif-spec.mjs';

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
