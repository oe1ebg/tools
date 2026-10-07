// Screenshots for the manuals (content/tools/confirm-anleitung.md,
// notfunk-anleitung.md), not a test: `just oe1ebg screenshots` after
// `just oe1ebg build`. Same server and browser setup as the smoke tests
// (playwright.config.mjs); light theme, Vienna time, a fixed clock and
// example data, so the pictures only change when the tools do.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8000/';

export default defineConfig({
  testDir: '.',
  testMatch: '*.shots.mjs',
  outputDir: 'test-results-shots',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    locale: 'de-AT',
    timezoneId: 'Europe/Vienna',
    colorScheme: 'light',
    viewport: { width: 1200, height: 860 },
    deviceScaleFactor: 1,
  },
  webServer: process.env.BASE_URL ? undefined : {
    command: 'python3 serve.py ../../site 8000',
    url: baseURL,
    reuseExistingServer: true,
  },
});
