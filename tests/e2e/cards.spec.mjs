// Confirm's log and Notfunk's message book on a phone (#108 B1): below
// 640 px a row is a card, so the essential fields and the buttons are
// visible without scrolling sideways. The tables stay tables for screen
// readers (explicit roles). With the full example backups.
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.mjs';

const EXAMPLES = fileURLToPath(new URL('../../examples/backups/', import.meta.url));
const PHONE = { width: 360, height: 780 };

async function ready(page, tool, flag) {
  await page.goto(`tools/${tool}/`);
  await expect.poll(() => page.evaluate(f => globalThis[f] === true, flag)).toBe(true);
}

// nothing wider than the screen: no sideways scrolling of the page or the table
const fits = (page, wrap) => page.evaluate(sel => {
  const w = document.querySelector(sel);
  return document.documentElement.scrollWidth <= innerWidth && w.scrollWidth <= w.clientWidth;
}, wrap);
const inside = async loc => {
  const b = await loc.boundingBox();
  return b.x >= 0 && b.x + b.width <= PHONE.width;
};

test('Confirm on a phone: each check-in is a card with callsign, buttons and named details', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await ready(page, 'confirm', 'CONFIRM_READY');
  await page.locator('#import-file').setInputFiles(`${EXAMPLES}confirm-full.json`);
  await expect(page.locator('#import-msg')).toContainText('4 Logs importiert');
  await page.getByText('DEMO · Rundspruch-Bestätigungen 1').first().click();
  await expect(page.locator('#log-body tr[data-id]')).toHaveCount(15);
  expect(await fits(page, '#view-log .table-wrap')).toBe(true);

  const row = page.locator('#log-body tr[data-id]:not(.marker)').first();
  for (const cell of [row.locator('td.call'), row.getByRole('button', { name: /^Bearbeiten/ }), row.getByRole('button', { name: /löschen$/ })]) {
    expect(await inside(cell)).toBe(true);
  }
  // the callsign and the buttons share the first line; the details follow, named
  const call = await row.locator('td.call').boundingBox();
  const edit = await row.getByRole('button', { name: /^Bearbeiten/ }).boundingBox();
  expect(Math.abs(call.y - edit.y)).toBeLessThan(call.height);
  await expect(row.locator('td[data-label="Notiz"]')).toBeVisible();
  expect(await row.locator('td[data-label="Notiz"]').evaluate(td => getComputedStyle(td, '::before').content)).toContain('Notiz');
  // compact: a check-in with its details takes a few lines, not one per column
  expect((await row.boundingBox()).height).toBeLessThan(220);
  // "nicht zugeordnet" is a note, not a warning (B5)
  const hint = page.locator('#log-body .loc-sub.unresolved').first();
  const warn = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.color = 'var(--warn)';
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(await hint.evaluate(n => getComputedStyle(n).color)).not.toBe(warn);

  // still a table for assistive technology
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader', { name: 'Rufzeichen' })).toHaveCount(1);
  await expect(table.getByRole('row')).toHaveCount(16); // head + 15
  await expect(row.getByRole('cell').first()).toBeVisible();
});

test('Notfunk on a phone: each message is a card with number, status, subject and buttons', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await ready(page, 'notfunk', 'NOTFUNK_READY');
  await page.locator('#import-file').setInputFiles(`${EXAMPLES}notfunk-full.json`);
  await expect(page.locator('#import-msg')).toContainText('30 Meldungen neu');
  await page.getByRole('button', { name: /„DEMO \/ ÜBUNG · Modellpark Lindenhain“ öffnen/ }).click();
  await expect(page.locator('#book-body tr[data-id]')).toHaveCount(30);
  expect(await fits(page, '#view-book .table-wrap')).toBe(true);

  const row = page.locator('#book-body tr[data-id]').first();
  const num = row.locator('td.num');
  const status = row.locator('td').nth(6);
  const subject = row.locator('td.content b');
  for (const cell of [num, status, subject, row.getByRole('button', { name: /Ausdruck/ })]) {
    await expect(cell).toBeVisible();
    expect(await inside(cell)).toBe(true);
  }
  // number and status on the first line, the subject below
  const n = await num.boundingBox();
  const s = await status.boundingBox();
  expect(Math.abs(n.y - s.y)).toBeLessThan(n.height);
  expect((await subject.boundingBox()).y).toBeGreaterThan(n.y + n.height / 2);

  const table = page.getByRole('table', { name: 'Meldungen' });
  await expect(table.getByRole('columnheader', { name: 'Status' })).toHaveCount(1);
  await expect(table.getByRole('row')).toHaveCount(31);
});

// Wide screens: the log's column names stay in view while scrolling, right
// below the sticky page header (not under it).
test('Confirm on a wide screen: the column names stay in view while scrolling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile'), 'cards on phones');
  await page.setViewportSize({ width: 1200, height: 600 });
  await ready(page, 'confirm', 'CONFIRM_READY');
  await page.locator('#import-file').setInputFiles(`${EXAMPLES}confirm-full.json`);
  await expect(page.locator('#import-msg')).toContainText('4 Logs importiert');
  await page.getByText('DEMO · Rundspruch-Bestätigungen 1').first().click();
  await expect(page.locator('#log-body tr[data-id]')).toHaveCount(15);
  await page.locator('#log-body tr[data-id]').last().scrollIntoViewIfNeeded();
  const hdr = await page.locator('#site-header').boundingBox();
  await expect.poll(async () => Math.abs((await page.locator('table.log thead th').first().boundingBox()).y - (hdr.y + hdr.height))).toBeLessThan(2);
  // one line of column names
  const th = await page.locator('table.log thead th').first().boundingBox();
  expect(th.height).toBeLessThan(40);
});

test('Notfunk on a wide screen: the column names stay in view while scrolling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile'), 'cards on phones');
  await page.setViewportSize({ width: 1200, height: 600 });
  await ready(page, 'notfunk', 'NOTFUNK_READY');
  await page.locator('#import-file').setInputFiles(`${EXAMPLES}notfunk-full.json`);
  await expect(page.locator('#import-msg')).toContainText('30 Meldungen neu');
  await page.getByRole('button', { name: /„DEMO \/ ÜBUNG · Modellpark Lindenhain“ öffnen/ }).click();
  await expect(page.locator('#book-body tr[data-id]')).toHaveCount(30);
  await page.locator('#book-body tr[data-id]').last().scrollIntoViewIfNeeded();
  const hdr = await page.locator('#site-header').boundingBox();
  await expect.poll(async () => Math.abs((await page.locator('table.book thead th').first().boundingBox()).y - (hdr.y + hdr.height))).toBeLessThan(2);
  const th = await page.locator('table.book thead th').first().boundingBox();
  expect(th.height).toBeLessThan(40);
  // the zone of the Zeit column is explained
  await expect(page.locator('table.book thead th', { hasText: 'Zeit' })).toHaveAttribute('title', /Ortszeit Wien \(MESZ\/MEZ\)/);
  // the table fits at 1200 px and above (clipped, no columns lost); below, it scrolls
  for (const width of [1200, 1280]) {
    await page.setViewportSize({ width, height: 600 });
    expect(await page.evaluate(() => {
      const w = document.querySelector('#view-book .table-wrap');
      return w.scrollWidth <= w.clientWidth && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
  }
  for (const width of [700, 1100]) {
    await page.setViewportSize({ width, height: 600 });
    expect(await page.locator('#view-book .table-wrap').evaluate(w => getComputedStyle(w).overflowX)).toBe('auto');
  }
  await expect(page.locator('table.book thead th').last()).toBeAttached();
});

test('Notfunk on a phone: Save stays above an open suggestion list', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'touch screens only');
  await ready(page, 'notfunk', 'NOTFUNK_READY');
  await page.locator('#import-file').setInputFiles(`${EXAMPLES}notfunk-full.json`);
  await expect(page.locator('#import-msg')).toContainText('30 Meldungen neu');
  await page.getByRole('button', { name: /„DEMO \/ ÜBUNG · Modellpark Lindenhain“ öffnen/ }).click();
  await expect(page.locator('#book-body tr[data-id]')).toHaveCount(30);
  const peer = page.locator('#m-peer');
  await peer.scrollIntoViewIfNeeded();
  await peer.fill('OE1');
  const pop = page.locator('#m-peer-pop');
  await expect(pop).toBeVisible();
  // the field low in the viewport: the list reaches under the sticky Save row
  await peer.evaluate(e => { const r = e.getBoundingClientRect(); window.scrollBy(0, r.bottom - innerHeight + 40); });
  const save = page.locator('#btn-save');
  const sb = await save.boundingBox();
  const pb = await pop.boundingBox();
  expect(pb.y < sb.y + sb.height && pb.y + pb.height > sb.y).toBe(true); // they overlap
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('#btn-save') !== null, { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 })).toBe(true);
});

test('on a wide screen both stay ordinary tables', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await ready(page, 'notfunk', 'NOTFUNK_READY');
  await page.locator('#import-file').setInputFiles(`${EXAMPLES}notfunk-example.json`);
  await expect(page.locator('#import-msg')).toContainText('6 Meldungen neu');
  await page.getByRole('button', { name: /öffnen$/ }).first().click();
  await expect(page.locator('#book-body tr[data-id]')).toHaveCount(6);
  expect(await page.locator('#book-body tr[data-id]').first().evaluate(tr => getComputedStyle(tr).display)).toBe('table-row');
  await expect(page.locator('table.book thead')).toBeVisible();
});
