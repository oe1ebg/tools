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
