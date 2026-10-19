// The Wavelog import page (tools/wavelog-import/, issue #82) against a
// stubbed instance (https://wl.example.org/api/v2/…): errors next to their
// field, the import in pages, the token cleared afterwards, the result in
// the shared callsign store and read by Netlog, erasing. Synthetic
// callsigns (OE0QX…) and fictitious names only.
import { test, expect } from './fixtures.mjs';

const HOST = 'https://wl.example.org';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,accept', 'access-control-allow-methods': 'GET,OPTIONS' };

const qso = (id, call, date, extra = {}) => ({ id, station_id: 1, call, band: '20m', mode: 'SSB', submode: null, qso_date: `${date} 12:00:00`, gridsquare: '', name: '', qth: '', ...extra });
const PAGES = {
  1: [qso(12, 'OE0QXA', '2026-03-01', { name: 'Anna Beispiel', qth: 'Graz', gridsquare: 'JN77' }), qso(11, 'OE0QXB', '2026-02-01')],
  2: [qso(10, 'OE0QXA', '2026-01-01'), qso(9, 'OE0QXC', '2025-12-01', { name: 'Carl Muster' })],
};

async function stub(page, { token = 'wl2_good', seen = [] } = {}) {
  await page.route(`${HOST}/api/v2/**`, route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    seen.push(`${url.pathname}${url.search}`);
    const json = (status, body) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (req.headers().authorization !== `Bearer ${token}`) return json(401, { error: { code: 'invalid_token', message: 'no' } });
    if (url.pathname.endsWith('/logbook')) return json(200, { data: [{ id: 3, name: 'Contest', active: true, station_ids: [1, 4] }] });
    if (url.pathname.endsWith('/token')) return json(200, { data: { scopes: ['logbook:read', 'qso:read'] } });
    if (url.pathname.endsWith('/qso')) {
      const page = Number(url.searchParams.get('page'));
      return json(200, { data: PAGES[page] || [], meta: { page, per_page: 2, count: 2, total: 4, total_pages: 2, has_more: page < 2 } });
    }
    return json(404, { error: { code: 'not_found', message: 'x' } });
  });
}

async function open(page) {
  await page.goto('tools/wavelog-import/');
  await expect.poll(() => page.evaluate(() => globalThis.WAVELOG_IMPORT_READY === true)).toBe(true);
}

test('errors stay next to their field and nothing is imported', async ({ page, expectConsoleError }) => {
  expectConsoleError(/Failed to load resource.*401/);   // the browser's own line for a refused request
  await stub(page);
  await open(page);
  await page.locator('#wl-url').fill('http://wl.example.org');
  await page.locator('#wl-token').fill('wl2_bad');
  await page.locator('#btn-logbooks').click();
  await expect(page.locator('#wl-url-err')).toContainText('keine brauchbare Adresse');
  await page.locator('#wl-url').fill(HOST);
  await page.locator('#btn-logbooks').click();
  await expect(page.locator('#wl-token-err')).toContainText('abgelehnt');
  await expect(page.locator('#wl-token')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#import-card')).toBeHidden();
  await expect(page.locator('#wl-sources')).toContainText('Noch nichts importiert');
});

test('import a logbook page by page; token not kept; Netlog reads the result; erase', async ({ page }) => {
  const seen = [];
  await stub(page, { seen });
  await open(page);
  await page.locator('#wl-url').fill(`${HOST}/`);
  await page.locator('#wl-token').fill('wl2_good');
  await page.locator('#btn-logbooks').click();
  await expect(page.locator('#import-card')).toBeVisible();
  await expect(page.locator('#wl-logbook')).toHaveText('Contest');
  await expect(page.locator('#wl-stations')).toContainText('1, 4');
  await page.locator('#btn-import').click();
  await expect(page.locator('#wl-status')).toContainText('Fertig: 4 QSOs, 3 Rufzeichen');
  await expect(page.locator('#wl-token')).toHaveValue('');
  await expect(page.locator('#wl-sources')).toContainText('Wavelog wl.example.org – Contest');
  expect(seen.filter(u => u.includes('/qso'))).toEqual([
    '/api/v2/qso?station_id=1%2C4&page=1&per_page=1000&format=json',
    '/api/v2/qso?station_id=1%2C4&page=2&per_page=1000&format=json',
  ]);
  // the token is nowhere in the page's storage
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain('wl2_good');

  // Netlog (same origin, same store) reads it offline
  await page.goto('tools/netlog/');
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await page.locator('#tab-series').click();
  const rows = page.locator('#lists-list .list-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Wavelog-Import');
  await expect(rows.first().locator('[data-act=replace]')).toBeHidden();
  await page.locator('#btn-new-session').click();
  await page.locator('#sf-own').fill('OE0QXZ');
  await page.locator('#session-form button[type=submit]').click();
  await page.locator('#checkin-call').fill('OE0QXA');
  await expect(page.locator('#checkin-info')).toContainText('Anna Beispiel');
  await expect(page.locator('#checkin-info')).toContainText('Graz');
  await expect(page.locator('#checkin-info')).toContainText('2 QSO, 2026-03-01');

  // erase for good
  await page.goto('tools/wavelog-import/');
  await expect.poll(() => page.evaluate(() => globalThis.WAVELOG_IMPORT_READY === true)).toBe(true);
  page.on('dialog', d => d.accept());
  await page.locator('#wl-sources button[data-erase]').click();
  await expect(page.locator('#wl-sources')).toContainText('Noch nichts importiert');
});

test('a token without the needed scope is named in the message', async ({ page, expectConsoleError }) => {
  expectConsoleError(/Failed to load resource.*403/);
  await page.route(`${HOST}/api/v2/**`, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    return route.fulfill({ status: 403, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: 'insufficient_scope', message: 'x', details: { required_scope: 'logbook:read' } } }) });
  });
  await open(page);
  await page.locator('#wl-url').fill(HOST);
  await page.locator('#wl-token').fill('wl2_x');
  await page.locator('#btn-logbooks').click();
  await expect(page.locator('#wl-token-err')).toContainText('logbook:read');
});
