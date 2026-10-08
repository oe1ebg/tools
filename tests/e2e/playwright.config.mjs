// Browser smoke tests for the oe1ebg tools (issue #57), run against a built
// site: in CI the production image (docker-publish-oe1ebg.yml, job
// `validate`, BASE_URL=http://localhost:8080), locally `just e2e`, which
// serves site/ from `just build`.
//
// @playwright/test is not a committed dependency: CI and `just e2e` install
// the version of the pinned Playwright image (tests/e2e/images.Dockerfile)
// into tests/e2e/node_modules/ (git-ignored).
import { defineConfig, devices } from '@playwright/test';

const ci = !!process.env.CI;
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8000/';
const report = ['html', { outputFolder: 'report', open: 'never' }];

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  outputDir: 'test-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: ci,
  // One retry in CI, so a flake shows up as "flaky" in the report instead
  // of blocking the image; a real failure fails twice.
  retries: ci ? 1 : 0,
  workers: ci ? 2 : undefined,
  // CI: annotations on the PR, the HTML report as an artifact on failure,
  // test-results.json for the per-browser table in the job summary, and
  // JUnit XML (tests/reports/, with the browser project in each test name)
  // for the test report check and the uploaded results.
  reporter: ci
    ? [['list'], ['github'], report, ['json', { outputFile: 'test-results.json' }],
      ['junit', { outputFile: '../reports/e2e.xml', includeProjectInTestName: true }]]
    : [['list'], report],
  use: {
    baseURL,
    locale: 'de-AT',
    timezoneId: 'Europe/Vienna',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Desktop engines plus two phone viewports (touch, isMobile).
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
  // Without BASE_URL: serve the built site/ (`just build`) like `just preview`.
  webServer: process.env.BASE_URL ? undefined : {
    command: 'python3 serve.py ../../site 8000',
    url: baseURL,
    reuseExistingServer: true,
  },
});
