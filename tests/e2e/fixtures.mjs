// Shared test fixture for the tool smoke tests: every test fails on
//   - an uncaught exception in the page (`pageerror`),
//   - a console error (allowlist below, empty unless a message is
//     unavoidable and harmless; give every entry a reason), including a
//     Content-Security-Policy violation,
//   - a same-origin response >= 400 (broken asset paths, missing files),
//   - a request to another host that the test didn't stub. The tools must
//     work offline (confirm, adif); sota-alerts stubs its live APIs with
//     page.route(), which takes precedence over the catch-all here.
import { readFile } from 'node:fs/promises';
import { test as base, expect } from '@playwright/test';

const CONSOLE_ERROR_ALLOWLIST = [];

export const test = base.extend({
  // Further origins that belong to the bundle under test (the prefix proxy
  // of pwa-identity.spec.mjs); checked like the base URL's origin.
  extraOrigins: [[], { option: true }],
  problems: [async ({ page, baseURL, extraOrigins }, use) => {
    const origin = new URL(baseURL).origin;
    const ours = new Set([origin, ...extraOrigins]);
    const problems = [];
    // Content-Security-Policy violations (deploy/nginx.conf.example) as
    // console errors in every engine, whatever the browser logs itself.
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', e => {
        console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile || e.documentURI}:${e.lineNumber}`);
      });
    });
    page.on('pageerror', err => problems.push(`pageerror: ${err.stack || err.message}`));
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (CONSOLE_ERROR_ALLOWLIST.some(re => re.test(text))) return;
      const loc = msg.location();
      problems.push(`console.error: ${text}${loc && loc.url ? ` (${loc.url}:${loc.lineNumber})` : ''}`);
    });
    page.on('response', res => {
      if (res.status() >= 400 && ours.has(new URL(res.url()).origin)) {
        problems.push(`HTTP ${res.status()} ${res.url()}`);
      }
    });
    await page.route('**/*', route => {
      const url = route.request().url();
      // file://: the saved single-file bundles (offline.spec.mjs checks
      // their requests itself)
      if (ours.has(new URL(url).origin) || url.startsWith('file:')) return route.continue();
      problems.push(`unexpected request to another host: ${url}`);
      return route.abort('blockedbyclient');
    });
    await use(problems);
    expect(problems, 'page errors, console errors, failed or external requests').toEqual([]);
  }, { auto: true }],
});

export { expect };

// Text content of a download (UTF-8).
export async function downloadText(download) {
  return readFile(await download.path(), 'utf8');
}
