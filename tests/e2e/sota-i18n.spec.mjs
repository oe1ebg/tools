// The SOTA Alerts Map in German and English (#108 C3): it starts in the
// browser's language, the header switch changes the page, the map's layer
// names and the lists (and is remembered); the saved base layer keeps its
// stored (English) name. API and tiles stubbed, as in sota-alerts.spec.
import { test, expect } from './fixtures.mjs';

const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const TILE_HOSTS = /^https:\/\/([a-c]\.tile\.opentopomap\.org|tile\.openstreetmap\.org|mapsneu\.wien\.gv\.at)\//;
const at = h => new Date(Date.now() + h * 3600_000).toISOString().slice(0, 19);
const ALERTS = [{ id: 1, dateActivated: at(3), associationCode: 'OE', summitCode: 'WI-001', summitDetails: 'Hermannskogel',
  frequency: '145.500-fm', comments: 'e2e', activatingCallsign: 'OE1ABC/P', activatorName: 'Test', posterCallsign: 'OE1ABC' }];

async function stub(page) {
  await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
  await page.route('https://api2.sota.org.uk/**', route => {
    const path = new URL(route.request().url()).pathname;
    return path === '/api/alerts' ? route.fulfill({ json: ALERTS }) : route.fulfill({ status: 404, json: {} });
  });
}

test('German for a German browser; the switch changes texts, layer names and lists, and is remembered', async ({ page }) => {
  await stub(page);
  await page.goto('tools/sota-alerts/'); // locale de-AT
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('#stats')).toHaveText('1 Alerts · 1 Gipfel auf der Karte · 0 eigene');
  await expect(page.locator('#btn-refresh-alerts')).toHaveText('Alerts aktualisieren');
  await expect(page.locator('#alerts-age')).toContainText('Alerts von');
  await expect(page.locator('.leaflet-control-layers-list')).toContainText('Gelände (OpenTopoMap)');
  await expect(page.locator('.leaflet-control-attribution')).toContainText('Kartendaten');

  // a base layer chosen in German is saved under its stored name
  await page.locator('.leaflet-control-layers').hover();
  await page.getByLabel('Straßen (OpenStreetMap)').check();
  expect(await page.evaluate(() => Object.values(localStorage).includes('Streets (OpenStreetMap)'))).toBe(true);

  await page.locator('#lang-toggle button[data-lang="en"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#stats')).toHaveText('1 alerts · 1 summits on map · 0 yours');
  await expect(page.locator('#btn-refresh-alerts')).toHaveText('refresh alerts');
  await expect(page.locator('.leaflet-control-layers-list')).toContainText('Streets (OpenStreetMap)');
  await expect(page.locator('.leaflet-control-attribution')).not.toContainText('Kartendaten');
  // the chosen layer is still the one shown
  await expect(page.getByLabel('Streets (OpenStreetMap)')).toBeChecked();

  await page.reload();
  await expect(page.locator('#btn-refresh-alerts')).toHaveText('refresh alerts');
  await expect(page.getByLabel('Streets (OpenStreetMap)')).toBeChecked();
});

test('the popup and the help in German', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile'), 'hover popup: desktop');
  await stub(page);
  await page.goto('tools/sota-alerts/');
  await expect(page.locator('#stats')).toContainText('1 Gipfel auf der Karte');
  await page.locator('.leaflet-marker-icon').first().click();
  await expect(page.locator('.sota-popup')).toContainText('als Bezug setzen');
  await expect(page.locator('.sota-popup')).toContainText('diesen Gipfel anheften');
  await page.locator('#btn-help').click();
  await expect(page.locator('#help-dlg .help-content[lang="de"]')).toBeVisible();
  await expect(page.locator('#help-dlg .help-content[lang="en"]')).toBeHidden();
});
