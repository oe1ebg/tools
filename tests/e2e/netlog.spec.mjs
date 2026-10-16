// Netlog (/tools/netlog/): sessions and series, check-ins with partial
// callsigns, inline correction and status, roster order, the read-only
// second tab, both languages. Synthetic callsigns only (OE0QX…).
import { test, expect, offlineSettled } from './fixtures.mjs';

// The test browsers run with locale de-AT: Netlog starts in German. Tests
// that need English set the pref first.
async function open(page, { lang } = {}) {
  if (lang) await page.addInitScript(l => { try { localStorage.setItem('oe1ebg-netlog-lang', l); } catch { /* blocked */ } }, lang);
  await page.goto('tools/netlog/');
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await offlineSettled(page);
}

async function startSession(page, { round, own = 'OE0QXA' } = {}) {
  await page.locator('#btn-new-session').click();
  await page.locator('#sf-own').fill(own);
  if (round) {
    await page.locator('#sf-round').fill(String(round));
    await page.locator('#sf-joined').check();
  }
  await page.locator('#session-form button[type=submit]').click();
  await expect(page.locator('#view-live')).toBeVisible();
}

async function checkIn(page, call, name = '') {
  await page.locator('#checkin-call').fill(call);
  if (name) await page.locator('#checkin-name').fill(name);
  await page.locator('#checkin-name').press('Enter');
  await expect(page.locator('#roster')).toContainText(call);
}

const roster = page => page.locator('#roster button.person .call');

test('starts in German, switches to English and back, keeping the input', async ({ page }) => {
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('#tab-series')).toHaveText('Sitzungen & Serien');
  await startSession(page);
  await page.locator('#checkin-call').fill('OE0QX');
  await page.locator('#lang-toggle button[data-lang=en]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#tab-live')).toHaveText('Live Notes');
  await expect(page.locator('#checkin-call')).toHaveValue('OE0QX');
  await expect(page.locator('#st-offline')).toHaveText('offline ready ✓');
  await page.reload();
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await expect(page.locator('#tab-live')).toHaveText('Live Notes');
  await page.locator('#lang-toggle button[data-lang=de]').click();
  await expect(page.locator('#tab-live')).toHaveText('Live-Notizen');
});

test('ad-hoc session mid-net: partial callsign resolved later, series assigned later', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page, { round: 3 });
  await expect(page.locator('#round-indicator')).toHaveText('Round 3');
  await checkIn(page, 'OE0QXB', 'Jonas');
  await checkIn(page, 'OE0QX?');
  await expect(page.locator('#station-sub')).toContainText('not confirmed');
  // correct inline: the same participant keeps its identity
  const id = await page.evaluate(() => globalThis.NETLOG_APP.ui.selected);
  await page.locator('#btn-edit-identity').click();
  await page.locator('#identity-call').fill('OE0QXC');
  await page.locator('#identity-name').fill('Lea');
  await page.locator('#identity-call').press('Enter');
  await expect(page.locator('#station-call')).toHaveText('OE0QXC');
  expect(await page.evaluate(() => globalThis.NETLOG_APP.ui.selected)).toBe(id);
  await expect(roster(page)).toHaveText(['OE0QXB', 'OE0QXC']);

  // a series afterwards: the session moves into it, numbered #1
  await page.locator('#tab-series').click();
  await page.locator('#btn-new-series').click();
  await page.locator('#srf-name').fill('Fictional evening net');
  await page.locator('#series-form button[type=submit]').click();
  await expect(page.locator('#series-list')).toContainText('Fictional evening net');
  await page.locator('#series-list select[data-assign]').first().selectOption({ label: 'Fictional evening net' });
  await expect(page.locator('#session-line')).toContainText('Fictional evening net #1');
  await page.locator('#tab-live').click();
  await expect(roster(page)).toHaveText(['OE0QXB', 'OE0QXC']);
});

test('keyboard only: check in, move through the roster, status and order', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  for (const c of ['OE0QXA', 'OE0QXB', 'OE0QXC']) {
    await page.locator('#checkin-call').focus();
    await page.keyboard.type(c.toLowerCase());
    await page.keyboard.press('Enter'); // to the name field
    await page.keyboard.press('Enter'); // check in
  }
  await expect(roster(page)).toHaveText(['OE0QXA', 'OE0QXB', 'OE0QXC']);
  // Esc leaves the field; j/k move through the roster without typing anything
  await page.keyboard.press('Escape');
  await expect(page.locator('#mode-indicator')).toHaveText('Navigation');
  await page.locator('#roster button.person').first().focus();
  await page.keyboard.press('j');
  await expect(page.locator('#roster li.active .call')).toHaveText('OE0QXB');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#roster li.active .call')).toHaveText('OE0QXC');
  await page.keyboard.press('k');
  await expect(page.locator('#roster li.active .call')).toHaveText('OE0QXB');
  // reorder with the labelled buttons
  await page.getByRole('button', { name: 'Move OE0QXB up' }).click();
  await expect(roster(page)).toHaveText(['OE0QXB', 'OE0QXA', 'OE0QXC']);
  // status: check out and back in = a reentry (two presence intervals)
  await page.locator('#station-status').selectOption('out');
  await expect(page.locator('#roster li.active .dot')).toHaveClass(/out/);
  await page.locator('#station-status').selectOption('active');
  await page.locator('#btn-details').click();
  await expect(page.locator('#presence-list li')).toHaveCount(2);
  // typing j/k in a field types them
  await page.locator('#det-qth').fill('');
  await page.locator('#det-qth').type('jk');
  await expect(page.locator('#det-qth')).toHaveValue('jk');
  await page.locator('#det-qth').press('Enter');
  await expect(page.locator('#st-save')).toContainText('saved');
  await page.reload();
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await expect(page.locator('#det-qth')).toHaveValue('jk');
});

test('a second tab is read-only until "Edit here"', async ({ page, context }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  await checkIn(page, 'OE0QXA');
  const url = page.url();
  const other = await context.newPage();
  await other.goto(url);
  await expect.poll(() => other.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await expect(other.locator('#lock-banner')).toBeVisible();
  await expect(other.locator('#checkin-call')).toBeDisabled();
  await other.locator('#btn-edit-here').click();
  await expect(other.locator('#lock-banner')).toBeHidden();
  await expect(page.locator('#lock-banner')).toBeVisible();
  await expect(page.locator('#checkin-call')).toBeDisabled();
  await other.close();
});
