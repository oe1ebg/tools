// Netlog series statistics (#83, part 2): the "Statistics" card of a series in "Sessions & series":
// leaderboard, attendance matrix, session rows, net control rotation, the unknown-times counts
// and the estimate label, the empty state, keyboard use, 320 px and axe-core. Synthetic
// callsigns (OE0TEST, DL0XYZ, OE0AAA) and a seeded series; no real people.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test, expect, offlineSettled } from './fixtures.mjs';

async function open(page, { lang = 'en' } = {}) {
  await page.addInitScript(l => { try { localStorage.setItem('oe1ebg-netlog-lang', l); } catch { /* blocked */ } }, lang);
  await page.goto('tools/netlog/');
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await offlineSettled(page);
}

// A series "Evening net" with four sessions (records as the stores hold them):
//   #1 2026-09-02 18:00-19:00, rounds 18:00 and 18:30: OE0TEST (net control), DL0XYZ 18:10-18:40, OE0AAA 18:05-19:00
//   #2 2026-09-09 18:00-19:15: OE0TEST 18:00-19:15, DL0XYZ 18:00-19:15, one participant with the call "?"
//   #3 2026-09-16 18:00-19:00: OE0TEST 18:00-19:00
//   #4 2026-09-23 joined late (no start, no end): OE0TEST, OE0AAA (times unknown)
// plus an empty series "Workshop net".
async function seed(page) {
  await page.evaluate(async () => {
    const app = globalThis.NETLOG_APP;
    const T = (d, hm) => ({ iso: `${d}T${hm}:00.000Z`, quality: 'exact' });
    const NONE = { iso: null, quality: 'unknown' };
    const base = c => c.replace(/\/.*$/, '');
    const recs = { series: [], sessions: [], participants: [], rounds: [], contributions: [], events: [] };
    const stamp = { created: '2026-09-01T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z', deleted: null };
    for (const [id, name] of [['ser-a', 'Evening net'], ['ser-b', 'Workshop net']]) {
      recs.series.push({ id, name, description: '', schedule: '', defaults: { repeater: '', freq: '', mode: '', ncs: '', style: 'star' }, numbering: 'sequential', ...stamp });
    }
    const plan = [
      { n: 1, date: '2026-09-02', start: '18:00', end: '19:00', rounds: ['18:00', '18:30'], ncs: 'OE0TEST', st: [['OE0TEST', '18:00', '19:00'], ['DL0XYZ', '18:10', '18:40'], ['OE0AAA', '18:05', '19:00']] },
      { n: 2, date: '2026-09-09', start: '18:00', end: '19:15', rounds: ['18:00'], ncs: 'OE0TEST', st: [['OE0TEST', '18:00', '19:15'], ['DL0XYZ', '18:00', '19:15'], ['?', '18:20', '18:30']] },
      { n: 3, date: '2026-09-16', start: '18:00', end: '19:00', rounds: ['18:00'], ncs: 'OE0TEST', st: [['OE0TEST', '18:00', '19:00']] },
      { n: 4, date: '2026-09-23', late: true, rounds: [null], ncs: null, st: [['OE0TEST', null, null], ['OE0AAA', null, null]] },
    ];
    for (const p of plan) {
      const sid = `s${p.n}`;
      const ids = p.st.map((_, i) => `${sid}p${i}`);
      recs.sessions.push({
        id: sid, seriesId: 'ser-a', number: p.n, name: '', date: p.date, own: { call: 'OE0TEST', base: 'OE0TEST' },
        radio: { repeater: '', freq: '', mode: '' }, suggestedNcs: '', style: 'star',
        start: p.late ? NONE : T(p.date, p.start), end: p.late ? NONE : T(p.date, p.end), joinedLate: !!p.late,
        currentRoundId: `${sid}r1`, ncsId: p.ncs ? ids[0] : null, ...stamp, created: `${p.date}T00:00:00.000Z`,
      });
      p.rounds.forEach((hm, i) => recs.rounds.push({ id: `${sid}r${i + 1}`, eventId: sid, number: i + 1, order: i + 1, topic: '', start: hm ? T(p.date, hm) : NONE, ...stamp }));
      p.st.forEach(([call, from, to], i) => {
        recs.participants.push({
          id: ids[i], eventId: sid, call, base: base(call), name: call === 'OE0TEST' ? 'Mira' : '', profileId: null, status: 'active', rosterOrder: i + 1,
          presence: from ? [{ from: T(p.date, from), to: to ? T(p.date, to) : null }] : [], ...stamp,
        });
        recs.events.push({ id: `${ids[i]}e`, eventId: sid, type: 'presence', kind: 'checkin', participantId: ids[i], roundId: `${sid}r1`, time: from ? T(p.date, from) : NONE, ...stamp });
      });
    }
    // two turns in session #1, round 1 (18:00-18:30): speaking is estimated up to the next turn / round start
    [['s1p0', '18:00'], ['s1p1', '18:10']].forEach(([pid, hm], i) => recs.contributions.push({ id: `s1c${i}`, eventId: 's1', participantId: pid, roundId: 's1r1', seq: i + 1, time: T('2026-09-02', hm), ...stamp }));
    await app.store.atomic(Object.keys(recs), async api => { for (const [s, list] of Object.entries(recs)) for (const r of list) api.put(s, r); });
    await app.reload();
  });
}

const card = (page, name) => page.locator('#series-list section.series-card', { has: page.locator('.card-toggle', { hasText: name }) });
const statsBtn = c => c.locator('button[data-act=stats]');

async function openStats(page, name = 'Evening net') {
  const c = card(page, name);
  await statsBtn(c).click();
  await expect(statsBtn(c)).toHaveAttribute('aria-expanded', 'true');
  return c.locator('.stats-panel');
}

test('statistics card: leaderboard order, unknown-times counts, estimate label, matrix and sessions', async ({ page }) => {
  await open(page);
  await seed(page);
  // lazy: nothing is read until the card is opened; the existing workflow of the card is unchanged
  const c = card(page, 'Evening net');
  await expect(statsBtn(c)).toHaveAttribute('aria-expanded', 'false');
  await expect(statsBtn(c)).toHaveAttribute('aria-controls', 'series-stats-ser-a');
  await expect(c.locator('.stats-panel')).toBeHidden();
  await expect(c.locator('.card-toggle')).toHaveAttribute('aria-expanded', 'false');

  const panel = await openStats(page);
  await expect(panel.locator('.st-status')).toHaveText('Statistics calculated.');
  await expect(panel.locator('.st-summary li')).toHaveText([
    '4 sessions counted', '3 different stations', '1 session without known times', '1 participant with an incomplete callsign not counted',
  ]);
  // the speaking time is labelled as an estimate, with the explanation
  await expect(panel.locator('.st-estimate')).toContainText('Speaking time is an estimate and an upper bound');
  const lb = panel.locator('table.st-table').first();
  await expect(lb.locator('thead th')).toContainText(['Rank', 'Station', 'Sessions', 'Time present (hh:mm)', 'Speaking time (estimated, hh:mm)', 'Times net control', 'Last seen']);
  const rows = lb.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  // OE0TEST 4/4; DL0XYZ and OE0AAA both 2/4, DL0XYZ has more time present
  await expect(rows.nth(0)).toContainText('1OE0TEST Mira4/4 (100 %)');
  await expect(rows.nth(0)).toContainText('≥ 03:15');
  await expect(rows.nth(0)).toContainText('(+1 without time)');
  await expect(rows.nth(0)).toContainText('≈ 00:10');
  await expect(rows.nth(1)).toContainText('≈ 00:20');
  await expect(rows.nth(0)).toContainText('2026-09-23');
  await expect(rows.nth(1)).toContainText('2DL0XYZ2/4 (50 %)');
  await expect(rows.nth(1)).toContainText('01:45');
  await expect(rows.nth(1)).toContainText('2026-09-09');
  await expect(rows.nth(2)).toContainText('3OE0AAA2/4 (50 %)');
  await expect(rows.nth(2)).toContainText('≥ 00:55');
  // the matrix: a text mark and the time in the cell, a text for absent
  const matrix = panel.locator('table.st-table').nth(1);
  await expect(matrix.locator('thead th')).toHaveCount(5);
  await expect(matrix.locator('thead th').nth(1)).toContainText('2026-09-02');
  await expect(matrix.locator('thead th').nth(1)).toContainText('#1');
  const test = matrix.locator('tbody tr').nth(0);
  await expect(test.locator('td').nth(0)).toContainText('✓ 01:00');
  await expect(test.locator('td').nth(0)).toContainText('NCS');
  await expect(test.locator('td').nth(3)).toHaveText('✓');
  const xyz = matrix.locator('tbody tr').nth(1);
  await expect(xyz.locator('td').nth(0)).toContainText('✓ 00:30');
  await expect(xyz.locator('td').nth(2)).toContainText('not present');
  // per-session rows: date, number, length with the zone, rounds with durations, stations, NCS
  const sess = panel.locator('table.st-table').nth(2);
  await expect(sess.locator('tbody tr')).toHaveCount(4);
  await expect(sess.locator('tbody tr').nth(0)).toContainText('2026-09-02');
  await expect(sess.locator('tbody tr').nth(0)).toContainText('#1');
  await expect(sess.locator('tbody tr').nth(0)).toContainText('18:00–19:00 UTC');
  await expect(sess.locator('tbody tr').nth(0)).toContainText('Round 1: 00:30');
  await expect(sess.locator('tbody tr').nth(0)).toContainText('Round 2: 00:30');
  await expect(sess.locator('tbody tr').nth(3)).toContainText('2026-09-23');
  await expect(sess.locator('tbody tr').nth(3).locator('td').nth(1)).toHaveText('–');
  // the NCS rotation
  const rot = panel.locator('table.st-table').nth(3);
  await expect(rot.locator('tbody tr').nth(0)).toContainText('OE0TEST');
  await expect(rot.locator('tbody tr').nth(0)).toContainText('18:00–19:00 UTC');
  // closing hides it again and keeps the card as it was
  await statsBtn(c).click();
  await expect(panel).toBeHidden();
  await expect(statsBtn(c)).toHaveAttribute('aria-expanded', 'false');
});

test('statistics card: German texts, essential values in the cell text', async ({ page }) => {
  await open(page, { lang: 'de' });
  await seed(page);
  const panel = await openStats(page);
  await expect(panel.locator('.st-summary li').first()).toHaveText('4 Sitzungen gezählt');
  await expect(panel.locator('.st-summary li').nth(2)).toHaveText('1 Sitzung ohne bekannte Zeiten');
  await expect(panel.locator('.st-estimate')).toContainText('Geschätzt: Die Sprechzeit ist eine Schätzung und eine obere Grenze');
  await expect(panel.locator('table.st-table').first().locator('thead th').nth(4)).toHaveText('Sprechzeit (geschätzt, hh:mm)');
  await expect(panel.locator('table.st-table').first().locator('tbody tr').nth(0)).toContainText('(+1 ohne Zeit)');
});

test('statistics card: empty state for a series without sessions', async ({ page }) => {
  await open(page);
  await seed(page);
  const panel = await openStats(page, 'Workshop net');
  await expect(panel.locator('.st-body')).toHaveText('This series has no sessions yet, so there are no statistics.');
  await expect(panel.locator('table')).toHaveCount(0);
});

test('statistics card: keyboard only, focus stays on the button, scrolling regions are focusable', async ({ page }) => {
  await open(page);
  await seed(page);
  const c = card(page, 'Evening net');
  await statsBtn(c).focus();
  await page.keyboard.press('Enter');
  await expect(statsBtn(c)).toHaveAttribute('aria-expanded', 'true');
  await expect(statsBtn(c)).toBeFocused();
  await expect(c.locator('.st-status')).toHaveText('Statistics calculated.');
  // Tab reaches the tables (named scroll regions) without a trap, in document order
  const regions = c.locator('.st-scroll');
  await expect(regions).toHaveCount(4);
  await regions.first().focus();
  await expect(regions.first()).toBeFocused();
  await expect(regions.first()).toHaveAttribute('aria-labelledby', /cap$/);
  await page.keyboard.press('Tab');
  await expect(regions.nth(1)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(regions.first()).toBeFocused();
  // Space closes it again from the button
  await statsBtn(c).focus();
  await page.keyboard.press('Space');
  await expect(statsBtn(c)).toHaveAttribute('aria-expanded', 'false');
  await expect(c.locator('.stats-panel')).toBeHidden();
});

test('statistics card: 320 px, the page does not scroll sideways, tables scroll in their own region', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await open(page);
  await seed(page);
  const panel = await openStats(page);
  await expect(panel.locator('table.st-table').first()).toBeVisible();
  const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
  expect(m.doc).toBeLessThanOrEqual(m.view);
  const wide = await panel.locator('.st-scroll').evaluateAll(list => list.map(n => [n.scrollWidth > n.clientWidth, n.getBoundingClientRect().right <= document.documentElement.clientWidth + 1]));
  expect(wide.every(([, inside]) => inside)).toBe(true);
  expect(wide.some(([scrolls]) => scrolls)).toBe(true);
  // Only for the manual review shots (STATS_SHOT_DIR, Chromium): WebKit applies the style that
  // Playwright injects for a screenshot as an inline <style>, which the page CSP blocks and the
  // fixtures report as a console error.
  if (process.env.STATS_SHOT_DIR) await page.screenshot({ path: `${process.env.STATS_SHOT_DIR}/stats-320.png`, fullPage: true });
});

// axe-core is not a committed dependency (like @playwright/test; `just a11y-survey` installs it):
// the check runs where it can be resolved and is skipped otherwise.
let AXE = null;
try { AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* not installed */ }

for (const [label, theme, forced] of [['light', 'light', 'none'], ['dark', 'dark', 'none'], ['forced colours', 'light', 'active']]) {
  test(`statistics card: axe-core WCAG 2.2 A/AA, ${label}`, async ({ page }) => {
    test.skip(!AXE, 'axe-core is not installed (npm install axe-core@4.14.0 in tests/e2e)');
    await page.emulateMedia({ colorScheme: theme, forcedColors: forced });
    await page.addInitScript({ content: AXE }); // an init script is not subject to the page's CSP
    await open(page);
    await seed(page);
    await openStats(page);
    await expect(page.locator('#series-stats-ser-a .st-status')).toHaveText('Statistics calculated.');
    const violations = await page.evaluate(async () => {
      const r = await globalThis.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
      return r.violations.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
    });
    expect(violations).toEqual([]);
    if (process.env.STATS_SHOT_DIR) await page.screenshot({ path: `${process.env.STATS_SHOT_DIR}/stats-${label.replace(' ', '-')}.png`, fullPage: true });
  });
}
