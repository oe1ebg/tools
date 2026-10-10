// Browser-resolved PWA identity (issue #28): Confirm and Notfunk are two apps
// on one origin and must not share an app identity. The manifest's `id` is
// resolved against the ORIGIN of start_url, so `"id": "./"` made both apps
// `https://host/`; without `id` the identity is the resolved start_url, which
// follows the tool's directory under any URL prefix.
//
// Chromium only (CDP): Page.getAppManifest returns the parsed manifest incl.
// the resolved id, startUrl and scope; Page.getInstallabilityErrors what
// blocks an install. A deployment under a prefix is simulated by a small
// reverse prefixProxy in the test (<prefixProxy>/a/b/... -> <BASE_URL>...), so the
// browser really loads the bundle, service worker included, from a deeper
// path, whatever server runs it (nginx in CI, serve.py locally).
import http from 'node:http';
import { test as base, expect } from './fixtures.mjs';

const TOOLS = { confirm: 'Bestätigungsverkehr', notfunk: 'Notfunk-Meldebuch' };
const PREFIXES = ['', 'a/b/', 'deep/er/prefix/'];

// `extraOrigins` (fixtures.mjs): the proxy is a second origin of the bundle
// under test; without it the fixture would block its requests as foreign.
const test = base.extend({
  prefixProxy: async ({ baseURL }, use) => {
    const upstream = new URL(baseURL);
    const hopByHop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);
    const server = http.createServer(async (req, res) => {
      const prefix = PREFIXES.find(p => p && req.url.startsWith(`/${p}`));
      if (!prefix) { res.writeHead(404).end('outside the prefixes'); return; }
      try {
        // Forward the conditional/range headers; no Accept-Encoding, so the
        // body is passed on uncompressed.
        const headers = {};
        for (const h of ['if-none-match', 'if-modified-since', 'range', 'accept']) if (req.headers[h]) headers[h] = req.headers[h];
        const r = await fetch(new URL(req.url.slice(prefix.length), upstream), { method: req.method, headers, redirect: 'manual' });
        const out = Object.fromEntries([...r.headers].filter(([k]) => !hopByHop.has(k)));
        // A redirect that would leave the prefix breaks the simulation: fail loudly.
        if (out.location && /^(https?:)?\//.test(out.location)) {
          res.writeHead(502).end(`redirect escapes the prefix: ${out.location}`);
          return;
        }
        res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
      } catch (err) {
        res.writeHead(502).end(String(err));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${server.address().port}/`);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  },
  extraOrigins: async ({ prefixProxy }, use) => use([new URL(prefixProxy).origin]),
});

test.skip(({ browserName }) => browserName !== 'chromium', 'needs the Chrome DevTools Protocol');

async function resolvedManifest(page) {
  const cdp = await page.context().newCDPSession(page);
  const { url, errors, manifest } = await cdp.send('Page.getAppManifest');
  // The service worker registers asynchronously: wait for it to control the
  // page (reload once if it only just took over), then read the errors,
  // polled so that transient ones (no matching service worker) settle.
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!await page.evaluate(() => !!navigator.serviceWorker.controller)) await page.reload();
  let installabilityErrors;
  await expect.poll(async () => {
    installabilityErrors = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors;
    return installabilityErrors;
  }, { message: 'installability errors', timeout: 10_000 }).toEqual([]);
  await cdp.detach();
  // `manifest` holds the resolved values (absolute id, startUrl, scope);
  // the response's `data` is only the raw text.
  return { url, errors, manifest, installabilityErrors };
}

for (const prefix of PREFIXES) {
  test(`under the prefix "/${prefix}" the apps resolve to distinct identities equal to their start URLs`, async ({ page, baseURL, prefixProxy }) => {
    const root = prefix ? new URL(prefix, prefixProxy).href : baseURL;
    const ids = {};
    for (const [tool, title] of Object.entries(TOOLS)) {
      const dir = `${root}tools/${tool}/`;
      await page.goto(dir);
      await expect(page).toHaveTitle(title);
      const m = await resolvedManifest(page);
      expect(m.url, `${tool} manifest URL`).toBe(`${dir}manifest.webmanifest`);
      expect(m.errors, `${tool} manifest errors`).toEqual([]);
      expect(m.installabilityErrors, `${tool} installability errors`).toEqual([]);
      expect(m.manifest.startUrl, `${tool} start_url`).toBe(dir);
      expect(m.manifest.scope, `${tool} scope`).toBe(dir);
      expect(m.manifest.id, `${tool} id`).toBe(dir);
      ids[tool] = m.manifest.id;
    }
    expect(ids.confirm).not.toBe(ids.notfunk);
  });
}
