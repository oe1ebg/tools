// SOTA Alerts Map (/tools/sota-alerts/), hermetic: the live SOTA API and the map
// tile servers are stubbed with page.route() (registered after the
// fixture's catch-all, so they take precedence), so the test never depends
// on api2.sota.org.uk or a tile server being up.
import { test, expect } from './fixtures.mjs';

// 1x1 transparent PNG for every map tile.
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const TILE_HOSTS = /^https:\/\/([a-c]\.tile\.opentopomap\.org|tile\.openstreetmap\.org|mapsneu\.wien\.gv\.at)\//;

function alertsIn(hours) {
  const at = h => new Date(Date.now() + h * 3600_000).toISOString().slice(0, 19);
  return [
    // in the build-time summit lookup (data/summit-lookup.json)
    { id: 1, dateActivated: at(hours), associationCode: 'OE', summitCode: 'WI-001', summitDetails: 'Hermannskogel',
      frequency: '145.500-fm', comments: 'e2e', activatingCallsign: 'OE1ABC/P', activatorName: 'Test', posterCallsign: 'OE1ABC' },
    // not in the lookup: resolved through the (stubbed) per-summit API
    { id: 2, dateActivated: at(hours + 2), associationCode: 'ZZ', summitCode: 'TE-001', summitDetails: 'Test Peak',
      frequency: '7.032-cw', comments: '', activatingCallsign: 'OE3XYZ', activatorName: '', posterCallsign: 'OE3XYZ' },
  ];
}

test('renders stubbed alerts on the map', async ({ page }) => {
  const api = [];
  await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
  await page.route('https://api2.sota.org.uk/**', route => {
    const url = new URL(route.request().url());
    api.push(url.pathname);
    if (url.pathname === '/api/alerts') return route.fulfill({ json: alertsIn(3) });
    if (url.pathname === '/api/summits/ZZ/TE-001') {
      return route.fulfill({ json: { name: 'Test Peak', altM: 1000, points: 4, latitude: 47.5, longitude: 15.5, locator: 'JN77SM' } });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto('tools/sota-alerts/');
  await expect(page).toHaveTitle(/SOTA/);
  await expect(page.locator('#map.leaflet-container')).toBeVisible();
  await expect(page.locator('#stats')).toHaveText('2 alerts · 2 summits on map · 0 yours');
  await expect(page.locator('#warnings')).toBeEmpty();
  // OE/WI-001 comes from the build-time lookup, only ZZ/TE-001 from the API
  expect(api.sort()).toEqual(['/api/alerts', '/api/summits/ZZ/TE-001']);
});

test('reference, filters, search, pins, popups and a shared link', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile'), 'desktop layout: list and filters visible without the phone toggle');
  await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
  await page.route('https://api2.sota.org.uk/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/alerts') {
      const alerts = alertsIn(3);
      alerts[1].comments = '<b>not bold</b>'; // data, shown as text
      return route.fulfill({ json: alerts });
    }
    if (path === '/api/summits/ZZ/TE-001') {
      return route.fulfill({ json: { name: 'Test Peak', altM: 1000, points: 4, latitude: 47.5, longitude: 15.5, locator: 'JN77SM' } });
    }
    if (path === '/api/summits/ZZ/TE-002') {
      return route.fulfill({ json: { name: 'Test Two', altM: 800, points: 2, latitude: 47.6, longitude: 15.6, locator: null } });
    }
    if (path === '/api/summits/search/test') {
      return route.fulfill({ json: [{ summitCode: 'ZZ/TE-002', name: 'Test Two', altM: 800, points: 2, latitude: 47.6, longitude: 15.6, locator: null }] });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto('tools/sota-alerts/');
  const stats = page.locator('#stats');
  await expect(stats).toHaveText('2 alerts · 2 summits on map · 0 yours');

  // the list: a row click sets the reference, the other row shows its distance
  await page.locator('#btn-toggle-list').click();
  const rows = page.locator('#list-items .list-item');
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: 'OE/WI-001' }).click();
  await expect(page.locator('#ref-indicator')).toContainText('(OE/WI-001)');
  await expect(page.locator('#list-items .list-section-title')).toContainText('sorted by distance to');
  await expect(rows.filter({ hasText: 'ZZ/TE-001' }).locator('.ref-diff')).toHaveText(/^\d+\.\d km, \+?-?\d+ m from reference \(.+\)$/);
  await expect(rows.filter({ hasText: 'OE/WI-001' })).toHaveAttribute('aria-pressed', 'true');

  // band filter
  await page.locator('#btn-toggle-bandmode').click();
  await page.locator('#band-checks label', { hasText: '40m' }).click();
  await expect(stats).toHaveText('1 alerts · 1 summits on map · 0 yours');
  await expect(page.locator('#btn-toggle-bandmode')).toHaveText('bands/modes (1) ▾');
  await page.locator('#btn-clear-bandmode').click();
  await expect(stats).toHaveText('2 alerts · 2 summits on map · 0 yours');

  // own callsign
  await page.locator('#callsigns-input').fill('oe3xyz/p');
  await page.locator('#callsigns-input').press('Tab');
  await expect(stats).toHaveText('2 alerts · 2 summits on map · 1 yours');

  // search and pin
  await page.locator('#summit-search').fill('test');
  const result = page.locator('#search-panel .search-result', { hasText: 'ZZ/TE-002' });
  await expect(result).toContainText('Test Two');
  await expect(page.locator('#search-status')).toHaveText('1 summit found');
  await result.getByRole('button', { name: '+ pin' }).click();
  await expect(result.getByRole('button', { name: 'pinned ✓' })).toBeDisabled();
  await expect(page.locator('#candidates-items')).toContainText('pinned summits');
  await expect(page.locator('#candidates-items .list-item')).toContainText('Test Two');
  await expect(stats).toHaveText('2 alerts · 3 summits on map · 1 yours');

  // a marker's popup: text from the API stays text; its buttons work
  // (from the keyboard: the marker can sit under the attribution control)
  await page.locator('.leaflet-marker-icon[aria-label^="ZZ/TE-001:"]').focus();
  await page.keyboard.press('Enter');
  const popup = page.locator('.leaflet-popup .sota-popup');
  await expect(page.locator('.leaflet-popup :focus')).toHaveCount(1); // focus moved into the popup
  await expect(popup.locator('.popup-title')).toHaveText('Test Peak ZZ/TE-001');
  await expect(popup.locator('.comment')).toHaveText('<b>not bold</b>');
  await expect(popup.getByRole('link', { name: 'sotl.as ↗' })).toHaveAttribute('href', 'https://sotl.as/summits/ZZ/TE-001');
  await expect(popup.locator('.ref-diff')).toContainText('from reference');
  await popup.getByRole('button', { name: 'set as reference' }).click();
  await expect(page.locator('#ref-indicator')).toContainText('reference: Test Peak (ZZ/TE-001)');

  // the pinned summit's "remove pin"
  await page.locator('#candidates-items').getByRole('button', { name: 'remove pin' }).click();
  await expect(page.locator('#candidates-items')).toBeEmpty();
  await expect(page.locator('#warnings')).toBeEmpty();

  // a shared link: reference (pinned too), pin and band filter applied,
  // query stripped; ZZ/TE-002 is in no cache, so it comes from the API
  await page.goto('tools/sota-alerts/?ref=ZZ/TE-001&pins=ZZ/TE-002&bands=40m');
  await expect(page.locator('#ref-indicator')).toContainText('reference: Test Peak (ZZ/TE-001)');
  await expect(stats).toHaveText('1 alerts · 2 summits on map · 1 yours');
  await expect(page.locator('#candidates-items .list-item')).toHaveCount(2);
  await expect(page).toHaveURL(/\/tools\/sota-alerts\/$/);
  await expect(page.locator('#warnings')).toBeEmpty();
});
