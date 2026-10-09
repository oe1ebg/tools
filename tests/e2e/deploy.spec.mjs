// The caching rule of deploy/nginx.conf.example (CI serves the bundle with
// it; serve.py mirrors it for `just e2e`): pages, scripts, styles, data and
// the web manifests are revalidated, so a browser never mixes files of two
// releases. File names are not hashed (README, "Deployment").
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
