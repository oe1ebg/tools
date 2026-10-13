// ADIF editor (/tools/adif/): a file loads into the table, the .adi export passes
// the strict ADIF 3.1.7 reader, CSV export downloads.
import { fileURLToPath } from 'node:url';
import { test, expect, downloadText } from './fixtures.mjs';
import { readADI } from '../adif-spec.mjs';
import { validateAdif } from '../../tools/shared/js/adif-validate.js';
import { parseADIFAuto } from '../../tools/shared/js/adif.js';
import { serializeADIF } from '../../tools/adif/js/export.js';
import { readFileSync } from 'node:fs';

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
  await expect(panel).toContainText('ADIF 3.1.8');
  await expect(panel.getByRole('link', { name: 'adifmt' })).toHaveAttribute('rel', 'noopener');
  await expect(panel.getByRole('link', { name: 'adif-checker' })).toBeVisible();
  // build-info.js (scripts/build_adif.py): a commit link, unless built outside git
  const commit = await page.evaluate(() => globalThis.ADIF_BUILD?.commit);
  expect(commit).toBeTruthy();
  if (commit === 'dev') await expect(panel).toContainText('Development build');
  else await expect(panel.getByRole('link', { name: 'checks for this commit' })).toHaveAttribute('href', /\/commit\/[0-9a-f]+\/checks$/);
});

// The official ADIF test QSOs: 6202 QSOs × 180 fields. The table body is
// virtualized (tools/adif/js/table.js): only the rows around the visible
// part exist; an edit at the end of the log survives scrolling away and
// back and lands in the export.
const OFFICIAL = fileURLToPath(new URL('../fixtures/adif-spec/test-qsos.adi', import.meta.url));

test('a large log loads fast, scrolls and exports edits', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('tools/adif/');
  const start = Date.now();
  await page.locator('#file-input').setInputFiles(OFFICIAL);
  await expect(page.locator('#stats')).toContainText('6202 QSOs', { timeout: 30_000 });
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
  expect(check.records).toHaveLength(6202);
  expect(check.records[6196].fields.CALL).toBe('OE1ZZZ');
});

// Search & filter: only the table's view changes, exports keep every QSO.
const INVALID_DATE = fileURLToPath(new URL('../fixtures/adif/invalid-date.adi', import.meta.url));
// rendered rows (the log is small enough for the virtual window to hold all)
const shownRows = page => page.locator('#drop table tbody tr[data-ri]');

test('search finds a callsign, clearing shows all again', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  await expect(page.locator('#filter-bar')).toBeVisible();
  await expect(page.locator('#flt-file-wrap')).toBeHidden(); // one file only
  await page.locator('#flt-text').fill('oe3');
  await expect(shownRows(page)).toHaveCount(1);
  await expect(shownRows(page)).toContainText('OE3XYZ');
  await expect(page.locator('#flt-count')).toHaveText('1 of 3 QSOs shown');
  await expect(page.locator('#flt-note')).toBeVisible();
  await page.locator('#flt-text-field').selectOption('MODE');
  await expect(shownRows(page)).toHaveCount(0);
  await page.locator('#flt-clear').click();
  await expect(shownRows(page)).toHaveCount(3);
  await expect(page.locator('#flt-count')).toHaveText('');
  await expect(page.locator('#flt-note')).toBeHidden();
});

test('an edited QSO stays shown until the filter changes', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  await page.locator('#flt-text').fill('oe3');
  await expect(page.locator('#flt-count')).toHaveText('1 of 3 QSOs shown');
  const call = page.locator('#drop tbody tr[data-ri="1"] td[data-col="CALL"]');
  await call.click();
  await call.fill('DL9ZZ');
  await call.press('Enter');
  await expect(call).toHaveText('DL9ZZ');
  await expect(page.locator('#validation-summary')).toContainText('current log'); // re-checked
  await expect(shownRows(page)).toHaveCount(1);
  // a new filter drops it: "oe" now matches OE1ABC and DL1AA (MY_SOTA_REF OE/WI-001)
  await page.locator('#flt-text').fill('oe');
  await expect(page.locator('#flt-count')).toHaveText('2 of 3 QSOs shown');
  await expect(call).toHaveCount(0);
});

test('status and file filters; the issue list reveals a hidden QSO', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  await page.locator('#file-input').setInputFiles(INVALID_DATE);
  await expect(page.locator('#stats')).toContainText('4 QSOs');
  await expect(page.locator('#flt-file-wrap')).toBeVisible();

  await page.locator('#flt-status').selectOption('errors');
  await expect(shownRows(page)).toHaveCount(1);
  await expect(shownRows(page)).toContainText('20260230');
  await expect(page.locator('#flt-count')).toHaveText('1 of 4 QSOs shown');

  await page.locator('#flt-status').selectOption('any');
  await page.locator('#flt-file').selectOption('sample.adi');
  await expect(shownRows(page)).toHaveCount(3);

  // the issue's "row 4" clears the file filter that hides it and goes there
  await page.locator('#btn-issues').click();
  await page.getByRole('button', { name: 'show row 4 in the table' }).click();
  await expect(page.locator('#flt-file')).toHaveValue('');
  await expect(shownRows(page)).toHaveCount(4);
  await expect(page.locator('#drop tbody tr[data-ri="3"] td:focus')).toHaveCount(1);
});

test('field condition: counter, and the export still has every QSO', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  await page.locator('#flt-add-cond').click();
  await page.getByLabel('condition 1 field').fill('MODE');
  await page.getByLabel('condition 1 operator').selectOption('eq');
  await page.getByLabel('condition 1 value').fill('fm');
  await expect(page.locator('#flt-count')).toHaveText('1 of 3 QSOs shown');
  await expect(shownRows(page)).toContainText('OE1ABC');
  await page.getByLabel('condition 1 operator').selectOption('notempty');
  await expect(page.locator('#flt-count')).toHaveText('3 of 3 QSOs shown');
  await page.getByLabel('condition 1 field').fill('MY_SOTA_REF');
  await expect(page.locator('#flt-count')).toHaveText('1 of 3 QSOs shown');

  const adiDownload = page.waitForEvent('download');
  await page.locator('#btn-export').click();
  const { records } = readADI(await downloadText(await adiDownload));
  expect(records.map(r => r.CALL)).toEqual(['OE1ABC', 'OE3XYZ', 'DL1AA']);
});

test('filters the large official log; the export keeps all 6202 QSOs', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(OFFICIAL);
  await expect(page.locator('#stats')).toContainText('6202 QSOs', { timeout: 30_000 });
  const count = page.locator('#flt-count');
  await page.locator('#flt-add-cond').click();
  await page.getByLabel('condition 1 field').fill('MODE');
  await page.getByLabel('condition 1 operator').selectOption('eq');
  await page.getByLabel('condition 1 value').fill('CW');
  await expect(count).toHaveText('154 of 6202 QSOs shown'); // <MODE:2>CW in the file
  const modes = await page.locator('#drop tbody tr[data-ri] td[data-col="MODE"]').allTextContents();
  expect(modes.length).toBeGreaterThan(0);
  expect(modes.every(m => m === 'CW')).toBe(true);
  // a search on top of it
  await page.locator('#flt-text').fill('zzzz-no-such-value');
  await expect(count).toHaveText('0 of 6202 QSOs shown');
  await expect(shownRows(page)).toHaveCount(0);

  const adiDownload = page.waitForEvent('download');
  await page.locator('#btn-export').click();
  const check = validateAdif(await downloadText(await adiDownload), { today: '20991231' });
  expect(check.records).toHaveLength(6202);
});

/* ---------- big imports: progress, cancel, limits, re-check (issue #15) ---------- */

// n QSOs of 180 fields made from the official test QSOs (as scripts/bench_ui.mjs does)
function bigAdi(n) {
  const base = parseADIFAuto(readFileSync(OFFICIAL, 'utf8'), [], 'test-qsos.adi', {});
  const recs = [];
  for (let i = 0; recs.length < n; i++) {
    const r = { ...base[i % base.length] };
    if (r.CALL) r.CALL = `${r.CALL}${i % 10}`.slice(0, 13);
    recs.push(r);
  }
  const cols = [...new Set(recs.flatMap(r => Object.keys(r)))];
  return { name: 'big.adi', mimeType: 'application/octet-stream', buffer: Buffer.from(serializeADIF(recs, cols, '2026-01-01T00:00:00Z')) };
}

test('a big import shows its progress and finishes', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('tools/adif/');
  // what the progress line said, in order
  await page.evaluate(() => {
    window.__seen = [];
    new MutationObserver(() => window.__seen.push(document.querySelector('#import-text').textContent))
      .observe(document.querySelector('#import-text'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#file-input').setInputFiles(bigAdi(30000));
  const progress = page.locator('#import-progress');
  await expect(progress).toBeVisible();
  await expect(page.locator('#import-bar')).toHaveAttribute('max', '100');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused(); // keyboard users can cancel at once
  await expect(page.locator('#stats')).toContainText('30000 QSOs', { timeout: 120_000 });
  await expect(progress).toBeHidden();
  await expect(page.locator('#btn-open')).toBeEnabled();
  const seen = await page.evaluate(() => window.__seen);
  expect(seen.some(t => /Reading big\.adi: [\d,]+ QSOs read \(\d+ %\)/.test(t))).toBe(true);
  expect(seen.some(t => /Checking big\.adi: [\d,]+ of 30,000 QSOs \(\d+ %\)/.test(t))).toBe(true);
  await expect(page.locator('#validation-summary')).toContainText('ADIF');
});

test('cancelling a big import leaves the loaded log as it was', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(180_000);
  await loadSample(page);
  // the user presses Cancel once the import has read something: done in the
  // page at that moment, so the test does not race the import's speed
  await page.evaluate(() => {
    const line = document.querySelector('#import-text');
    new MutationObserver(() => {
      if (/QSOs read/.test(line.textContent)) document.querySelector('#btn-cancel-import').click();
    }).observe(line, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#file-input').setInputFiles(bigAdi(100000));
  await expect(page.locator('#import-progress')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#warnings')).toContainText('Import cancelled; the log is unchanged.');
  await expect(page.locator('#stats')).toContainText(/^3 QSOs/);
  await expect(page.locator('#file-info')).toHaveText('sample.adi: ADIF 3.1.7');
  await expect(page.locator('#drop tbody')).toContainText('OE3XYZ');
  await expect(page.locator('#btn-open')).toBeEnabled();
  // the editor still works: the same big file can be added again afterwards
  await expect(page.locator('#validation-summary')).toContainText('ADIF');
});

test('Escape cancels a running import', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(180_000);
  await loadSample(page);
  await page.locator('#file-input').setInputFiles(bigAdi(200000));
  await expect(page.locator('#import-progress')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#import-progress')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#stats')).toContainText(/^3 QSOs/);
});

test('a file over a limit is refused with a message and the log stays', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  const huge = `<CALL:5>OE1AB <NOTES:150000>${'x'.repeat(150000)} <EOR>\n`;
  await page.locator('#file-input').setInputFiles({ name: 'huge-value.adi', mimeType: 'text/plain', buffer: Buffer.from(huge) });
  await expect(page.locator('#warnings')).toContainText('huge-value.adi: not loaded, NOTES in QSO 1 has 150,000 characters, the editor takes values up to 100,000.');
  await expect(page.locator('#warnings')).toContainText('The log is unchanged');
  await expect(page.locator('#stats')).toContainText(/^3 QSOs/);
  await expect(page.locator('#import-progress')).toBeHidden();
});

test('an edit during a re-check supersedes it; the result is the check of the current log', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(bigAdi(30000));
  await expect(page.locator('#stats')).toContainText('30000 QSOs', { timeout: 120_000 });
  await expect(page.locator('#validation-summary')).toContainText('ADIF');
  const band = page.locator('#drop tbody tr[data-ri="0"] td[data-col="BAND"]');
  const box = page.locator('#validation');
  // 1st edit: an invalid band; its re-check starts after the debounce
  await band.click();
  await band.fill('zz');
  await band.press('Enter');
  await expect(box).toHaveClass(/is-checking/);
  await page.waitForTimeout(400); // the check is running now (30000 QSOs take longer than that)
  // 2nd edit, during the check: the value is taken at once, and the editor answers
  const band0 = page.locator('#drop tbody tr[data-ri="0"] td[data-col="BAND"]');
  await band0.click();
  await band0.fill('20m');
  await band0.press('Enter');
  await expect(box).toHaveClass(/is-checking/);
  await expect(box).not.toHaveClass(/is-checking/, { timeout: 120_000 });
  // the finished check is the one of the log with "20m": nothing is flagged in that cell
  await expect(band0).not.toHaveClass(/cell-error/);
  await expect(page.locator('#validation-summary')).toContainText('current log');
});

test('column headers of short fields keep their sort and remove buttons visible and apart', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(OFFICIAL);
  await expect(page.locator('#stats')).toContainText('6202 QSOs', { timeout: 30_000 });
  // every header: name button and x button inside the cell, not overlapping each other
  const bad = await page.locator('#drop thead th[data-col]').evaluateAll(ths => ths.flatMap(th => {
    const th0 = th.getBoundingClientRect(), s = th.querySelector('.sortcol').getBoundingClientRect(), r = th.querySelector('.rmcol').getBoundingClientRect();
    const out = [];
    if (s.right > r.left + 1) out.push(`${th.dataset.col}: name overlaps the remove button`);
    if (r.right > th0.right + 1 || s.left < th0.left - 1) out.push(`${th.dataset.col}: buttons stick out of the header`);
    if (r.width < 4 || s.width < 4) out.push(`${th.dataset.col}: a button has no width`);
    return out;
  }));
  expect(bad).toEqual([]);
  const th = page.locator('#drop thead th[data-col="MY_GRIDSQUARE"]');
  await th.locator('.sortcol').click();
  await expect(th).toHaveAttribute('aria-sort', 'ascending');
  await th.locator('.rmcol').focus();
  await expect(th.locator('.rmcol')).toBeFocused();
});

test('adding a file while an edit of the log was already checked re-checks the combined log', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  // hold back the read of the second file until the test lets it go
  await page.evaluate(() => {
    const orig = FileReader.prototype.readAsArrayBuffer;
    window.__held = [];
    FileReader.prototype.readAsArrayBuffer = function (file) {
      if (file.name === 'second.adi') window.__held.push(() => orig.call(this, file));
      else orig.call(this, file);
    };
  });
  const second = '<CALL:5>DL2BB <QSO_DATE:8>20260903 <TIME_ON:4>1000 <BAND:3>20m <MODE:2>CW <EOR>\n';
  await page.locator('#file-input').setInputFiles({ name: 'second.adi', mimeType: 'text/plain', buffer: Buffer.from(second) });
  await expect(page.locator('#import-progress')).toBeVisible();
  // meanwhile: an invalid band in the first QSO, and its check finishes
  const band = page.locator('#drop tbody tr[data-ri="0"] td[data-col="BAND"]');
  await band.click();
  await band.fill('zz');
  await band.press('Enter');
  await expect(band).toHaveClass(/cell-error/);
  await expect(page.locator('#validation')).not.toHaveClass(/is-checking/);
  await page.evaluate(() => window.__held.forEach(f => f()));
  await expect(page.locator('#stats')).toContainText('4 QSOs');
  await expect(page.locator('#validation')).not.toHaveClass(/is-checking/, { timeout: 30_000 });
  // the error of the edit is still there, in the check of the combined log
  await expect(band).toHaveClass(/cell-error/);
  await expect(page.locator('#validation-summary')).toContainText('current log');
});
