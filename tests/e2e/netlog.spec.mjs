// Netlog (/tools/netlog/): sessions and series, check-ins with partial
// callsigns, inline correction and status, roster order, the read-only
// second tab, both languages. Synthetic callsigns only (OE0QX…).
import { test, expect, offlineSettled } from './fixtures.mjs';

// The test browsers run with locale de-AT: Netlog starts in German. Tests
// that need English set the pref first.
async function open(page, { lang } = {}) {
  if (lang) await page.addInitScript(l => { try { localStorage.setItem('oe1ebg-netlog-lang', l); } catch { /* blocked */ } }, lang);
  await page.goto('tools/netlog/');
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await offlineSettled(page);
}

async function startSession(page, { round, own = 'OE0QXA' } = {}) {
  await page.locator('#btn-new-session').click();
  await page.locator('#sf-own').fill(own);
  if (round) {
    await page.locator('#sf-round').fill(String(round));
    await page.locator('#sf-joined').check();
  }
  await page.locator('#session-form button[type=submit]').click();
  await expect(page.locator('#view-live')).toBeVisible();
}

async function checkIn(page, call, name = '') {
  await page.locator('#checkin-call').fill(call);
  if (name) await page.locator('#checkin-name').fill(name);
  await page.locator('#checkin-name').press('Enter');
  await expect(page.locator('#roster')).toContainText(call);
}

const roster = page => page.locator('#roster button.person .call');

test('starts in German, switches to English and back, keeping the input', async ({ page }) => {
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('#tab-series')).toHaveText('Sitzungen & Serien');
  await startSession(page);
  await page.locator('#checkin-call').fill('OE0QX');
  await page.locator('#lang-toggle button[data-lang=en]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#tab-live')).toHaveText('Live Notes');
  await expect(page.locator('#checkin-call')).toHaveValue('OE0QX');
  await expect(page.locator('#st-offline')).toHaveText('offline ready ✓');
  await page.reload();
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await expect(page.locator('#tab-live')).toHaveText('Live Notes');
  await page.locator('#lang-toggle button[data-lang=de]').click();
  await expect(page.locator('#tab-live')).toHaveText('Live-Notizen');
});

test('ad-hoc session mid-net: partial callsign resolved later, series assigned later', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page, { round: 3 });
  await expect(page.locator('#round-indicator')).toHaveText('Round 3');
  await checkIn(page, 'OE0QXB', 'Jonas');
  await checkIn(page, 'OE0QX?');
  await expect(page.locator('#station-sub')).toContainText('not confirmed');
  // correct inline: the same participant keeps its identity
  const id = await page.evaluate(() => globalThis.NETLOG_APP.ui.selected);
  await page.locator('#btn-edit-identity').click();
  await page.locator('#identity-call').fill('OE0QXC');
  await page.locator('#identity-name').fill('Lea');
  await page.locator('#identity-call').press('Enter');
  await expect(page.locator('#station-call')).toHaveText('OE0QXC');
  expect(await page.evaluate(() => globalThis.NETLOG_APP.ui.selected)).toBe(id);
  await expect(roster(page)).toHaveText(['OE0QXB', 'OE0QXC']);

  // a series afterwards: the session moves into it, numbered #1
  await page.locator('#tab-series').click();
  await page.locator('#btn-new-series').click();
  await page.locator('#srf-name').fill('Fictional evening net');
  await page.locator('#series-form button[type=submit]').click();
  await expect(page.locator('#series-list')).toContainText('Fictional evening net');
  await page.locator('#series-list select[data-assign]').first().selectOption({ label: 'Fictional evening net' });
  await expect(page.locator('#session-line')).toContainText('Fictional evening net #1');
  await page.locator('#tab-live').click();
  await expect(roster(page)).toHaveText(['OE0QXB', 'OE0QXC']);
});

test('keyboard only: check in, move through the roster, status and order', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  for (const c of ['OE0QXA', 'OE0QXB', 'OE0QXC']) {
    await page.locator('#checkin-call').focus();
    await page.keyboard.type(c.toLowerCase());
    await page.keyboard.press('Enter'); // to the name field
    await page.keyboard.press('Enter'); // check in
  }
  await expect(roster(page)).toHaveText(['OE0QXA', 'OE0QXB', 'OE0QXC']);
  // Esc leaves the field; j/k move through the roster without typing anything
  await page.keyboard.press('Escape');
  await expect(page.locator('#mode-indicator')).toHaveText('Navigation');
  await page.locator('#roster button.person').first().focus();
  await page.keyboard.press('j');
  await expect(page.locator('#roster li.active .call')).toHaveText('OE0QXB');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#roster li.active .call')).toHaveText('OE0QXC');
  await page.keyboard.press('k');
  await expect(page.locator('#roster li.active .call')).toHaveText('OE0QXB');
  // reorder with the labelled buttons
  await page.getByRole('button', { name: 'Move OE0QXB up' }).click();
  await expect(roster(page)).toHaveText(['OE0QXB', 'OE0QXA', 'OE0QXC']);
  // status: check out and back in = a reentry (two presence intervals)
  await page.locator('#station-status').selectOption('out');
  await expect(page.locator('#roster li.active .dot')).toHaveClass(/out/);
  await page.locator('#station-status').selectOption('active');
  await page.locator('#btn-details').click();
  await expect(page.locator('#presence-list li')).toHaveCount(2);
  // typing j/k in a field types them
  await page.locator('#det-qth').fill('');
  await page.locator('#det-qth').type('jk');
  await expect(page.locator('#det-qth')).toHaveValue('jk');
  await page.locator('#det-qth').press('Enter');
  await expect(page.locator('#st-save')).toContainText('saved');
  await page.reload();
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await expect(page.locator('#det-qth')).toHaveValue('jk');
});

test('a second tab is read-only until "Edit here"', async ({ page, context }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  await checkIn(page, 'OE0QXA');
  const url = page.url();
  const other = await context.newPage();
  await other.goto(url);
  await expect.poll(() => other.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
  await expect(other.locator('#lock-banner')).toBeVisible();
  await expect(other.locator('#checkin-call')).toBeDisabled();
  await other.locator('#btn-edit-here').click();
  await expect(other.locator('#lock-banner')).toBeHidden();
  await expect(page.locator('#lock-banner')).toBeVisible();
  await expect(page.locator('#checkin-call')).toBeDisabled();
  await other.close();
});

// ---------- live logging and My Turn ----------

const notesOf = page => page.locator('#station-rounds section.round.current li.note textarea.note-text');
const values = loc => loc.evaluateAll(els => els.map(e => e.value));
const composer = page => page.locator('#station-rounds .composer-text');
const ready = page => expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
async function openStation(page, call) {
  await page.locator('#roster button.person', { hasText: call }).click();
  await expect(page.locator('#station-call')).toHaveText(call);
  await expect(composer(page)).toBeFocused();
}
async function newRound(page) {
  await page.locator('#btn-new-round').click();
  await page.locator('#round-form button[value=ok]').click();
}

test('notes: Enter saves and goes on, Shift+Enter new line, empty and IME Enter save nothing; order stays', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  await checkIn(page, 'OE0QXB', 'Jonas');
  await checkIn(page, 'OE0QXC', 'Lea');
  await openStation(page, 'OE0QXB');
  await page.keyboard.type('Antenna changed.');
  await page.keyboard.press('Enter');
  await expect(notesOf(page)).toHaveCount(1);
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue('');
  await page.keyboard.press('Enter'); // empty: nothing
  await page.keyboard.type('Interference remains');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('after the change.');
  // an Enter that confirms an IME composition is not a save
  await composer(page).evaluate(ta => ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
  await page.keyboard.press('Enter');
  await expect.poll(() => values(notesOf(page))).toEqual(['Antenna changed.', 'Interference remains\nafter the change.']);
  // typed characters never run commands
  await page.keyboard.type('jkmrnpxb?');
  await expect(composer(page)).toHaveValue('jkmrnpxb?');
  await expect(page.locator('#view-live')).toBeVisible();
  await page.keyboard.press('Enter');
  // correcting a note keeps its place
  await notesOf(page).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (corrected)');
  await page.keyboard.press('Enter');
  await expect(composer(page)).toBeFocused();
  const expected = ['Antenna changed. (corrected)', 'Interference remains\nafter the change.', 'jkmrnpxb?'];
  await expect.poll(() => values(notesOf(page))).toEqual(expected);
  // ... through a station change, collapse/expand and a reload
  await openStation(page, 'OE0QXC');
  await openStation(page, 'OE0QXB');
  await page.locator('#station-rounds section.round.current button.round-toggle').click();
  await page.locator('#station-rounds section.round.current button.round-toggle').click();
  await expect.poll(() => values(notesOf(page))).toEqual(expected);
  await expect(page.locator('#st-save')).toContainText('saved');
  await page.reload();
  await ready(page);
  await expect.poll(() => values(notesOf(page))).toEqual(expected);
});

test('drafts: unfinished text comes back after a station switch and a reload', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  await checkIn(page, 'OE0QXB');
  await checkIn(page, 'OE0QXC');
  await openStation(page, 'OE0QXB');
  await page.keyboard.type('Half typed thought');
  await openStation(page, 'OE0QXC');
  await expect(composer(page)).toHaveValue('');
  await page.keyboard.type('Other station');
  await openStation(page, 'OE0QXB');
  await expect(composer(page)).toHaveValue('Half typed thought');
  await expect(page.locator('#st-save')).toContainText('draft kept');
  await page.reload();
  await ready(page);
  await expect(composer(page)).toHaveValue('Half typed thought');
  await openStation(page, 'OE0QXC');
  await expect(composer(page)).toHaveValue('Other station');
  // the caret comes back where it was (end of the text)
  expect(await composer(page).evaluate(ta => ta.selectionStart)).toBe('Other station'.length);
});

// A session with four rounds (round 2 empty), a flagged note in round 1,
// an after-net task, a personal point; plus an earlier session with an
// open response of its own.
async function fourRounds(page) {
  await open(page, { lang: 'en' });
  await startSession(page);
  await checkIn(page, 'OE0QXB', 'Jonas');
  await openStation(page, 'OE0QXB');
  await page.keyboard.type('Earlier session, open response');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.locator('#station-rounds li.note').first().focus();
  await page.keyboard.press('r');
  await expect(page.locator('#station-rounds li.note').first()).toHaveClass(/flagged/);
  // the session under test
  await page.locator('#tab-series').click();
  await startSession(page);
  for (const [c, n] of [['OE0QXB', 'Jonas'], ['OE0QXC', 'Lea'], ['OE0QXD', 'Felix']]) await checkIn(page, c, n);
  await openStation(page, 'OE0QXB');
  await page.keyboard.type('Interference persists after antenna change.');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.locator('#station-rounds li.note').first().focus();
  await page.keyboard.press('r');
  await page.locator('#station-rounds li.note').first().locator('textarea.reply-text').fill('Ask about common-mode current.');
  await page.locator('#station-rounds li.note').first().locator('textarea.reply-text').press('Enter');
  await openStation(page, 'OE0QXC');
  await page.keyboard.type('Send QSL card');
  await page.keyboard.press('Enter');
  await page.locator('#station-rounds li.note').first().getByRole('button', { name: 'After-net task for this note' }).click();
  await newRound(page); // 2: stays empty
  await newRound(page); // 3
  await openStation(page, 'OE0QXD');
  await page.keyboard.type('Antenna changed.');
  await page.keyboard.press('Enter');
  await openStation(page, 'OE0QXC');
  await page.keyboard.type('Plans a portable test.');
  await page.keyboard.press('Enter');
  await newRound(page); // 4
  await expect(page.locator('#round-indicator')).toHaveText('Round 4');
  await openStation(page, 'OE0QXB');
  await page.keyboard.type('Round four note.');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}

const queue = page => page.locator('#turn-items > li');

test('My Turn: round 1 response above the round 4 summary, points in, tasks and other sessions out', async ({ page }) => {
  await fourRounds(page);
  await page.keyboard.press('m');
  await expect(page.locator('#view-turn')).toBeVisible();
  await expect(page.locator('#turn-title')).toHaveText('My Turn — OE0QXA — Round 4');
  await page.locator('#point-text').fill('Mention the next portable test.');
  await page.locator('#point-text').press('Enter');
  await expect(queue(page)).toHaveCount(2);
  await expect(queue(page).nth(0)).toContainText('OE0QXB');
  await expect(queue(page).nth(0)).toContainText('Interference persists after antenna change.');
  await expect(queue(page).nth(0).locator('textarea')).toHaveValue('Ask about common-mode current.');
  await expect(queue(page).nth(1)).toContainText('Personal talking point');
  await expect(page.locator('#turn-items')).not.toContainText('Send QSL card');
  await expect(page.locator('#turn-items')).not.toContainText('Earlier session');
  // the responses come before the round notes on the page
  const [qy, sy] = await Promise.all([page.locator('#turn-items').boundingBox(), page.locator('#sum-groups').boundingBox()]);
  expect(qy.y).toBeLessThan(sy.y);
  // current round by default; p = previous (round 3): every note under its station
  await expect(page.locator('#sum-current')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sum-groups')).toContainText('Round four note.');
  const before = await queue(page).allTextContents();
  await page.locator('#turn-title').focus();
  await page.keyboard.press('p');
  await expect(page.locator('#sum-prev')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sum-topic')).toHaveText('Round 3');
  await expect(page.locator('#sum-groups h4')).toHaveText(['OE0QXD · Felix', 'OE0QXC · Lea']);
  await expect(page.locator('#sum-groups')).toContainText('Plans a portable test.');
  // prepared replies are not repeated in the summary
  await expect(page.locator('#sum-groups')).not.toContainText('common-mode');
  expect(await queue(page).allTextContents()).toEqual(before);
  // manual order: the point moves above the response, with a button
  await queue(page).nth(1).getByRole('button', { name: /Move up/ }).click();
  await expect(queue(page).nth(0)).toContainText('Personal talking point');
  // an empty previous round shows the empty state; in the first round
  // there is no previous one
  await page.locator('#tab-control').click();
  await page.locator('#round-list li').nth(2).getByRole('button', { name: 'Make round 3 the current round' }).click();
  await page.locator('#tab-turn').click();
  await page.locator('#sum-prev').click();
  await expect(page.locator('#sum-empty')).toHaveText('No notes in this round.');
  await page.locator('#tab-control').click();
  await page.locator('#round-list li').nth(0).getByRole('button', { name: 'Make round 1 the current round' }).click();
  await page.locator('#tab-turn').click();
  await expect(page.locator('#sum-prev')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#sum-prev-why')).toHaveText('This is the first logged round: there is no previous one.');
});

test('My Turn: Enter opens the source, b comes back to the same place; x completes, End Turn clears', async ({ page }) => {
  await fourRounds(page);
  await page.keyboard.press('m');
  await expect(page.locator('#view-turn')).toBeVisible();
  await page.locator('#turn-title').focus();
  await page.keyboard.press('p'); // the previous round, to be restored
  await expect(page.locator('#sum-prev')).toHaveAttribute('aria-pressed', 'true');
  await queue(page).first().focus();
  await page.keyboard.press('Enter');
  // the source: OE0QXB, round 1 expanded, the note focused
  await expect(page.locator('#view-live')).toBeVisible();
  await expect(page.locator('#station-call')).toHaveText('OE0QXB');
  await expect(page.locator('#station-rounds li.note:focus textarea.note-text')).toHaveValue('Interference persists after antenna change.');
  await page.keyboard.press('b');
  await expect(page.locator('#view-turn')).toBeVisible();
  await expect(page.locator('#sum-prev')).toHaveAttribute('aria-pressed', 'true');
  await expect(queue(page).first()).toBeFocused();
  // the station link with the pointer does the same, the checkbox does not navigate
  await queue(page).first().locator('input.turn-done').check();
  await expect(page.locator('#view-turn')).toBeVisible();
  await expect(queue(page).first()).toHaveClass(/done/);
  await queue(page).first().locator('input.turn-done').uncheck();
  await expect(queue(page).first()).not.toHaveClass(/done/);
  // x completes the focused item; it stays (subdued) through a reload
  await queue(page).first().focus();
  await page.keyboard.press('x');
  await expect(queue(page).first()).toHaveClass(/done/);
  await expect(page.locator('#tab-turn-count')).toHaveText('');
  await page.reload();
  await ready(page);
  await expect(page.locator('#view-turn')).toBeVisible();
  await expect(queue(page).first()).toHaveClass(/done/);
  await page.locator('#btn-end-turn').click();
  await expect(queue(page)).toHaveCount(0);
  await expect(page.locator('#turn-history-summary')).toHaveText('Completed earlier (1)');
  await expect(page.locator('#round-indicator')).toHaveText('Round 4');
});
