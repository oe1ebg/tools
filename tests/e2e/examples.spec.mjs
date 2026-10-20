// The fictional example backups (examples/backups/, README there) through
// the real browser path: the import dialog, IndexedDB, the messages, the
// lists. Each file is imported into a fresh profile, checked against what
// the README promises, exported again and restored into another fresh
// profile with the same result. tests/demo-backups.test.mjs checks the same
// files in Node; this is the user's way. Netlog also backs up one series
// and restores it alone.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.mjs';

// the sessions screen: the back link in a session, nothing to click when it is open already
const toSessions = async page => { const b = page.locator('#btn-sessions'); if (await b.isVisible() && /\/series$/.test(await b.getAttribute('href'))) await b.click(); };

const EXAMPLES = fileURLToPath(new URL('../../examples/backups/', import.meta.url));
const file = name => `${EXAMPLES}${name}`;

async function ready(page, tool, flag) {
  await page.goto(`tools/${tool}/`);
  await expect.poll(() => page.evaluate(f => globalThis[f] === true, flag)).toBe(true);
}

// A second, empty browser profile (no service worker, nothing stored).
async function freshPage(browser, baseURL, locale = 'de-AT') {
  const ctx = await browser.newContext({ baseURL, locale, timezoneId: 'Europe/Vienna' });
  return { ctx, page: await ctx.newPage() };
}

async function saveDownload(page, click, testInfo) {
  const dl = page.waitForEvent('download');
  await click();
  const d = await dl;
  const p = testInfo.outputPath(d.suggestedFilename());
  await d.saveAs(p);
  return { path: p, name: d.suggestedFilename(), data: JSON.parse(await readFile(p, 'utf8')) };
}

const texts = async loc => (await loc.allTextContents()).map(s => s.replace(/\s+/g, ' ').trim());

test.describe('Netlog examples', () => {
  const STATS = {
    'DEMO · Lindenhain-Abendrunde': '4 sessions · 2026-06-03 – 2026-06-24 · ⌀ 7 stations · 12 different stations · 89 notes · 8 open',
    'DEMO · Unterwegs im Modellpark': '4 sessions · 2026-06-07 – 2026-06-28 · ⌀ 6.8 stations · 12 different stations · 86 notes · 8 open',
    'DEMO · Werkbank am Funk': '4 sessions · 2026-06-05 – 2026-06-26 · ⌀ 6.8 stations · 12 different stations · 86 notes · 8 open',
  };
  const card = (page, name) => page.locator('#series-list section.series-card', { has: page.locator('.card-toggle', { hasText: name }) });
  const counts = page => page.evaluate(async () => {
    const st = globalThis.NETLOG_APP.store;
    const out = {};
    for (const s of ['series', 'sessions', 'profiles', 'participants', 'rounds', 'contributions', 'notes', 'items', 'events']) out[s] = (await st.getAll(s)).length;
    return out;
  });
  const lang = async page => page.addInitScript(() => { try { localStorage.setItem('oe1ebg-netlog-lang', 'en'); } catch { /* blocked */ } });

  test('netlog-full.json: imports as 3 series, 12 sessions; a second import changes nothing; export and restore give the same', async ({ page, browser, baseURL }, testInfo) => {
    await lang(page);
    await ready(page, 'netlog', 'NETLOG_READY');
    await page.locator('#import-file').setInputFiles(file('netlog-full.json'));
    await expect(page.locator('#data-msg')).toContainText('Imported: 12 sessions (0 as copies');
    await expect(page.locator('#data-msg')).toContainText('3 series, 14 profiles');
    for (const [name, stats] of Object.entries(STATS)) await expect(card(page, name).locator('.series-stats')).toHaveText(stats);
    const before = await counts(page);
    expect(before).toMatchObject({ series: 3, sessions: 12, profiles: 14, notes: 261, rounds: 39 });
    // a session opens with its stations
    const lind = card(page, 'DEMO · Lindenhain-Abendrunde');
    await lind.locator('.card-toggle').click();
    await expect(lind.locator('li.session-row')).toHaveCount(4);
    await lind.locator('button.session-open').first().click();
    await expect(page.locator('#view-live')).toBeVisible();
    await expect(page.locator('#roster button.person')).toHaveCount(7);
    // again: nothing doubled
    await toSessions(page);
    await page.locator('#import-file').setInputFiles(file('netlog-full.json'));
    await expect(page.locator('#data-msg')).toContainText('12 already here');
    expect(await counts(page)).toEqual(before);
    // everything exported and restored into an empty profile: the same
    const all = await saveDownload(page, () => page.locator('#btn-export-all').click(), testInfo);
    expect(all.data.scope).toBe('all');
    // one series backed up, restored alone into another empty profile
    const series = await saveDownload(page, () => lind.getByRole('button', { name: /Back up series DEMO · Lindenhain-Abendrunde/ }).click(), testInfo);
    expect(series.data.scope).toBe('series');
    expect(series.data.stores.sessions).toHaveLength(4);
    for (const [path, expectCounts, cards] of [[all.path, before, Object.keys(STATS)], [series.path, null, ['DEMO · Lindenhain-Abendrunde']]]) {
      const { ctx, page: b } = await freshPage(browser, baseURL, 'en');
      try {
        await lang(b);
        await ready(b, 'netlog', 'NETLOG_READY');
        await b.locator('#import-file').setInputFiles(path);
        await expect(b.locator('#data-msg')).toContainText('(0 as copies');
        if (expectCounts) expect(await counts(b)).toEqual(expectCounts);
        else expect(await counts(b)).toMatchObject({ series: 1, sessions: 4 });
        await expect(b.locator('#series-list .card-toggle')).toHaveCount(cards.length + 1); // + sessions without a series
        for (const name of cards) await expect(card(b, name).locator('.series-stats')).toHaveText(STATS[name]);
      } finally {
        await ctx.close();
      }
    }
  });

  test('netlog-example.json: one session with three rounds', async ({ page }) => {
    await lang(page);
    await ready(page, 'netlog', 'NETLOG_READY');
    await page.locator('#import-file').setInputFiles(file('netlog-example.json'));
    await expect(page.locator('#data-msg')).toContainText('Imported: 1 sessions (0 as copies');
    expect((await counts(page)).sessions).toBe(1);
    await page.locator('#series-list .card-toggle').first().click();
    await page.locator('#series-list button.session-open').first().click();
    await expect(page.locator('#view-live')).toBeVisible();
    expect(await page.evaluate(() => globalThis.NETLOG_APP.sd.rounds.filter(r => !r.deleted).length)).toBe(3);
  });
});

test.describe('Confirm examples', () => {
  // the oldest log: 13 check-ins and 2 operator comments (rows of the log)
  for (const [name, logs] of [['confirm-full.json', 4], ['confirm-example.json', 1]]) {
    test(`${name}: imports ${logs} logs; "Alles sichern" restores the same into an empty profile`, async ({ page, browser, baseURL }, testInfo) => {
      await ready(page, 'confirm', 'CONFIRM_READY');
      await page.locator('#import-file').setInputFiles(file(name));
      await expect(page.locator('#import-msg')).toContainText(`${logs} Log${logs === 1 ? '' : 's'} importiert`);
      await expect(page.locator('#import-msg')).not.toContainText('Kopie');
      const list = page.locator('#event-list > *');
      await expect(list).toHaveCount(logs);
      const before = await texts(list);
      await expect(page.locator('#event-list > *', { hasText: 'DEMO · Rundspruch-Bestätigungen 1' })).toContainText('12 Stationen / 13 Check-ins');
      await page.getByText('DEMO · Rundspruch-Bestätigungen 1').first().click();
      await expect(page.locator('#log-body tr[data-id]')).toHaveCount(15);
      await page.locator('#btn-back').click();
      await expect(page.locator('#btn-backup-all')).toBeVisible();
      const backup = await saveDownload(page, () => page.locator('#btn-backup-all').click(), testInfo);
      expect(backup.name).toMatch(/\.json$/);
      const { ctx, page: b } = await freshPage(browser, baseURL);
      try {
        await ready(b, 'confirm', 'CONFIRM_READY');
        await b.locator('#import-file').setInputFiles(backup.path);
        await expect(b.locator('#import-msg')).toContainText(`${logs} Log${logs === 1 ? '' : 's'} importiert`);
        await expect(b.locator('#event-list > *')).toHaveCount(logs);
        expect(await texts(b.locator('#event-list > *'))).toEqual(before);
      } finally {
        await ctx.close();
      }
    });
  }
});

test.describe('Notfunk examples', () => {
  for (const [name, op, msgs, next] of [
    ['notfunk-full.json', 'DEMO / ÜBUNG · Modellpark Lindenhain', 30, 'D1-031'],
    ['notfunk-example.json', 'DEMO / ÜBUNG · Modellpark Lindenhain · Kurzbeispiel', 6, 'D1-007'],
  ]) {
    test(`${name}: ${msgs} messages, next number ${next}; its backup restores the same into an empty profile`, async ({ page, browser, baseURL }, testInfo) => {
      await ready(page, 'notfunk', 'NOTFUNK_READY');
      await page.locator('#import-file').setInputFiles(file(name));
      await expect(page.locator('#import-msg')).toContainText(`„${op}“: ${msgs} Meldungen neu, 0 aktualisiert`);
      const openOp = async p => {
        await p.getByRole('button', { name: `„${op}“ öffnen` }).click();
        await expect(p.locator('#book-body tr[data-id]')).toHaveCount(msgs);
      };
      await openOp(page);
      await expect(page.locator('#form-number')).toHaveText(`→ ${next}`);
      const rows = await texts(page.locator('#book-body tr[data-id]'));
      const backup = await saveDownload(page, () => page.locator('#btn-backup').click(), testInfo);
      const { ctx, page: b } = await freshPage(browser, baseURL);
      try {
        await ready(b, 'notfunk', 'NOTFUNK_READY');
        await b.locator('#import-file').setInputFiles(backup.path);
        await expect(b.locator('#import-msg')).toContainText(`„${op}“: ${msgs} Meldungen neu, 0 aktualisiert`);
        await openOp(b);
        await expect(b.locator('#form-number')).toHaveText(`→ ${next}`);
        expect(await texts(b.locator('#book-body tr[data-id]'))).toEqual(rows);
      } finally {
        await ctx.close();
      }
    });
  }
});
