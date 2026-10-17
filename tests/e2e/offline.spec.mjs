// The single-file bundles (confirm/confirm-offline.html,
// notfunk/notfunk-offline.html, netlog/netlog-offline.html,
// adif/adif-editor.html) are made for file:// (USB stick, laptop without a
// server): download each from the built site, open the saved copy from
// file:// and check that it starts without errors and loads nothing else.
import { readFile, writeFile } from 'node:fs/promises';
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

test('netlog-offline.html runs from file://: a session, a check-in from the callsign list, kept over a reload', async ({ page, request }, testInfo) => {
  const { url, requests } = await openSavedCopy(page, request, 'tools/netlog/netlog-offline.html', testInfo);
  await expect(page).toHaveTitle('Netlog');
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  // the file is the offline copy: no download card, no link out of it
  await expect(page.locator('#st-offline')).toHaveText('Offline-Datei');
  await expect(page.locator('#offline-card')).toBeHidden();
  await expect(page.locator('#home-link')).toBeHidden();
  await page.locator('#btn-new-session').click();
  await page.locator('#sf-own').fill('OE0QXZ');
  await page.locator('#session-form button[type=submit]').click();
  await expect(page.locator('#checkin-call')).toBeVisible();
  // the inlined callsign list suggests (any real OE callsign will do)
  await page.locator('#checkin-call').fill('OE1');
  await expect(page.locator('#checkin-pop button').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('#checkin-call').fill('OE0QXA');
  await page.locator('#checkin-name').fill('Probe');
  await page.locator('#checkin-name').press('Enter');
  await expect(page.locator('#roster li', { hasText: 'OE0QXA' })).toBeVisible();
  await expect(page.locator('#st-save')).toContainText(/gespeichert/);
  await page.reload();
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await expect(page.locator('#roster li', { hasText: 'OE0QXA' })).toBeVisible();
  expect(requests.filter(u => u !== url && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
});

test('adif-editor.html runs from file://', { tag: '@adif' }, async ({ page, request }, testInfo) => {
  await page.addInitScript(() => { try { localStorage.setItem('oe1ebg-adif-lang', 'en'); } catch { /* blocked */ } }); // English texts below (the editor follows the browser: de-AT)
  const { url, requests } = await openSavedCopy(page, request, 'tools/adif/adif-editor.html', testInfo);
  await expect(page).toHaveTitle('ADIF Editor');
  await expect(page.locator('#btn-open')).toBeVisible();
  // new and clear (its <dialog>) work in the bundle too
  await page.locator('#btn-new').click();
  await expect(page.locator('#drop thead th[data-col]')).toHaveCount(8);
  await expect(page.locator('#drop tbody tr[data-ri="0"] td[data-col="CALL"]')).toBeFocused();
  await expect(page.locator('#drop tbody tr[data-ri="0"] td[data-col="BAND"] select')).toHaveAttribute('aria-label', 'BAND, row 1');
  await page.locator('#btn-clear').click();
  const dlg = page.getByRole('dialog', { name: 'Clear the editor?' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('#empty-msg')).toBeVisible();
  expect(requests.filter(u => u !== url && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
});

// The download link must save the bundle itself, also while the service
// worker controls the page: Firefox sends the <a download> click as a
// navigation, and the worker's old navigation fallback answered it with the
// start page (~30 KB instead of the multi-MB file).
for (const [tool, bundle, saveAs] of [
  ['confirm', 'confirm-offline.html', 'bestaetigungsverkehr-offline.html'],
  ['notfunk', 'notfunk-offline.html', 'notfunk-meldebuch-offline.html'],
  ['netlog', 'netlog-offline.html', 'netlog-offline.html'],
]) {
  test(`${bundle} downloads whole from the installed tool`, async ({ page, request, browserName }) => {
    test.skip(browserName === 'webkit', 'service workers: Chromium and Firefox only');
    const expected = await (await request.get(`tools/${tool}/${bundle}`)).body();
    await page.goto(`tools/${tool}/`);
    await expect(page.locator('#st-offline')).toHaveText(/offline bereit/, { timeout: 45_000 });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const download = page.waitForEvent('download');
    await page.locator('#offline-card a[download]').click();
    const file = await (await download).path();
    expect((await download).suggestedFilename()).toBe(saveAs);
    expect((await readFile(file)).equals(expected)).toBe(true);
    // the same fallback, reproducible in every browser with service workers:
    // opening the bundle is a navigation too
    await page.goto(`tools/${tool}/${bundle}`);
    expect(await page.evaluate(() => typeof globalThis.OE1EBG_DATA)).toBe('object');
  });
}

test('saved ADIF editor imports, edits and exports Unicode ADX without networking', { tag: '@adif' }, async ({ page, request }, testInfo) => {
  await page.addInitScript(() => { try { localStorage.setItem('oe1ebg-adif-lang', 'en'); } catch { /* blocked */ } }); // English texts below (the editor follows the browser: de-AT)
  const { url, requests } = await openSavedCopy(page, request, 'tools/adif/adif-editor.html', testInfo);
  await page.context().setOffline(true);
  const source = '<ADX><HEADER><ADIF_VER>3.1.8</ADIF_VER></HEADER><RECORDS><RECORD><CALL>OE1AB</CALL><QSO_DATE>20261012</QSO_DATE><TIME_ON>1200</TIME_ON><BAND>20m</BAND><MODE>SSB</MODE><NAME_INTL>Éva 😀</NAME_INTL></RECORD></RECORDS></ADX>';
  await page.locator('#file-input').setInputFiles({ name: 'offline.adx', mimeType: 'application/xml', buffer: Buffer.from(source) });
  await expect(page.locator('#stats')).toContainText('1 QSOs');
  const name = page.locator('td[data-col="NAME_INTL"]');
  await name.fill('Änne 😀'); await name.press('Tab');
  await expect(page.locator('#validation-summary')).toContainText('current log');
  const download = page.waitForEvent('download');
  await page.locator('#btn-export-adx').click();
  const result = await download;
  expect(result.suggestedFilename()).toBe('offline.adx');
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(await result.path(), 'utf8')).toContain('<NAME_INTL>Änne 😀</NAME_INTL>');
  expect(requests.filter(u => u !== url && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
});
