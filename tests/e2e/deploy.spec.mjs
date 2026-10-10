// The response headers of deploy/nginx.conf.example (CI serves the bundle
// with it; serve.py reads them from it for `just e2e`). Caching: pages,
// scripts, styles, data and the web manifests are revalidated, so a browser
// never mixes files of two releases. File names are not hashed (README,
// "Using a release").
import { test, expect } from './fixtures.mjs';

const NO_CACHE = [
  'tools/',
  'tools/confirm/',
  'tools/confirm/sw.js',
  'tools/confirm/precache.js',
  'tools/confirm/manifest.webmanifest',
  'tools/notfunk/',
  'tools/shared/js/sw-core.js',
  'tools/shared/css/tools.css',
  'tools/adif/',
  'tools/adif/style.css',
  'tools/sota-alerts/',
  'tools/confirm-anleitung/',
];

test('pages, scripts, styles and manifests are served with no-cache', async ({ request }) => {
  for (const path of NO_CACHE) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['cache-control'], path).toBe('no-cache');
  }
  expect((await request.get('tools/confirm/manifest.webmanifest')).headers()['content-type'])
    .toMatch(/^application\/manifest\+json/);
});

// The security headers of deploy/nginx.conf.example (serve.py reads them
// from there): on every response, error responses included, with the
// Content-Security-Policy of the location. tests/deploy-headers.test.mjs
// checks the policies against the pages' sources; here the browser has to
// run the pages under them (the fixture fails on any CSP violation).
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

test('security headers on pages, assets and errors', async ({ request }) => {
  const csp = {};
  for (const path of ['tools/', 'tools/confirm/', 'tools/confirm/js/app.js', 'tools/sota-alerts/',
    'tools/confirm/confirm-offline.html', 'tools/adif/adif-editor.html', 'tools/confirm-anleitung/',
    'tools/no-such-file.html']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(path.includes('no-such') ? 404 : 200);
    for (const [name, value] of Object.entries(SECURITY)) expect(res.headers()[name], `${path}: ${name}`).toBe(value);
    csp[path] = res.headers()['content-security-policy'];
    // framing: only adif-editor.html, by its own origin (tools/adif/README.md,
    // "Zensical integration")
    const embeddable = path.endsWith('adif-editor.html');
    expect(csp[path], path).toContain(embeddable ? "frame-ancestors 'self'" : "frame-ancestors 'none'");
    expect(res.headers()['x-frame-options'], path).toBe(embeddable ? 'SAMEORIGIN' : 'DENY');
  }
  expect(csp['tools/confirm/']).toMatch(/script-src 'self' 'sha256-/);
  expect(csp['tools/confirm/']).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(csp['tools/no-such-file.html']).toBe(csp['tools/']);
  expect(csp['tools/sota-alerts/']).toContain('https://api2.sota.org.uk');
  expect(csp['tools/confirm/confirm-offline.html']).toContain("script-src 'self' 'unsafe-inline'");
  expect(csp['tools/adif/adif-editor.html']).toContain("script-src 'self' 'unsafe-inline'");
});

// The documented embedding: a page of the same site shows adif-editor.html
// in an <iframe>. The embedding page is stubbed (same origin, no headers).
test('adif-editor.html can be embedded by a page of the same origin', { tag: '@adif' }, async ({ page }) => {
  await page.route('**/tools/embed-test.html', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>embed</title><iframe src="adif/adif-editor.html" title="ADIF Editor"></iframe>',
  }));
  await page.goto('tools/embed-test.html');
  await expect(page.frameLocator('iframe').locator('#btn-open')).toBeVisible();
});

// The inline load-failure script of confirm/ and notfunk/ runs (its hash is
// in the policy), and the pages start without a violation.
for (const [tool, fn, started] of [
  ['confirm', 'confirmLoadFailed', 'CONFIRM_STARTED'],
  ['notfunk', 'notfunkLoadFailed', 'NOTFUNK_STARTED'],
]) {
  test(`${tool}: inline boot script allowed by the policy`, async ({ page }) => {
    await page.goto(`tools/${tool}/`);
    await expect.poll(() => page.evaluate(s => globalThis[s] === true, started)).toBe(true);
    expect(await page.evaluate(f => typeof globalThis[f], fn)).toBe('function');
  });
}

// The single-file bundles also work when opened from the server, under
// their own (inline) policy.
for (const [bundle, ready, tag] of [
  ['confirm/confirm-offline.html', 'CONFIRM_READY', ''],
  ['notfunk/notfunk-offline.html', 'NOTFUNK_STARTED', ''],
  ['adif/adif-editor.html', '', '@adif'],
]) {
  test(`${bundle} runs from the server`, { tag: tag ? [tag] : [] }, async ({ page }) => {
    await page.goto(`tools/${bundle}`);
    if (ready) await expect.poll(() => page.evaluate(s => globalThis[s] === true, ready)).toBe(true);
    else await expect(page.locator('#btn-open')).toBeVisible();
  });
}
