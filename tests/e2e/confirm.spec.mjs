// Confirmation log (/tools/confirm/): loads, a log can be created and a check-in
// logged, the offline location search answers, CSV and ADIF export download
// and the ADI file passes the strict ADIF 3.1.7 reader the unit tests use.
import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect, downloadText, offlineSettled } from './fixtures.mjs';
import { readADI } from '../adif-spec.mjs';

async function openNewLog(page, title) {
  await page.goto('tools/confirm/');
  // (the <h1> is hidden at phone widths)
  await expect(page).toHaveTitle('Bestätigungsverkehr');
  await expect(page.locator('#view-events')).toBeVisible();
  await expect.poll(() => page.evaluate(() => globalThis.CONFIRM_READY === true)).toBe(true);
  await offlineSettled(page);
  await page.getByRole('button', { name: '+ Neues Log' }).click();
  await page.locator('#new-event input[name="title"]').fill(title);
  await page.getByRole('button', { name: /Log anlegen/ }).click();
  await expect(page.locator('#view-log')).toBeVisible();
  await expect(page.locator('#log-title')).toHaveValue(title);
}

// The stored event of the open log, read or patched behind the app's back
// (another tab's write).
const storedEvent = page => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('oe1ebg-confirm');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const all = db.transaction('events').objectStore('events').getAll();
    all.onsuccess = () => { db.close(); resolve(all.result[0]); };
  };
}));
const patchStoredEvent = (page, patch) => page.evaluate(p => new Promise((resolve, reject) => {
  const open = indexedDB.open('oe1ebg-confirm');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const t = db.transaction('events', 'readwrite');
    const os = t.objectStore('events');
    const all = os.getAll();
    all.onsuccess = () => { os.put({ ...all.result[0], ...p }); };
    t.oncomplete = () => { db.close(); resolve(); };
    t.onerror = () => reject(t.error);
  };
}), patch);

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
  bad.entries = [{ id: 'x', eventId: 'anderes-log', seq: 1, call: 'OE1X', ts: '2026-10-04T16:00:00.000Z' }];
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

test('a title edit pending in the debounce survives an immediate save', async ({ page }) => {
  await openNewLog(page, 'E2E Alt');
  await page.locator('#log-title').fill('E2E Neu');
  await page.locator('#f-call').fill('OE1ABC');
  await page.locator('#btn-save').click();
  await expect(page.locator('#log-body')).toContainText('OE1ABC');
  await expect(page.locator('#log-title')).toHaveValue('E2E Neu');
  await expect.poll(() => storedEvent(page).then(e => e.title)).toBe('E2E Neu');
  expect((await storedEvent(page)).nextSeq).toBe(2);
});

test('a header write from a tab with a stale counter never lowers nextSeq', async ({ page }) => {
  await openNewLog(page, 'E2E Zähler');
  await logCall(page, 'OE1ABC');
  // another tab issued numbers up to 8
  await patchStoredEvent(page, { nextSeq: 9 });
  await page.locator('#log-title').fill('E2E Zähler 2');
  await expect.poll(() => storedEvent(page).then(e => e.title)).toBe('E2E Zähler 2');
  expect((await storedEvent(page)).nextSeq).toBe(9);
  await logCall(page, 'OE3XYZ');
  const backup = JSON.parse(await downloadText(await exportAs(page, 'json')));
  expect(backup.events[0].entries.map(e => e.seq).sort()).toEqual([1, 9]);
  expect(backup.events[0].event.nextSeq).toBe(10);
  // an export mark doesn't touch the counter either
  await patchStoredEvent(page, { nextSeq: 20 });
  await exportAs(page, 'csv');
  await expect.poll(() => storedEvent(page).then(e => e.lastExport !== undefined)).toBe(true);
  expect((await storedEvent(page)).nextSeq).toBe(20);
});

test('an out-of-range stored counter is repaired by the next save', async ({ page }) => {
  await openNewLog(page, 'E2E Zähler kaputt');
  await logCall(page, 'OE1ABC');
  await patchStoredEvent(page, { nextSeq: 1e15 });
  await logCall(page, 'OE3XYZ');
  const e = await storedEvent(page);
  expect(e.nextSeq).toBe(3);
  const backup = JSON.parse(await downloadText(await exportAs(page, 'json')));
  expect(backup.events[0].entries.map(l => l.seq).sort()).toEqual([1, 2]);
});

test('a save while the header write is in flight keeps the typed title', async ({ page }) => {
  await openNewLog(page, 'E2E Flug');
  // slow the title write down: hold the events transaction open a moment
  await page.locator('#log-title').fill('E2E Flug neu');
  await page.waitForTimeout(450); // debounce fired, write in flight or done
  await page.locator('#f-call').fill('OE1ABC');
  await page.locator('#btn-save').click();
  await expect(page.locator('#log-body')).toContainText('OE1ABC');
  await expect(page.locator('#log-title')).toHaveValue('E2E Flug neu');
  await page.locator('#log-title').fill('E2E Flug neu 2');
  await expect.poll(() => storedEvent(page).then(e => e.title)).toBe('E2E Flug neu 2');
});

// Issue #15: the log's rows are kept between renders; typing only toggles the
// "match" class of a station's rows, a save adds one row.
test('typing marks the rows of the call without rebuilding the table, a save adds one row', async ({ page }) => {
  await openNewLog(page, 'E2E Zeilen');
  await logCall(page, 'OE1ABC');
  await logCall(page, 'OE3XYZ');
  await logCall(page, 'OE1ABC');
  const rows = page.locator('#log-body tr[data-id]');
  await expect(rows).toHaveCount(3);
  // number the existing row nodes (newest first)
  await page.evaluate(() => document.querySelectorAll('#log-body tr[data-id]').forEach((tr, i) => { tr.probe = i; }));
  const kept = () => page.evaluate(() => [...document.querySelectorAll('#log-body tr[data-id]')].map(tr => tr.probe ?? null));
  const matching = () => page.locator('#log-body tr.match').evaluateAll(trs => trs.map(tr => tr.querySelector('td.call').firstChild.textContent));
  await page.locator('#f-call').focus();
  await page.keyboard.type('oe1abc');
  await expect(page.locator('#log-body tr.match')).toHaveCount(2);
  expect(await matching()).toEqual(['OE1ABC', 'OE1ABC']);
  await expect(page.locator('#f-call')).toBeFocused();
  expect(await kept()).toEqual([0, 1, 2]); // the same nodes
  await page.locator('#f-call').fill('OE3XYZ');
  await expect(page.locator('#log-body tr.match')).toHaveCount(1);
  expect(await matching()).toEqual(['OE3XYZ']);
  await page.locator('#f-call').fill('OE9ZZZ');
  await expect(page.locator('#log-body tr.match')).toHaveCount(0);
  expect(await kept()).toEqual([0, 1, 2]);
  // a save: one new row on top, the others are the same nodes
  await logCall(page, 'OE9ZZZ');
  await expect(rows).toHaveCount(4);
  expect(await kept()).toEqual([null, 0, 1, 2]);
  await expect(page.locator('#log-body tr.match')).toHaveCount(0);
  // the repeat check-in badge follows the new count
  await logCall(page, 'OE1ABC');
  await expect(rows.first().locator('.badge')).toHaveText('3×');
});

test('editing a line and deleting one keep the other rows', async ({ page }) => {
  await openNewLog(page, 'E2E Bearbeiten');
  await logCall(page, 'OE1ABC');
  await logCall(page, 'OE3XYZ');
  await page.evaluate(() => document.querySelectorAll('#log-body tr[data-id]').forEach((tr, i) => { tr.probe = i; }));
  const kept = () => page.evaluate(() => [...document.querySelectorAll('#log-body tr[data-id]')].map(tr => tr.probe ?? null));
  await page.getByRole('button', { name: /^Bearbeiten\W+Nr\. 1 OE1ABC$/ }).click();
  await expect(page.locator('#log-body tr.editing')).toHaveCount(1);
  await expect(page.locator('#log-body tr.editing')).toContainText('OE1ABC');
  await page.locator('#f-note').fill('geändert');
  await page.locator('#btn-save').click();
  await expect(page.locator('#log-body')).toContainText('geändert');
  await expect(page.locator('#log-body tr.editing')).toHaveCount(0);
  expect(await kept()).toEqual([0, null]); // the edited row is new, the other one is the same
  await page.getByRole('button', { name: /Nr\. 2 OE3XYZ löschen/ }).click();
  await expect(page.locator('#log-body tr[data-id]')).toHaveCount(1);
  await expect(page.locator('#st-total')).toHaveText('1');
});

// Issue #15 review: a row is reused while its signature is equal. With a clock
// that does not advance (or a coarse one) an edit gets the same `updated`
// as the stored line; the changed note / comment must still be shown.
test('an edit made at an unchanged clock time still replaces the row (note and comment)', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-04T16:00:00.000Z'));
  await openNewLog(page, 'E2E Uhr');
  await logCall(page, 'OE1ABC');
  await page.locator('#f-call').fill('!');
  await page.locator('#f-ctext').fill('Wechsel auf 145.500');
  await page.locator('#btn-save').click();
  await expect(page.locator('#log-body')).toContainText('Wechsel auf 145.500');
  await page.getByRole('button', { name: /^Bearbeiten\W+Nr\. 1 OE1ABC$/ }).click();
  await page.locator('#f-note').fill('erste Notiz');
  await page.locator('#btn-save').click();
  await expect(page.locator('#log-body')).toContainText('erste Notiz');
  await page.getByRole('button', { name: /^Bearbeiten\W+Nr\. 1 OE1ABC$/ }).click();
  await page.locator('#f-note').fill('zweite Notiz');
  await page.locator('#btn-save').click();
  await expect(page.locator('#log-body')).toContainText('zweite Notiz');
  await expect(page.locator('#log-body')).not.toContainText('erste Notiz');
  await page.getByRole('button', { name: /^Bearbeiten\W+Kommentar/ }).click();
  await page.locator('#f-ctext').fill('Wechsel auf 145.600');
  await page.locator('#btn-save').click();
  await expect(page.locator('#log-body')).toContainText('Wechsel auf 145.600');
  await expect(page.locator('#log-body')).not.toContainText('145.500');
});

// The switch above the form: Check-in | Kommentar (besides "!" in the
// callsign field). Typed input of the other kind is never thrown away.
test('the form switches between check-in and operator comment', async ({ page }) => {
  await openNewLog(page, 'E2E Umschalter');
  const mode = page.getByRole('group', { name: 'Art der Zeile' });
  const checkin = mode.getByRole('button', { name: 'Check-in' });
  const comment = mode.getByRole('button', { name: 'Kommentar' });
  await expect(checkin).toHaveAttribute('aria-pressed', 'true');

  // a half-typed check-in stays: save or discard it first
  await page.locator('#f-call').fill('OE1ABC');
  await comment.click();
  await expect(page.locator('#log-status')).toContainText('erst diese Zeile speichern oder verwerfen');
  await expect(page.locator('#f-ctext')).toBeHidden();
  await expect(page.locator('#f-call')).toHaveValue('OE1ABC');
  await page.locator('#f-call').fill('');

  const height = async () => (await page.locator('#entry-form').boundingBox()).height;
  const before = await height();
  await comment.click();
  await expect(comment).toHaveAttribute('aria-pressed', 'true');
  // the form keeps its height: the log below doesn't move
  expect(Math.abs(await height() - before)).toBeLessThan(2);
  await checkin.click(); // empty comment: back without a question
  expect(Math.abs(await height() - before)).toBeLessThan(2);
  await comment.click();
  await expect(page.locator('#log-status')).toHaveText('');
  await expect(page.locator('#f-ctext')).toBeFocused();
  await expect(page.locator('#f-call')).toBeHidden();
  await page.locator('#f-ctext').fill('Operatorwechsel auf OE1XYZ');
  await checkin.click();
  await expect(page.locator('#log-status')).toContainText('Erst den Kommentar speichern');
  await expect(page.locator('#f-ctext')).toHaveValue('Operatorwechsel auf OE1XYZ');
  await page.locator('#btn-save').click();
  await expect(page.locator('#log-body tr.marker')).toContainText('Operatorwechsel auf OE1XYZ');
  // after saving: back to check-ins
  await expect(checkin).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#f-call')).toBeVisible();
});

// The empty form to print in advance (Leerformular): a one-page PDF in the
// log's columns, opened in a new tab; also from the overview, per template.
// Its content: tests/confirm-paperpdf.test.mjs.
test('the empty form (Leerformular) opens a one-page PDF', async ({ page }) => {
  await openNewLog(page, 'E2E Papier');
  // the PDF is read from its Blob (fetching the blob: URL is not allowed
  // by the page's CSP, connect-src 'self')
  await page.evaluate(() => {
    window.__opened = [];
    window.__blobs = new Map();
    const make = URL.createObjectURL;
    URL.createObjectURL = blob => { const url = make(blob); window.__blobs.set(url, blob); return url; };
    window.open = url => { window.__opened.push(url); return {}; };
  });
  const pdf = async () => page.evaluate(async () => {
    const blob = window.__blobs.get(window.__opened.at(-1));
    return { type: blob.type, text: await blob.text() };
  });
  await page.locator('#btn-export-menu').click();
  await page.getByRole('button', { name: 'Leerformular (PDF)' }).click();
  let doc = await pdf();
  expect(doc.type).toBe('application/pdf');
  expect(doc.text.startsWith('%PDF-1.4')).toBe(true);
  expect(doc.text).toContain('/Count 1');
  expect(doc.text).not.toContain('E2E Papier'); // empty: not even the log's title
  // the page itself is not printed
  expect(await page.evaluate(() => document.documentElement.dataset.print)).toBeUndefined();

  // the overview: one entry per template
  await page.getByRole('button', { name: '← Logs' }).click();
  await page.getByRole('button', { name: /^Leerformular/ }).click();
  await page.getByRole('button', { name: 'Zivilschutz-Probealarm' }).click();
  doc = await pdf();
  expect(await page.evaluate(() => window.__opened.length)).toBe(2);
  expect(doc.text).toContain('/Count 1');
});

test('a re-render after a highlight set from outside the field leaves no stale match', async ({ page }) => {
  await openNewLog(page, 'E2E Match');
  await logCall(page, 'OE1ABC');
  await logCall(page, 'OE3XYZ');
  await page.locator('#f-call').fill('OE1ABC');
  await expect(page.locator('#log-body tr.match')).toHaveCount(1);
  // the field is emptied without an input event (like a map pick leaves it),
  // then a data change re-renders the log
  await page.evaluate(() => { document.querySelector('#f-call').value = ''; });
  await page.getByRole('button', { name: /Nr\. 2 OE3XYZ löschen/ }).click();
  await expect(page.locator('#log-body tr[data-id]')).toHaveCount(1);
  await expect(page.locator('#log-body tr.match')).toHaveCount(0);
});

test('service worker installs the offline copy', async ({ page, browserName }) => {
  // Playwright drives service workers reliably only in Chromium.
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await page.goto('tools/confirm/');
  await expect(page.locator('#st-offline')).toHaveText(/offline bereit/, { timeout: 45_000 });
});

// Issue #15 review: a backup beyond the import limits is exported in parts and
// imported together. The test hook CONFIRM_PART_LIMITS lowers the limits, so
// a small log is split (nothing heavy).
test('a split export is imported from all its parts together, one part alone is refused', async ({ page, browser, baseURL }, testInfo) => {
  await page.addInitScript(() => { globalThis.CONFIRM_PART_LIMITS = { maxRecords: 2 }; });
  await openNewLog(page, 'E2E Teile');
  for (const c of ['OE1AAA', 'OE1BBB', 'OE1CCC', 'OE1DDD', 'OE1EEE']) await logCall(page, c);
  const downloads = [];
  page.on('download', d => downloads.push(d));
  const first = page.waitForEvent('download');
  await page.locator('#btn-export-menu').click();
  await page.locator('#export-list [data-export="json"]').click();
  const count = Number((await first).suggestedFilename().match(/_teil-\d+-von-(\d+)\.json$/)[1]);
  expect(count).toBeGreaterThanOrEqual(3);
  await expect.poll(() => downloads.length).toBe(count);
  await expect(page.locator('#log-status')).toContainText(`Download von ${count} Dateien gestartet`);
  const paths = [];
  for (const d of downloads) {
    const p = testInfo.outputPath(d.suggestedFilename());
    await d.saveAs(p);
    paths.push(p);
  }
  const ctx = await browser.newContext({ baseURL, locale: 'de-AT', timezoneId: 'Europe/Vienna' });
  try {
    const b = await ctx.newPage();
    await b.goto('tools/confirm/');
    await expect.poll(() => b.evaluate(() => globalThis.CONFIRM_READY === true)).toBe(true);
    await b.locator('#import-file').setInputFiles(paths.slice(0, 1));
    await expect(b.locator('#import-msg')).toContainText('es fehlen die Teile');
    await expect(b.locator('#import-msg')).toContainText('nichts importiert');
    await expect(b.locator('#event-list')).not.toContainText('E2E Teile');
    await b.locator('#import-file').setInputFiles(paths);
    await expect(b.locator('#import-msg')).toContainText('1 Log importiert');
    await expect(b.locator('#import-msg')).not.toContainText('Kopie');
    await b.getByText('E2E Teile').first().click();
    await expect(b.locator('#log-body tr[data-id]')).toHaveCount(5);
    for (const c of ['OE1AAA', 'OE1EEE']) await expect(b.locator('#log-body')).toContainText(c);
  } finally {
    await ctx.close();
  }
});

// An export that could not be restored as one set is refused before anything is downloaded.
test('a split export beyond the set limits is refused without any download', async ({ page }) => {
  await page.addInitScript(() => { globalThis.CONFIRM_PART_LIMITS = { maxRecords: 2, maxParts: 2 }; });
  await openNewLog(page, 'E2E Zu groß');
  for (const c of ['OE1AAA', 'OE1BBB', 'OE1CCC', 'OE1DDD', 'OE1EEE']) await logCall(page, c);
  let downloads = 0;
  page.on('download', () => { downloads++; });
  await page.locator('#btn-export-menu').click();
  await page.locator('#export-list [data-export="json"]').click();
  await expect(page.locator('#export-msg')).toContainText('Zu groß für eine einzige Sicherung');
  await expect(page.locator('#export-msg')).toContainText('Es wurde nichts heruntergeladen');
  await expect(page.locator('#export-msg')).toContainText('einzelnen Logs');
  await page.waitForTimeout(1000);
  expect(downloads).toBe(0);
});

// A note beyond the file limit is written as chunks across the parts and put
// together again (the hook lowers the limits, so a small note stands in for 50 MB).
test('a note beyond the per-file limit is chunked across the parts and restored whole', async ({ page, browser, baseURL }, testInfo) => {
  await page.addInitScript(() => { globalThis.CONFIRM_PART_LIMITS = { maxBytes: 9000, chunkChars: 3000 }; });
  await openNewLog(page, 'E2E Notiz');
  const note = 'Anfang-' + 'n'.repeat(20000) + '-Ende';
  await page.locator('#f-call').fill('OE1AAA');
  await page.locator('#f-note').fill(note);
  await page.locator('#btn-save').click();
  await expect(page.locator('#log-body')).toContainText('-Ende');
  const downloads = [];
  page.on('download', d => downloads.push(d));
  const first = page.waitForEvent('download');
  await page.locator('#btn-export-menu').click();
  await page.locator('#export-list [data-export="json"]').click();
  const count = Number((await first).suggestedFilename().match(/_teil-\d+-von-(\d+)\.json$/)[1]);
  expect(count).toBeGreaterThanOrEqual(3);
  await expect.poll(() => downloads.length).toBe(count);
  const paths = [];
  for (const d of downloads) {
    const p = testInfo.outputPath(d.suggestedFilename());
    await d.saveAs(p);
    paths.push(p);
  }
  const ctx = await browser.newContext({ baseURL, locale: 'de-AT', timezoneId: 'Europe/Vienna' });
  try {
    const b = await ctx.newPage();
    await b.goto('tools/confirm/');
    await expect.poll(() => b.evaluate(() => globalThis.CONFIRM_READY === true)).toBe(true);
    // a tampered set (chunk kind "__proto__"): a clear refusal reaches the user, nothing is imported
    const tampered = paths.map((fp, i) => {
      const d = JSON.parse(readFileSync(fp, 'utf8'));
      for (const c of d.chunks || []) c.kind = '__proto__';
      const out = testInfo.outputPath(`tampered-${i}.json`);
      writeFileSync(out, JSON.stringify(d));
      return out;
    });
    await b.locator('#import-file').setInputFiles(tampered);
    await expect(b.locator('#import-msg')).toContainText('nichts importiert');
    await expect(b.locator('#event-list')).not.toContainText('E2E Notiz');
    await b.locator('#import-file').setInputFiles(paths);
    await expect(b.locator('#import-msg')).toContainText('1 Log importiert');
    await b.getByText('E2E Notiz').first().click();
    await expect(b.locator('#log-body')).toContainText(note);
  } finally {
    await ctx.close();
  }
});

test('the local time choice names the zone and its short name', async ({ page }) => {
  await page.goto('tools/confirm/');
  await expect.poll(() => page.evaluate(() => globalThis.CONFIRM_READY === true)).toBe(true);
  // the test browsers run in Europe/Vienna
  await expect(page.locator('#time-toggle button[data-time-mode="local"]')).toHaveText(/^Europe\/Vienna \((MESZ|MEZ)\)$/);
});
