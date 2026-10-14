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
  await expect(page.locator('#stats')).toContainText('6,202 QSOs', { timeout: 30_000 });
  await expect(page.locator('#validation-summary')).toContainText('ADIF valid');
  // generous: ~0.15 s in desktop Chromium, 4.4 s before the virtual table
  expect(Date.now() - start).toBeLessThan(20_000);
  const rows = page.locator('#drop tbody tr[data-ri]');
  expect(await rows.count()).toBeGreaterThan(5);
  expect(await rows.count()).toBeLessThan(400);

  await page.locator('#drop').evaluate(d => { d.scrollTop = d.scrollHeight; });
  const lastCall = page.locator('#drop tbody tr[data-ri="6201"] td[data-col="CALL"]');
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
  expect(check.records[6201].fields.CALL).toBe('OE1ZZZ');
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
  await expect(page.locator('#stats')).toContainText('6,202 QSOs', { timeout: 30_000 });
  const count = page.locator('#flt-count');
  await page.locator('#flt-add-cond').click();
  await page.getByLabel('condition 1 field').fill('MODE');
  await page.getByLabel('condition 1 operator').selectOption('eq');
  await page.getByLabel('condition 1 value').fill('CW');
  await expect(count).toHaveText('154 of 6202 QSOs shown'); // <MODE:2>CW in the file
  // MODE cells are selects (the stored value selected)
  const modes = await page.locator('#drop tbody tr[data-ri] td[data-col="MODE"] select').evaluateAll(sels => sels.map(s => s.value));
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
  await expect(page.locator('#stats')).toContainText('30,000 QSOs', { timeout: 120_000 });
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
  await expect(page.locator('#stats')).toContainText(/Whole log: 3 QSOs/);
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
  await expect(page.locator('#stats')).toContainText(/Whole log: 3 QSOs/);
});

test('a file over a limit is refused with a message and the log stays', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  const huge = `<CALL:5>OE1AB <NOTES:150000>${'x'.repeat(150000)} <EOR>\n`;
  await page.locator('#file-input').setInputFiles({ name: 'huge-value.adi', mimeType: 'text/plain', buffer: Buffer.from(huge) });
  await expect(page.locator('#warnings')).toContainText('huge-value.adi: not loaded, NOTES in QSO 1 has 150,000 characters, the editor takes values up to 100,000.');
  await expect(page.locator('#warnings')).toContainText('The log is unchanged');
  await expect(page.locator('#stats')).toContainText(/Whole log: 3 QSOs/);
  await expect(page.locator('#import-progress')).toBeHidden();
});

test('an edit during a re-check supersedes it; the result is the check of the current log', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(bigAdi(30000));
  await expect(page.locator('#stats')).toContainText('30,000 QSOs', { timeout: 120_000 });
  await expect(page.locator('#validation-summary')).toContainText('ADIF');
  // a text cell (BAND is a select)
  const time = page.locator('#drop tbody tr[data-ri="0"] td[data-col="TIME_ON"]');
  const box = page.locator('#validation');
  // 1st edit: an invalid time; its re-check starts after the debounce
  await time.click();
  await time.fill('zz');
  await time.press('Enter');
  await expect(box).toHaveClass(/is-checking/);
  await page.waitForTimeout(400); // the check is running now (30000 QSOs take longer than that)
  // 2nd edit, during the check: the value is taken at once, and the editor answers
  const time0 = page.locator('#drop tbody tr[data-ri="0"] td[data-col="TIME_ON"]');
  await time0.click();
  await time0.fill('1200');
  await time0.press('Enter');
  await expect(box).toHaveClass(/is-checking/);
  await expect(box).not.toHaveClass(/is-checking/, { timeout: 120_000 });
  // the finished check is the one of the log with "1200": nothing is flagged in that cell
  await expect(time0).not.toHaveClass(/cell-error/);
  await expect(page.locator('#validation-summary')).toContainText('current log');
});

test('column headers of short fields keep their sort and remove buttons visible and apart', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(OFFICIAL);
  await expect(page.locator('#stats')).toContainText('6,202 QSOs', { timeout: 30_000 });
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
  // meanwhile: an invalid time in the first QSO, and its check finishes
  const time = page.locator('#drop tbody tr[data-ri="0"] td[data-col="TIME_ON"]');
  await time.click();
  await time.fill('zz');
  await time.press('Enter');
  await expect(time).toHaveClass(/cell-error/);
  await expect(page.locator('#validation')).not.toHaveClass(/is-checking/);
  await page.evaluate(() => window.__held.forEach(f => f()));
  await expect(page.locator('#stats')).toContainText('4 QSOs');
  await expect(page.locator('#validation')).not.toHaveClass(/is-checking/, { timeout: 30_000 });
  // the error of the edit is still there, in the check of the combined log
  await expect(time).toHaveClass(/cell-error/);
  await expect(page.locator('#validation-summary')).toContainText('current log');
});

test('statistics update after callsign edits, deletion and actual-view filtering', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  const overview = page.locator('#stats');
  await expect(overview).toContainText('Whole log:');
  await expect(overview).toContainText('3 reported callsigns');
  await page.locator('#log-statistics summary').click();
  await expect(page.locator('#statistics-body')).toContainText('Whole log: 3 QSOs');
  await page.locator('#flt-text').fill('OE1ABC');
  await expect(page.locator('#flt-count')).toContainText('1 of 3');
  await page.locator('#statistics-scope').selectOption('shown');
  await expect(page.locator('#statistics-body')).toContainText('Shown QSOs: 1 QSOs');
  const cell = page.locator('td[data-col="CALL"]').first();
  await cell.fill('OE1ABC/P');
  await cell.press('Tab');
  await expect(page.locator('#statistics-body')).toContainText('Shown QSOs: 1 QSOs');
  await page.locator('#flt-clear').click();
  await expect(page.locator('#statistics-body')).toContainText('Shown QSOs: 3 QSOs');
  await page.locator('td[data-col="CALL"]').nth(1).fill('OE1ABC/P');
  await page.locator('td[data-col="CALL"]').nth(1).press('Tab');
  await expect(overview).toContainText('2 reported callsigns');
});

test('official overview stays bounded and statistics controls support keyboard use', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(OFFICIAL);
  await expect(page.locator('#stats')).toContainText('33 bands');
  await expect(page.locator('#stats')).toContainText('49 modes');
  expect((await page.locator('#stats').textContent()).length).toBeLessThan(230);
  const summary = page.locator('#log-statistics summary');
  await summary.focus(); await summary.press('Enter');
  await expect(page.locator('#statistics-scope')).toBeVisible();
  await expect(page.locator('#statistics-body')).toContainText('340 DXCC entities');
});

/* ---------- enumeration cells, suggestions, new and clear ---------- */

// An .adi file from records ({FIELD: value}), with optional header fields.
function adiFile(name, recs, header = '') {
  const f = (k, v) => `<${k}:${v.length}>${v} `;
  const text = `${header}<ADIF_VER:5>3.1.8 <EOH>\n` + recs.map(r => Object.entries(r).map(([k, v]) => f(k, v)).join('') + '<EOR>\n').join('');
  return { name, mimeType: 'application/octet-stream', buffer: Buffer.from(text) };
}

const cell = (page, ri, col) => page.locator(`#drop tbody tr[data-ri="${ri}"] td[data-col="${col}"]`);
// the export without its CREATED_TIMESTAMP (the only part that changes by
// itself); read back with the tolerant parser (these logs are not all valid).
// An invalid log is exported only after its errors are approved (export-ui.js).
async function exportAdi(page, { invalid = false } = {}) {
  const download = page.waitForEvent('download');
  await page.locator('#btn-export').click();
  if (invalid) await page.locator('#export-decisions').getByRole('button', { name: 'Export with reported validation errors', exact: true }).click();
  return (await downloadText(await download)).replace(/<CREATED_TIMESTAMP:15>\d{8} \d{6}/, '');
}
// Would leaving the page ask? (the beforeunload handler cancels the event)
const asksBeforeLeaving = page => page.evaluate(() => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});

test('enumeration cells are selects: Enter commits and moves down, Esc restores, Tab goes on', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  const band0 = cell(page, 0, 'BAND').locator('select');
  await expect(band0).toHaveAttribute('aria-label', 'BAND, row 1');
  await expect(band0).toHaveValue('2m');
  await band0.focus();
  await band0.selectOption('40m');
  await band0.press('Enter');
  const band1 = cell(page, 1, 'BAND').locator('select');
  await expect(band1).toBeFocused();
  await expect(page.locator('#validation-summary')).toContainText('current log');
  // Esc: the value from before
  await band1.selectOption('80m');
  await band1.press('Escape');
  await expect(band1).toHaveValue('40m');
  await expect(band1).not.toBeFocused();
  // the empty option removes the field
  const mode2 = cell(page, 2, 'MODE').locator('select');
  await mode2.focus();
  await mode2.selectOption('');
  await mode2.press('Enter'); // last row: takes the value
  // Tab at the end of a row (a select there) goes on to the next row
  for (const col of ['MY_SOTA_REF', 'RST_RCVD', 'RST_SENT']) await page.getByRole('button', { name: `remove column ${col}` }).click();
  const lastMode = cell(page, 0, 'MODE').locator('select');
  await lastMode.focus();
  await lastMode.press('Tab');
  await expect(cell(page, 1, 'CALL')).toBeFocused();
  const records = parseADIFAuto(await exportAdi(page), [], 'export.adi', {});
  expect(records.map(r => r.BAND)).toEqual(['40m', '40m', '20m']);
  expect(records[2].MODE).toBeUndefined();
});

test('a select changed and exported while it still has the focus is exported with its new value', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  const band0 = cell(page, 0, 'BAND').locator('select');
  await band0.focus();
  await band0.selectOption('40m');
  // no Enter, no blur: the export takes the focused cell's value (in WebKit
  // clicking the button leaves the focus on the select)
  const records = parseADIFAuto(await exportAdi(page), [], 'export.adi', {});
  expect(records[0].BAND).toBe('40m');
});

test('stored values are kept as they are: marked options, no edit by tabbing, identical export',{ tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(adiFile('odd.adi', [
    { CALL: 'OE1ABC', QSO_DATE: '20260901', TIME_ON: '1200', MODE: 'PSK31', BAND: '20M', QSL_RCVD: 'V', DXCC: '001', MYCLASS: 'Gamma', REGION: 'KO' },
    { CALL: 'OE3XYZ', QSO_DATE: '20260901', TIME_ON: '1300', MODE: 'zz', BAND: '40m', QSL_RCVD: 'Y', DXCC: '291', MYCLASS: 'Al', REGION: 'NONE' },
  ], '<USERDEF1:15:E>MYCLASS,{Al,Be} '));
  await expect(page.locator('#stats')).toContainText('2 QSOs');
  const before = await exportAdi(page, { invalid: true });
  const options = async (ri, col) => {
    const sel = cell(page, ri, col).locator('select');
    await sel.focus(); // fills the list
    return sel.evaluate(s => ({ value: s.value, options: [...s.options].map(o => [o.value, o.text]) }));
  };
  const has = (o, value, text) => expect(o.options).toContainEqual([value, text]);
  let o = await options(0, 'MODE');
  expect(o.value).toBe('PSK31');
  has(o, 'PSK31', 'PSK31 (import-only)');
  expect(o.options.some(([v]) => v === 'PSK')).toBe(true);
  expect(o.options[0]).toEqual(['', '']);
  o = await options(0, 'BAND');
  expect(o.value).toBe('20M');
  has(o, '20M', '20M');
  expect(o.options.some(([v]) => v === '20m')).toBe(false); // its own spelling, once
  o = await options(0, 'QSL_RCVD');
  has(o, 'V', 'V (import-only)');
  o = await options(0, 'DXCC');
  expect(o.value).toBe('001');
  has(o, '001', '001 – CANADA');
  o = await options(0, 'MYCLASS');
  has(o, 'Gamma', 'Gamma (not declared in USERDEF)');
  has(o, 'Be', 'Be');
  o = await options(0, 'REGION');
  expect(o.options.filter(([v]) => v === 'KO')).toHaveLength(1);
  o = await options(1, 'MODE');
  has(o, 'zz', 'zz (not in ADIF 3.1.8)');
  o = await options(1, 'DXCC');
  has(o, '291', '291 – UNITED STATES OF AMERICA');
  // through every cell with the keyboard
  await cell(page, 0, 'CALL').click();
  const cells = await page.locator('#drop tbody td[data-col]').count();
  for (let i = 1; i < cells; i++) await page.keyboard.press('Tab');
  await expect(cell(page, 1, 'REGION').locator('select')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#validation-summary')).not.toContainText('current log'); // nothing was edited
  expect(await asksBeforeLeaving(page)).toBe(false);
  expect(await exportAdi(page, { invalid: true })).toBe(before);
});

test('STATE is a select only where the DXCC has a list; unlisted values stay', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(adiFile('states.adi', [
    { CALL: 'W1AW', DXCC: '291', STATE: 'ZZ' },
    { CALL: 'YA1A', DXCC: '3', STATE: 'XY' },
    { CALL: 'K1ABC', STATE: 'CA' },
  ]));
  await expect(page.locator('#stats')).toContainText('3 QSOs');
  const state = ri => cell(page, ri, 'STATE');
  const heights = () => page.locator('#drop tbody tr[data-ri]').evaluateAll(trs => trs.map(tr => tr.getBoundingClientRect().height));
  await expect(state(0).locator('select')).toHaveValue('ZZ');
  await expect(state(0).locator('select option:checked')).toHaveText('ZZ (not listed for DXCC=291)');
  await expect(state(1)).toHaveAttribute('contenteditable', /.+/);
  await expect(state(1)).toHaveText('XY');
  await expect(state(2)).toHaveText('CA');
  let h = await heights();
  expect(Math.max(...h) - Math.min(...h)).toBeLessThan(0.5);
  // DXCC set: the STATE cell gets the entity's list, the value stays
  const dxcc2 = cell(page, 2, 'DXCC').locator('select');
  await dxcc2.focus();
  await dxcc2.selectOption('291');
  await dxcc2.press('Enter');
  await expect(state(2).locator('select')).toHaveValue('CA');
  // ... also when Tab goes straight on into that cell
  const dxcc1 = cell(page, 1, 'DXCC').locator('select');
  await dxcc1.focus();
  await dxcc1.selectOption('291');
  await dxcc1.press('Tab');
  await expect(state(1).locator('select')).toBeFocused();
  await expect(state(1).locator('select')).toHaveValue('XY');
  await expect(state(1).locator('select option:checked')).toHaveText('XY (not listed for DXCC=291)');
  // DXCC cleared: text again
  const dxcc0 = cell(page, 0, 'DXCC').locator('select');
  await dxcc0.focus();
  await dxcc0.selectOption('');
  await dxcc0.press('Enter');
  await expect(state(0)).toHaveText('ZZ');
  await expect(state(0).locator('select')).toHaveCount(0);
  h = await heights();
  expect(Math.max(...h) - Math.min(...h)).toBeLessThan(0.5);
  const records = parseADIFAuto(await exportAdi(page, { invalid: true }), [], 'export.adi', {});
  expect(records.map(r => r.STATE)).toEqual(['ZZ', 'XY', 'CA']);
  expect(records.map(r => r.DXCC)).toEqual([undefined, '291', '291']);
});

test('CONTEST_ID and SUBMODE: free text with suggestions', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  for (const name of ['CONTEST_ID', 'SUBMODE']) {
    await page.getByLabel('new field name').fill(name);
    await page.getByRole('button', { name: '+ field' }).click();
  }
  const list = page.getByRole('listbox', { name: 'suggestions' });
  const contest = cell(page, 0, 'CONTEST_ID');
  await contest.click();
  await contest.pressSequentially('ARRL-1');
  await expect(list).toBeVisible();
  await expect(list.getByRole('option')).toHaveText(['ARRL-10', 'ARRL-10-GHZ', 'ARRL-160']);
  await contest.press('ArrowDown');
  await expect(list.getByRole('option', { name: 'ARRL-10', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#cell-suggest-status')).toHaveText('ARRL-10, 1 of 3');
  await contest.press('Enter');
  await expect(contest).toHaveText('ARRL-10');
  await expect(cell(page, 1, 'CONTEST_ID')).toBeFocused();
  await expect(list).toBeHidden();
  // free text stays free text
  await cell(page, 1, 'CONTEST_ID').pressSequentially('MY-OWN-TEST');
  await cell(page, 1, 'CONTEST_ID').press('Enter');
  await expect(cell(page, 1, 'CONTEST_ID')).toHaveText('MY-OWN-TEST');

  // SUBMODE follows the row's MODE
  const mode = cell(page, 0, 'MODE').locator('select');
  await mode.focus();
  await mode.selectOption('SSB');
  await mode.press('Enter');
  const sub = cell(page, 0, 'SUBMODE');
  await sub.click();
  await sub.press('ArrowDown');
  await expect(list.getByRole('option')).toHaveText(['LSB', 'USB']);
  // the first Esc closes the list, the second restores the value
  await sub.press('Escape');
  await expect(list).toBeHidden();
  await expect(sub).toBeFocused();
  await sub.pressSequentially('U');
  await expect(list.getByRole('option')).toHaveText(['USB']);
  await sub.press('Escape');
  await expect(list).toBeHidden();
  await expect(sub).toHaveText('U');
  await sub.press('Escape');
  await expect(sub).toHaveText('');
  await expect(sub).not.toBeFocused();
  // a click on an item takes it, the focus stays in the cell
  await sub.click();
  await sub.press('ArrowDown');
  await list.getByRole('option', { name: 'USB' }).click();
  await expect(sub).toBeFocused();
  await sub.press('Enter');
  const records = parseADIFAuto(await exportAdi(page), [], 'export.adi', {});
  expect(records.map(r => r.CONTEST_ID)).toEqual(['ARRL-10', 'MY-OWN-TEST', undefined]);
  expect(records[0].SUBMODE).toBe('USB');
});

test('new: an empty log at once, after edits only when confirmed; it resets the view', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  await expect(page.locator('#btn-clear')).toBeDisabled();
  await page.locator('#btn-new').click();
  await expect(page.locator('#confirm-dlg')).toBeHidden();
  await expect(page.locator('#drop thead th[data-col]')).toHaveText(['CALL', 'QSO_DATE', 'TIME_ON', 'BAND', 'FREQ', 'MODE', 'RST_SENT', 'RST_RCVD'].map(c => new RegExp(`^${c}`)));
  await expect(page.locator('#drop tbody tr[data-ri]')).toHaveCount(1);
  await expect(cell(page, 0, 'CALL')).toBeFocused();
  await expect(page.locator('#filename-input')).toHaveValue('new.adi');
  await expect(page.locator('#btn-clear')).toBeEnabled();

  // a loaded log with edits, a filter, a sort order, warnings, validation, statistics
  await page.locator('#file-input').setInputFiles(SAMPLE);
  await expect(page.locator('#stats')).toContainText('4 QSOs');
  await cell(page, 1, 'CALL').click();
  await cell(page, 1, 'CALL').fill('OE1NEW');
  await cell(page, 1, 'CALL').press('Enter');
  await page.getByLabel('new field name').fill('1BAD');
  await page.getByRole('button', { name: '+ field' }).click();
  await expect(page.locator('#warnings')).toBeVisible();
  await page.locator('#drop thead th[data-col="CALL"] .sortcol').click();
  await page.locator('#flt-text').fill('oe');
  await expect(page.locator('#flt-count')).not.toHaveText('');
  await expect(page.locator('#validation')).toBeVisible();
  await page.locator('#log-statistics summary').click();

  const dlg = page.getByRole('dialog', { name: 'Start a new log?' });
  await page.locator('#btn-new').click();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('#btn-new')).toBeFocused();
  await expect(page.locator('#stats')).toContainText('4 QSOs');

  await page.locator('#btn-new').click();
  await dlg.getByRole('button', { name: 'Discard and start new' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('#drop tbody tr[data-ri]')).toHaveCount(1);
  await expect(page.locator('#drop thead th[data-col]')).toHaveCount(8);
  await expect(cell(page, 0, 'CALL')).toBeFocused();
  await expect(page.locator('#flt-text')).toHaveValue('');
  await expect(page.locator('#flt-count')).toHaveText('');
  await expect(page.locator('#drop thead th[aria-sort]')).toHaveCount(0);
  await expect(page.locator('#warnings')).toBeHidden();
  await expect(page.locator('#validation')).toBeHidden();
  await expect(page.locator('#file-info')).toHaveText('');
  await expect(page.locator('#stats')).toContainText('1 QSOs');
  await expect(page.locator('#statistics-body')).toContainText('Whole log: 1 QSOs');
  expect(await asksBeforeLeaving(page)).toBe(false);
});

test('clear: asks every time; Esc and Cancel keep the log, OK empties the editor', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
  await cell(page, 0, 'CALL').click();
  await cell(page, 0, 'CALL').fill('OE1CLR');
  await cell(page, 0, 'CALL').press('Enter');
  expect(await asksBeforeLeaving(page)).toBe(true);
  const dlg = page.getByRole('dialog', { name: 'Clear the editor?' });
  await page.locator('#btn-clear').click();
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('not been exported');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(page.locator('#btn-clear')).toBeFocused();
  await page.locator('#btn-clear').click();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#stats')).toContainText('3 QSOs');
  await expect(cell(page, 0, 'CALL')).toHaveText('OE1CLR');

  await page.locator('#btn-clear').click();
  await dlg.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('#drop')).toHaveClass(/empty/);
  await expect(page.locator('#empty-msg')).toBeVisible();
  await expect(page.locator('#btn-export')).toBeDisabled();
  await expect(page.locator('#btn-clear')).toBeDisabled();
  await expect(page.locator('#btn-open')).toBeFocused();
  await expect(page.locator('#filter-bar')).toBeHidden();
  await expect(page.locator('#filename-input')).toHaveValue('export.adi');
  expect(await asksBeforeLeaving(page)).toBe(false);
  // an unedited log is cleared after the question too, without the warning
  await page.locator('#file-input').setInputFiles(SAMPLE);
  await expect(page.locator('#stats')).toContainText('3 QSOs');
  await page.locator('#btn-clear').click();
  await expect(dlg).toBeVisible();
  await expect(dlg).not.toContainText('not been exported');
  await dlg.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('#empty-msg')).toBeVisible();
});

test('new and clear wait while a file loads', { tag: '@adif' }, async ({ page }) => {
  await loadSample(page);
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
  await expect(page.locator('#btn-new')).toBeDisabled();
  await expect(page.locator('#btn-clear')).toBeDisabled();
  await page.evaluate(() => window.__held.forEach(f => f()));
  await expect(page.locator('#stats')).toContainText('4 QSOs');
  await expect(page.locator('#btn-new')).toBeEnabled();
  await expect(page.locator('#btn-clear')).toBeEnabled();
});

test('the parts above the table fold away while it is scrolled down, and come back at the top', { tag: '@adif' }, async ({ page }) => {
  const recs = Array.from({ length: 300 }, (_, i) => ({ CALL: `OE${i % 9 + 1}AB`, QSO_DATE: '20260901', TIME_ON: '1200', BAND: '20m', MODE: 'SSB' }));
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(adiFile('many.adi', recs));
  await expect(page.locator('#stats')).toContainText('300 QSOs');
  const drop = page.locator('#drop');
  const top = () => drop.evaluate(d => d.getBoundingClientRect().top);
  const atRest = await top();
  for (const id of ['#stats', '#file-info', '#compliance > summary', '#log-statistics > summary', '#validation-summary']) await expect(page.locator(id)).toBeVisible();
  await drop.evaluate(d => { d.scrollTop = 600; });
  await expect(page.locator('body')).toHaveClass(/\bcompact\b/);
  for (const id of ['#stats', '#file-info', '#compliance', '#log-statistics']) await expect(page.locator(id)).toBeHidden();
  await expect(page.locator('#validation-summary')).toBeVisible(); // the verdict stays
  for (const id of ['#btn-open', '#btn-export', '#flt-text']) await expect(page.locator(id)).toBeVisible();
  expect(await top()).toBeLessThan(atRest);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); // no page-wide sideways scroll
  // a little scrolling back keeps it folded; the top of the table unfolds
  await drop.evaluate(d => { d.scrollTop = 20; });
  await expect(page.locator('body')).toHaveClass(/\bcompact\b/);
  await drop.evaluate(d => { d.scrollTop = 0; });
  await expect(page.locator('body')).not.toHaveClass(/\bcompact\b/);
  await expect(page.locator('#stats')).toBeVisible();
  expect(await top()).toBe(atRest);
  // what was opened, or has the focus, stays
  await page.locator('#compliance > summary').click();
  await page.locator('#log-statistics > summary').focus();
  await drop.evaluate(d => { d.scrollTop = 600; });
  await expect(page.locator('body')).toHaveClass(/\bcompact\b/);
  await expect(page.locator('#compliance-body')).toBeVisible();
  await expect(page.locator('#log-statistics > summary')).toBeFocused();
  await expect(page.locator('#log-statistics > summary')).toBeVisible();
  // clear: the empty editor is never folded
  await page.locator('#btn-clear').click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('#empty-msg')).toContainText('.adi / .adx');
  await expect(page.locator('body')).not.toHaveClass(/\bcompact\b/);
});

test('a table that would stop scrolling once folded does not fold', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(adiFile('few.adi', Array.from({ length: 30 }, (_, i) => ({ CALL: `OE${i % 9 + 1}AB`, QSO_DATE: '20260901', TIME_ON: '1200' }))));
  await expect(page.locator('#stats')).toContainText('30 QSOs');
  const drop = page.locator('#drop');
  // a window in which the table scrolls 60 px: past the threshold (48 px),
  // but folding would leave less than that
  const { width } = page.viewportSize();
  const { scrollHeight, top } = await drop.evaluate(d => ({ scrollHeight: d.scrollHeight, top: d.getBoundingClientRect().top }));
  await page.setViewportSize({ width, height: Math.round(scrollHeight + top - 60) });
  await expect.poll(() => drop.evaluate(d => d.scrollHeight - d.clientHeight)).toBeGreaterThan(48);
  await drop.evaluate(d => { d.scrollTop = d.scrollHeight; });
  const states = [];
  for (let i = 0; i < 5; i++){ await page.waitForTimeout(50); states.push(await page.evaluate(() => document.body.classList.contains('compact'))); }
  expect(states).toEqual([false, false, false, false, false]);
  expect(await drop.evaluate(d => d.scrollTop)).toBeGreaterThan(48); // where it was scrolled to
});
