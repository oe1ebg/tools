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

// Request deadlines, stale searches, failed refreshes and shared-link
// limits (#13). `held` requests stay open until the test releases them,
// like a slow or hung server.
function stubSota(page, handlers) {
  return page.route('https://api2.sota.org.uk/**', route => {
    const handler = handlers[new URL(route.request().url()).pathname];
    if (handler) return handler(route);
    return route.fulfill({ status: 404, json: {} });
  });
}
const summitJson = { name: 'Test Peak', altM: 1000, points: 4, latitude: 47.5, longitude: 15.5, locator: 'JN77SM' };
const searchHit = (code, name) => [{ summitCode: code, name, altM: 800, points: 2, latitude: 47.6, longitude: 15.6, locator: null }];
// Answering a request the page has aborted meanwhile throws; that's expected.
const release = (route, json) => route.fulfill({ json }).catch(() => {});
const AGE = /^alerts as of \d{4}-\d\d-\d\d \d\d:\d\dZ$/;
// On a phone the toolbar controls sit behind the "filters" toggle.
async function showToolbar(page) {
  const toggle = page.locator('#btn-toggle-toolbar');
  if (await toggle.isVisible()) await toggle.click();
}

test('a hung alerts request runs into the deadline; refresh works afterwards', async ({ page }) => {
  await page.clock.install();
  await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
  let calls = 0;
  await stubSota(page, {
    '/api/alerts': route => { if (++calls > 1) return route.fulfill({ json: alertsIn(3) }); }, // the first one never answers
    '/api/summits/ZZ/TE-001': route => route.fulfill({ json: summitJson }),
  });
  await page.goto('tools/sota-alerts/');
  await expect.poll(() => calls).toBe(1);
  await showToolbar(page);
  const refresh = page.locator('#btn-refresh-alerts');
  await expect(refresh).toBeDisabled(); // start-up is still loading
  await page.clock.fastForward('00:25');
  await expect(page.locator('#warnings')).toContainText('could not load SOTA alerts (timed out after 20 s)');
  await expect(page.locator('#stats')).toHaveText('0 alerts · 0 summits on map · 0 yours');
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.locator('#stats')).toHaveText('2 alerts · 2 summits on map · 0 yours');
  await expect(page.locator('#warnings')).toBeEmpty();
  await expect(page.locator('#alerts-age')).toHaveText(AGE);
});

test('a failed refresh keeps the last-known alerts, marked as such', async ({ page }) => {
  await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
  let calls = 0;
  await stubSota(page, {
    // the second answer is broken (an HTML error page, as a busy server sends)
    '/api/alerts': route => (++calls === 2
      ? route.fulfill({ contentType: 'text/html', body: '<html>busy</html>' })
      : route.fulfill({ json: alertsIn(3) })),
    '/api/summits/ZZ/TE-001': route => route.fulfill({ json: summitJson }),
  });
  await page.goto('tools/sota-alerts/');
  const stats = page.locator('#stats');
  const age = page.locator('#alerts-age');
  await expect(stats).toHaveText('2 alerts · 2 summits on map · 0 yours');
  await expect(age).toHaveText(AGE);
  await expect(age).not.toHaveClass(/stale/);

  await showToolbar(page);
  const refresh = page.locator('#btn-refresh-alerts');
  await refresh.click();
  await expect(page.locator('#warnings')).toContainText('could not refresh SOTA alerts (alerts request failed: not a JSON response); still showing the alerts loaded at');
  await expect(stats).toHaveText('2 alerts · 2 summits on map · 0 yours');
  await expect(age).toHaveClass(/stale/);
  await expect(age).toHaveText(/^⚠ alerts as of .+ \(refresh failed\)$/);
  await expect(refresh).toBeEnabled();

  // the next refresh succeeds: fresh again, the warning gone
  await refresh.click();
  await expect(age).not.toHaveClass(/stale/);
  await expect(age).toHaveText(AGE);
  await expect(page.locator('#warnings')).toBeEmpty();
  expect(calls).toBe(3);
});

test('summit search: an older search never replaces a newer result or reopens a cleared panel', async ({ page }) => {
  await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
  const held = {};
  await stubSota(page, {
    '/api/alerts': route => route.fulfill({ json: [] }),
    '/api/summits/search/test': route => route.fulfill({ json: searchHit('ZZ/TE-002', 'Test Two') }),
    '/api/summits/search/slow': route => { held.slow = route; },
    '/api/summits/search/slower': route => { held.slower = route; },
    '/api/summits/search/slowest': route => { held.slowest = route; },
  });
  await page.goto('tools/sota-alerts/');
  await expect(page.locator('#stats')).toHaveText('0 alerts · 0 summits on map · 0 yours');
  await showToolbar(page);
  const input = page.locator('#summit-search');
  const panel = page.locator('#search-panel');
  const fresh = panel.locator('.search-result', { hasText: 'ZZ/TE-002' });
  const stale = panel.locator('.search-result', { hasText: 'ZZ/TE-009' });

  // the newer search is answered first, the older one afterwards
  await input.fill('slow');
  await expect.poll(() => !!held.slow).toBe(true);
  await input.fill('test');
  await expect(fresh).toBeVisible();
  await release(held.slow, searchHit('ZZ/TE-009', 'Stale'));

  // an older search still running when a cached term is shown again
  await input.fill('slower');
  await expect.poll(() => !!held.slower).toBe(true);
  await input.fill('test'); // from the session cache, no request
  await expect(fresh).toBeVisible();
  await release(held.slower, searchHit('ZZ/TE-009', 'Stale'));

  // the box cut below 3 characters while a search runs
  await input.fill('slowest');
  await expect.poll(() => !!held.slowest).toBe(true);
  await input.fill('sl');
  await expect(panel).toBeHidden();
  await release(held.slowest, searchHit('ZZ/TE-009', 'Stale'));

  await page.waitForTimeout(500); // time for a late response to (wrongly) show up
  await expect(panel).toBeHidden();
  await input.fill('test');
  await expect(fresh).toBeVisible();
  await expect(stale).toHaveCount(0);
});

test('a shared link: malformed and repeated pins skipped, live lookups capped', async ({ page }) => {
  await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
  const live = [];
  await page.route('https://api2.sota.org.uk/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/alerts') return route.fulfill({ json: [] });
    const m = path.match(/^\/api\/summits\/ZZ\/(TE-\d{3})$/);
    if (m) {
      live.push(m[1]);
      return route.fulfill({ json: { ...summitJson, name: `Peak ${m[1]}` } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  // 12 summits in no lookup, a repeat (other case) and two malformed ones
  const pins = Array.from({ length: 12 }, (_, i) => `ZZ/TE-1${String(i).padStart(2, '0')}`);
  await page.goto(`tools/sota-alerts/?pins=${[...pins, 'zz/te-100', '../../etc', 'nope'].join(',')}`);
  const warnings = page.locator('#warnings');
  await expect(warnings).toContainText('3 pins from the shared link were skipped');
  await expect(warnings).toContainText('2 summits from the shared link were skipped: not in the built-in summit list, and a shared link looks up at most 10 summits');
  await expect(page.locator('#candidates-items .list-item')).toHaveCount(10);
  expect(live).toHaveLength(10);
});

test('a shared link: the reference comes first, the live-lookup cap never cuts it', async ({ page }) => {
  await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
  const live = [];
  await page.route('https://api2.sota.org.uk/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/alerts') return route.fulfill({ json: [] });
    const m = path.match(/^\/api\/summits\/ZZ\/(TE-\d{3})$/);
    if (m) {
      live.push(m[1]);
      return route.fulfill({ json: { ...summitJson, name: `Peak ${m[1]}` } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  // 12 summits in no lookup, the reference written last
  const pins = Array.from({ length: 12 }, (_, i) => `ZZ/TE-1${String(i).padStart(2, '0')}`);
  await page.goto(`tools/sota-alerts/?pins=${pins.join(',')}&ref=ZZ/TE-200`);
  await expect(page.locator('#ref-indicator')).toContainText('reference: Peak TE-200 (ZZ/TE-200)');
  await expect(page.locator('#warnings')).toContainText('3 summits from the shared link were skipped');
  expect(live).toHaveLength(10);
  expect(live[0]).toBe('TE-200');
});

test('the built-in summit list fails: live lookups capped, a warning, retried on refresh', async ({ page }) => {
  await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
  let lookupLoads = 0;
  await page.route('**/data/summit-lookup.json', route => (++lookupLoads === 1
    ? route.fulfill({ contentType: 'application/json', body: '{"truncated' }) // broken the first time
    : route.continue()));
  const at = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 19);
  // 25 alerted summits that are in no lookup
  const alerts = Array.from({ length: 25 }, (_, i) => ({
    id: i, dateActivated: at, associationCode: 'ZZ', summitCode: `TE-3${String(i).padStart(2, '0')}`, summitDetails: 'x',
    frequency: '7.032-cw', comments: '', activatingCallsign: 'OE3XYZ', activatorName: '', posterCallsign: 'OE3XYZ',
  }));
  const live = [];
  await stubSota(page, { '/api/alerts': route => route.fulfill({ json: alerts }) });
  await page.route(/^https:\/\/api2\.sota\.org\.uk\/api\/summits\/ZZ\/TE-3\d\d$/, route => {
    live.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: summitJson });
  });
  await page.goto('tools/sota-alerts/');
  const warnings = page.locator('#warnings');
  await expect(warnings).toContainText('the built-in summit list could not be loaded');
  await expect(warnings).toContainText('at most 20 per visit');
  await expect(page.locator('#stats')).toHaveText('25 alerts · 20 summits on map · 0 yours');
  expect(live).toHaveLength(20);

  await showToolbar(page);
  await page.locator('#btn-refresh-alerts').click();
  await expect(page.locator('#stats')).toHaveText('25 alerts · 25 summits on map · 0 yours');
  await expect(warnings).not.toContainText('built-in summit list');
  expect(lookupLoads).toBe(2);
  expect(live).toHaveLength(25); // the first 20 come from the local cache now
});

test('malformed alert responses are failed refreshes; the next valid one recovers', async ({ page }) => {
  await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
  const answers = [
    route => route.fulfill({ json: alertsIn(3) }),
    route => route.fulfill({ json: [null] }),
    route => route.fulfill({ json: {} }),
    route => route.fulfill({ contentType: 'text/html', body: '<html>busy</html>' }),
    route => route.fulfill({ json: [...alertsIn(3), null, { id: 9 }] }), // two malformed items among valid ones
  ];
  let calls = 0;
  await stubSota(page, {
    '/api/alerts': route => answers[calls++](route),
    '/api/summits/ZZ/TE-001': route => route.fulfill({ json: summitJson }),
  });
  await page.goto('tools/sota-alerts/');
  const stats = page.locator('#stats');
  const age = page.locator('#alerts-age');
  const warnings = page.locator('#warnings');
  await expect(stats).toHaveText('2 alerts · 2 summits on map · 0 yours');
  await showToolbar(page);
  const refresh = page.locator('#btn-refresh-alerts');

  for (const reason of ['unexpected response (no valid alerts)', 'unexpected response (not a list of alerts)', 'alerts request failed: not a JSON response']) {
    const before = calls;
    await refresh.click();
    await expect.poll(() => calls).toBe(before + 1);
    await expect(warnings).toContainText(`could not refresh SOTA alerts (${reason}); still showing the alerts loaded at`);
    await expect(stats).toHaveText('2 alerts · 2 summits on map · 0 yours');
    await expect(age).toHaveClass(/stale/);
    await expect(refresh).toBeEnabled();
  }

  await refresh.click();
  await expect(age).not.toHaveClass(/stale/);
  await expect(age).toHaveText(AGE);
  await expect(stats).toHaveText('2 alerts · 2 summits on map · 0 yours');
  await expect(warnings).toHaveText("⚠ 2 alerts in SOTA's feed were malformed and skipped.");
});
