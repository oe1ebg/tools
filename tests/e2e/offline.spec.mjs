// The single-file bundles (confirm/confirm-offline.html,
// notfunk/notfunk-offline.html, adif/adif-editor.html) are made for file:// (USB stick, laptop without a
// server): download each from the built site, open the saved copy from
// file:// and check that it starts without errors and loads nothing else.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { test, expect } from './fixtures.mjs';

async function openSavedCopy(page, request, path, testInfo) {
  const res = await request.get(path);
  expect(res.status(), path).toBe(200);
  const file = testInfo.outputPath(path.split('/').pop());
  await writeFile(file, await res.body());
  const url = pathToFileURL(file).href;
  const requests = [];
  page.on('request', req => requests.push(req.url()));
  await page.goto(url);
  return { url, requests };
}

test('confirm-offline.html runs from file://', async ({ page, request }, testInfo) => {
  const { url, requests } = await openSavedCopy(page, request, 'tools/confirm/confirm-offline.html', testInfo);
  await expect(page).toHaveTitle('Bestätigungsverkehr');
  await expect(page.locator('#view-events')).toBeVisible();
  await expect.poll(() => page.evaluate(() => globalThis.CONFIRM_READY === true)).toBe(true);
  // the offline data is inlined: the location search works without a server
  await page.getByRole('button', { name: /Standort/ }).click();
  await page.locator('#loc-q').fill('Donauturm');
  await expect(page.locator('#loc-results .loc-cand').first()).toContainText('Donauturm', { timeout: 30_000 });
  expect(requests.filter(u => u !== url && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
});

test('notfunk-offline.html runs from file://', async ({ page, request }, testInfo) => {
  const { url, requests } = await openSavedCopy(page, request, 'tools/notfunk/notfunk-offline.html', testInfo);
  await expect(page).toHaveTitle('Notfunk-Meldebuch');
  await expect(page.locator('#view-ops')).toBeVisible();
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_STARTED === true)).toBe(true);
  // the file is the offline copy: no download card, no links out of it
  await expect(page.locator('#offline-card')).toBeHidden();
  await expect(page.locator('#st-offline')).toHaveText('Offline-Datei');
  expect(requests.filter(u => u !== url && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
});

test('adif-editor.html runs from file://', async ({ page, request }, testInfo) => {
  const { url, requests } = await openSavedCopy(page, request, 'tools/adif/adif-editor.html', testInfo);
  await expect(page).toHaveTitle('ADIF Editor');
  await expect(page.locator('#btn-open')).toBeVisible();
  expect(requests.filter(u => u !== url && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
});
