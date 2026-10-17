// The ADIF editor in German and English (#108 C3): it starts in the
// browser's language, the switch in the header changes every text the
// page builds (and is remembered), the checks speak the chosen language.
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.mjs';

const SAMPLE = fileURLToPath(new URL('fixtures/sample.adi', import.meta.url));
const OFFICIAL = fileURLToPath(new URL('../fixtures/adif-spec/test-qsos.adi', import.meta.url));

test('German for a German browser; the switch changes the texts and is remembered', async ({ page }) => {
  await page.goto('tools/adif/'); // the projects run with locale de-AT
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('#btn-open')).toHaveText('Datei(en) hinzufügen…');
  await expect(page.locator('#lang-toggle button[data-lang="de"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#btn-help')).toHaveAccessibleName(/^Hilfe/);

  await page.locator('#file-input').setInputFiles(SAMPLE);
  await expect(page.locator('#stats')).toContainText('3 QSOs');
  await expect(page.locator('#stats')).toContainText('Ganzes Log');
  await expect(page.locator('#validation-summary')).toContainText('ADIF gültig');
  await expect(page.locator('#col-order button[data-col-order="core"]')).toHaveText('Kernfelder zuerst');

  await page.locator('#lang-toggle button[data-lang="en"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#btn-open')).toHaveText('add file(s)…');
  await expect(page.locator('#stats')).toContainText('Whole log');
  await expect(page.locator('#validation-summary')).toContainText('ADIF valid');
  await expect(page.locator('#col-order button[data-col-order="core"]')).toHaveText('core fields first');
  // the log stayed
  await expect(page.locator('#drop tbody')).toContainText('OE1ABC');

  await page.reload();
  await expect(page.locator('#btn-open')).toHaveText('add file(s)…');
});

test('the checks speak German: issue list, severities and messages', async ({ page }) => {
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(OFFICIAL);
  await expect(page.locator('#stats')).toContainText('6.202 QSOs', { timeout: 30_000 });
  // an edit with a bad value: the re-check reports it in German
  const cell = page.locator('td[data-col="QSO_DATE"]').first();
  await cell.click();
  await cell.fill('2026-13-01');
  await cell.press('Enter');
  await expect(page.locator('#validation-summary')).toContainText('Ungültiges ADIF', { timeout: 30_000 });
  await expect(page.locator('#validation-summary')).toContainText('aktuelles Log');
  await page.locator('#btn-issues').click();
  await expect(page.locator('#validation-issues')).toContainText('hat keinen gültigen Monat');
  await expect(page.locator('#validation-issues [role="img"]').first()).toHaveAttribute('aria-label', /Fehler|Warnung|Hinweis/);
});

test('the help is German, its section links go to the German sections', async ({ page }) => {
  await page.goto('tools/adif/');
  await page.locator('#btn-help').click();
  const dlg = page.locator('#help-dlg');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.help-content[lang="de"]')).toBeVisible();
  await expect(dlg.locator('.help-content[lang="en"]')).toBeHidden();
  await dlg.getByRole('link', { name: 'Export' }).click();
  await expect(dlg.locator('#h-export-de')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
});
