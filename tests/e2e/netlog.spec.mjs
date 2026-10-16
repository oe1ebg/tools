// Netlog (/tools/netlog/), the MVP gates of issue #68: sessions and
// series, check-ins with partial callsigns, roster, status and presence,
// the read-only second tab, both languages, the note editor and drafts, My
// Turn, net control, the Continuous Log, search, correction and undo,
// backup/restore, failed saves, storage without IndexedDB, offline after
// the install, privacy controls and lookup links. Synthetic callsigns only
// (OE0QX…).
import { writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
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
// the caret to the end of a field (End does not do that in WebKit)
const toEnd = loc => loc.evaluate(ta => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
const composer = page => page.locator('#station-rounds .composer-text');
const ready = page => expect.poll(() => page.evaluate(() => globalThis.NETLOG_READY === true)).toBe(true);
async function openStation(page, call) {
  await page.locator('#roster button.person', { hasText: call }).click();
  await expect(page.locator('#station-call')).toHaveText(call);
  await expect(composer(page)).toBeFocused();
}
async function newRound(page) {
  const before = await page.locator('#round-indicator').textContent();
  await page.locator('#btn-new-round').click();
  await page.locator('#round-form button[value=ok]').click();
  await expect(page.locator('#round-indicator')).not.toHaveText(before);
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
  await toEnd(notesOf(page).first());
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

// ---------- NCS, log, search, correction, undo ----------

test('net control: keyboard handover, history with old/new, time correction, undo; no round from it', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  await checkIn(page, 'OE0QXA', 'Mira');
  await checkIn(page, 'OE0QXB', 'Jonas');
  await openStation(page, 'OE0QXA');
  await page.locator('#btn-ncs').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#btn-ncs')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#roster li', { hasText: 'OE0QXA' }).locator('.pill.ncs')).toHaveText('NCS');
  await page.locator('#tab-control').click();
  await page.getByRole('button', { name: 'Net control: OE0QXB' }).press('Enter');
  await expect(page.locator('#ncs-current')).toHaveText('Net control: OE0QXB · Jonas');
  await expect(page.locator('#roster .pill.ncs')).toHaveCount(1);
  await expect(page.locator('#ncs-history li .ev-what')).toHaveText(['— → OE0QXA', 'OE0QXA → OE0QXB']);
  const time = page.locator('#ncs-history li').nth(1).locator('input.ev-time');
  await time.fill('19:05');
  await page.locator('#ncs-history li').nth(1).locator('input.ev-est').check();
  await expect(page.locator('#st-save')).toContainText('saved');
  await page.reload();
  await ready(page);
  await expect(page.locator('#ncs-history li').nth(1).locator('input.ev-time')).toHaveValue('19:05');
  await expect(page.locator('#ncs-history li').nth(1).locator('input.ev-est')).toBeChecked();
  // undo the estimate flag and the time correction, then the handover
  await page.locator('#btn-undo').click();
  await expect(page.locator('#ncs-history li').nth(1).locator('input.ev-est')).not.toBeChecked();
  await page.locator('#tab-control').focus();
  await page.keyboard.press('Control+z');
  await expect(page.locator('#ncs-history li').nth(1).locator('input.ev-time')).not.toHaveValue('19:05');
  await page.keyboard.press('Control+z');
  await expect(page.locator('#ncs-current')).toHaveText('Net control: OE0QXA · Mira');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('#ncs-current')).toHaveText('Net control: OE0QXB · Jonas');
  await expect(page.locator('#round-list li')).toHaveCount(1);
});

test('presence: late check-in, pause, checkout, reentry; reorders keep the speaking history', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page, { round: 2 });
  await checkIn(page, 'OE0QXA');
  await checkIn(page, 'OE0QXB');
  await openStation(page, 'OE0QXB');
  await page.locator('#btn-spoke').click();
  await page.keyboard.press('Escape');
  await page.locator('#station-status').selectOption('paused');
  await page.locator('#station-status').selectOption('out');
  await page.locator('#station-status').selectOption('active');
  await page.locator('#btn-details').click();
  await expect(page.locator('#presence-list li')).toHaveCount(2);
  const before = await page.evaluate(() => JSON.stringify(globalThis.NETLOG_APP.sd.contributions.map(c => [c.id, c.participantId, c.roundId, c.seq])));
  await page.getByRole('button', { name: 'Move OE0QXB up' }).click();
  await page.locator('#tab-control').click();
  await page.locator('#order-list li').nth(1).getByRole('button', { name: 'Move OE0QXA up' }).click();
  await page.getByRole('button', { name: 'Net control: OE0QXA' }).click();
  expect(await page.evaluate(() => JSON.stringify(globalThis.NETLOG_APP.sd.contributions.map(c => [c.id, c.participantId, c.roundId, c.seq])))).toBe(before);
  await expect(page.locator('#round-list li')).toHaveCount(1);
  // a late arrival in round 3
  await newRound(page);
  await checkIn(page, 'OE0QXC');
  expect(await page.evaluate(() => { const a = globalThis.NETLOG_APP; const p = a.sd.participants.find(x => x.call === 'OE0QXC'); return p.checkinRoundId === a.s.currentRoundId; })).toBe(true);
});

test('Continuous Log: the same notes, in order; edits show in Live Notes; bulk move and undo', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  for (const c of ['OE0QXA', 'OE0QXB', 'OE0QXC']) await checkIn(page, c);
  for (const [c, text] of [['OE0QXA', 'first'], ['OE0QXB', 'second'], ['OE0QXA', 'third']]) {
    await openStation(page, c);
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  }
  await page.locator('#tab-log').click();
  const rows = page.locator('#log-rounds li.note textarea.note-text');
  await expect.poll(() => values(rows)).toEqual(['first', 'second', 'third']);
  await expect(page.locator('#log-rounds li.note .station')).toHaveText(['OE0QXA', 'OE0QXB', 'OE0QXA']);
  // edit in the log
  await rows.nth(1).click();
  await toEnd(rows.nth(1));
  await page.keyboard.type(' (log edit)');
  await page.keyboard.press('Enter');
  await expect(page.locator('#log-rounds li.note').nth(1)).toBeFocused();
  // the station link opens Live Notes at the note; b comes back
  await page.locator('#log-rounds li.note').nth(1).locator('.station').click();
  await expect(page.locator('#station-call')).toHaveText('OE0QXB');
  await expect.poll(() => values(notesOf(page))).toEqual(['second (log edit)']);
  await page.keyboard.press('b');
  await expect(page.locator('#view-log')).toBeVisible();
  // select two notes and move them to OE0QXC
  await page.locator('#btn-log-select').click();
  await page.locator('#log-rounds li.note').nth(0).locator('input.note-select').check();
  await page.locator('#log-rounds li.note').nth(2).locator('input.note-select').check();
  await expect(page.locator('#log-selected')).toHaveText('2 notes selected');
  await page.locator('#btn-log-move').click();
  await page.locator('#move-station').selectOption({ label: 'OE0QXC' });
  await page.locator('#move-form button[value=ok]').click();
  await expect(page.locator('#log-rounds li.note .station')).toHaveText(['OE0QXC', 'OE0QXB', 'OE0QXC']);
  await expect.poll(() => values(rows)).toEqual(['first', 'second (log edit)', 'third']);
  await page.locator('#btn-undo').click();
  await expect(page.locator('#log-rounds li.note .station')).toHaveText(['OE0QXA', 'OE0QXB', 'OE0QXA']);
});

test('search: history and collapsed rounds, Enter opens the exact match, b returns with the draft', async ({ page }) => {
  await open(page, { lang: 'en' });
  // an earlier session with the text to find
  await startSession(page);
  await checkIn(page, 'OE0QXC', 'Lea');
  await openStation(page, 'OE0QXC');
  await page.keyboard.type('Plans a portable test on the Kahlenberg.');
  await page.keyboard.press('Enter');
  await page.locator('#tab-series').click();
  // the current one: a note in a round that will be collapsed, and a draft
  await startSession(page);
  await checkIn(page, 'OE0QXB');
  await openStation(page, 'OE0QXB');
  await page.keyboard.type('Interference with the beam antenna.');
  await page.keyboard.press('Enter');
  await newRound(page);
  await newRound(page);
  await newRound(page);
  await openStation(page, 'OE0QXB');
  await page.keyboard.type('unfinished draft');
  const session = await page.evaluate(() => globalThis.NETLOG_APP.s.id);
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  await expect(page.locator('#search-dlg')).toBeVisible();
  await page.keyboard.type('beam');
  await expect(page.locator('#search-results li')).toHaveCount(1);
  await expect(page.locator('#search-results li')).toContainText('Round 1 · OE0QXB · note');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#station-rounds li.note.highlight textarea.note-text')).toBeFocused();
  await expect(page.locator('#station-rounds li.note.highlight textarea.note-text')).toHaveValue('Interference with the beam antenna.');
  // history: in all sessions
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  await page.locator('#search-scope').selectOption('all');
  await page.locator('#search-q').fill('kahlenberg');
  await expect(page.locator('#search-results li')).toHaveCount(1);
  await page.locator('#search-results button').first().click();
  await expect(page.locator('#station-call')).toHaveText('OE0QXC');
  await expect(page.locator('#station-rounds li.note.highlight textarea.note-text')).toBeFocused();
  expect(await page.evaluate(() => globalThis.NETLOG_APP.s.id)).not.toBe(session);
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
  await expect(page.locator('#station-call')).toHaveText('OE0QXB');
  expect(await page.evaluate(() => globalThis.NETLOG_APP.s.id)).toBe(session);
  await page.keyboard.press('b');
  await expect(composer(page)).toHaveValue('unfinished draft');
});

test('a partial callsign resolved to a station already checked in: preview, merge, undo', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  await checkIn(page, 'OE0QXB', 'Jonas');
  await checkIn(page, 'OE0QX?');
  await openStation(page, 'OE0QX?');
  await page.keyboard.type('heard only partly');
  await page.keyboard.press('Enter');
  await page.locator('#btn-edit-identity').click();
  await page.locator('#identity-call').fill('OE0QXB');
  await page.locator('#identity-call').press('Enter');
  await expect(page.locator('#merge-dlg')).toBeVisible();
  await expect(page.locator('#merge-preview')).toContainText('notes moving over: 1');
  await page.locator('#merge-form button[value=merge]').click();
  await expect(roster(page)).toHaveText(['OE0QXB']);
  await expect(page.locator('#station-call')).toHaveText('OE0QXB');
  await expect.poll(() => values(notesOf(page))).toEqual(['heard only partly']);
  await page.locator('#btn-undo').click();
  await expect(roster(page)).toHaveText(['OE0QXB', 'OE0QX?']);
});

// ---------- backup, recovery, offline, privacy, links ----------


async function oneNote(page, text = 'A note to keep.') {
  await startSession(page);
  await checkIn(page, 'OE0QXB', 'Jonas');
  await openStation(page, 'OE0QXB');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect.poll(() => values(notesOf(page))).toEqual([text]);
}

test('backup: export, erase everything, import back; the same file again changes nothing; bad files change nothing', async ({ page }) => {
  await open(page, { lang: 'en' });
  await oneNote(page);
  await page.locator('#tab-series').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-export-all').click()]);
  await expect(page.locator('#data-msg')).toContainText('Check that the file arrived');
  const file = await dl.path();
  page.on('dialog', d => d.accept());
  await page.locator('#btn-erase-all').click();
  await expect(page.locator('#data-msg')).toHaveText('All Netlog data on this device was erased.');
  await expect(page.locator('#series-list .session-row')).toHaveCount(0);
  await page.locator('#import-file').setInputFiles(file);
  await expect(page.locator('#data-msg')).toContainText('Imported: 1 sessions');
  await page.locator('#series-list button[data-act=open]').first().click();
  await expect(roster(page)).toHaveText(['OE0QXB']);
  await openStation(page, 'OE0QXB');
  await expect.poll(() => values(notesOf(page))).toEqual(['A note to keep.']);
  await page.locator('#tab-series').click();
  await page.locator('#import-file').setInputFiles(file);
  await expect(page.locator('#data-msg')).toContainText('1 already here unchanged');
  await expect(page.locator('#series-list .session-row')).toHaveCount(1);
  // a file that is no backup / a damaged one: refused, nothing changes
  const dir = await mkdtemp(pathJoin(tmpdir(), 'netlog-'));
  const bad = pathJoin(dir, 'bad.json');
  await writeFile(bad, '{"format":"oe1ebg-netlog-backup","version":1,"schema":1,"stores":{"notes":[{"id":"n","eventId":"nowhere","text":"x"}]}}');
  await page.locator('#import-file').setInputFiles(bad);
  await expect(page.locator('#data-msg')).toContainText('damaged or incomplete');
  const notJson = pathJoin(dir, 'x.json');
  await writeFile(notJson, 'not json');
  await page.locator('#import-file').setInputFiles(notJson);
  await expect(page.locator('#data-msg')).toHaveText('Not imported: this is not a JSON file. Nothing was changed.');
  await expect(page.locator('#series-list .session-row')).toHaveCount(1);
});

test('a failed save keeps the text, never says saved, and saving again works', async ({ page, problems }) => {
  await open(page, { lang: 'en' });
  await oneNote(page);
  await page.evaluate(() => {
    globalThis.__tx = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function () { throw new DOMException('quota', 'QuotaExceededError'); };
  });
  await page.keyboard.type('Must not be lost.');
  await page.keyboard.press('Enter');
  await expect(page.locator('#st-save')).toHaveText('NOT SAVED');
  await expect(page.locator('#banner')).toContainText('browser storage is full');
  await expect(composer(page)).toHaveValue('Must not be lost.');
  await expect.poll(() => values(notesOf(page))).toEqual(['A note to keep.']);
  await page.evaluate(() => { IDBDatabase.prototype.transaction = globalThis.__tx; });
  await composer(page).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => values(notesOf(page))).toEqual(['A note to keep.', 'Must not be lost.']);
  await expect(page.locator('#st-save')).toContainText('saved');
  for (let i = problems.length - 1; i >= 0; i--) if (/QuotaExceededError: quota/.test(problems[i])) problems.splice(i, 1);
});

test('without IndexedDB: works in memory, says nothing is stored, offers an export', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(globalThis, 'indexedDB', { value: undefined }); });
  await open(page, { lang: 'en' });
  await expect(page.locator('#storage-banner')).toContainText('NOTHING is saved');
  await expect(page.locator('#st-save')).toHaveText('NOT STORED (memory only)');
  await expect(page.locator('#st-backend')).toHaveText('memory only, not saved');
  await oneNote(page, 'kept in memory');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-memory-export').click()]);
  expect(JSON.parse(await readFile(await dl.path(), 'utf8')).stores.notes[0].text).toBe('kept in memory');
});

test('a database of a newer version is left alone: memory mode, the records stay', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'IndexedDB version handling: Chromium is enough');
  await open(page, { lang: 'en' });
  await oneNote(page);
  // another (newer) Netlog upgraded the database
  await page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('oe1ebg-netlog', 99);
    r.onsuccess = () => { r.result.close(); resolve(); };
    r.onerror = () => reject(r.error);
  }));
  await page.reload();
  await ready(page);
  await expect(page.locator('#storage-banner')).toContainText('A newer version of Netlog has updated the data on this device');
  await expect(page.locator('#st-save')).toHaveText('NOT STORED (memory only)');
  const kept = await page.evaluate(() => new Promise(resolve => {
    const r = indexedDB.open('oe1ebg-netlog', 99);
    r.onsuccess = () => {
      const tx = r.result.transaction('notes').objectStore('notes').getAll();
      tx.onsuccess = () => { resolve(tx.result.map(n => n.text)); r.result.close(); };
    };
  }));
  expect(kept).toEqual(['A note to keep.']);
});

test('offline after the install: reload, notes, search, My Turn, net control, backup', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await open(page, { lang: 'en' });
  await expect(page.locator('#st-offline')).toHaveText('offline ready ✓', { timeout: 45_000 });
  await oneNote(page, 'Before going offline.');
  await context.setOffline(true);
  await page.reload();
  await ready(page);
  await expect(page.locator('#station-call')).toHaveText('OE0QXB');
  await expect(page.locator('#station-links')).toBeHidden();
  await composer(page).focus();
  await page.keyboard.type('Written offline.');
  await page.keyboard.press('Enter');
  await expect.poll(() => values(notesOf(page))).toEqual(['Before going offline.', 'Written offline.']);
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  await page.keyboard.type('offline');
  await expect(page.locator('#search-results li')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('m');
  await expect(page.locator('#view-turn')).toBeVisible();
  await page.locator('#tab-control').click();
  await page.getByRole('button', { name: 'Net control: OE0QXB' }).click();
  await expect(page.locator('#ncs-current')).toContainText('OE0QXB');
  await page.locator('#tab-series').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-export-all').click()]);
  expect(await dl.path()).toBeTruthy();
  await context.setOffline(false);
});

test('privacy: remove and restore a station, erase it for good; lookup links only for real callsigns', async ({ page }) => {
  await open(page, { lang: 'en' });
  await oneNote(page);
  await expect(page.locator('#station-links a')).toHaveText(['QRZ.com ↗', 'HamQTH ↗', 'QRZCQ ↗', 'APRS.fi ↗']);
  await expect(page.locator('#station-links a').first()).toHaveAttribute('href', 'https://www.qrz.com/db/OE0QXB');
  await expect(page.locator('#station-links a').first()).toHaveAttribute('rel', 'noopener noreferrer');
  await checkIn(page, 'OE0QX?');
  await openStation(page, 'OE0QX?');
  await expect(page.locator('#station-links')).toBeHidden();
  await openStation(page, 'OE0QXB');
  page.on('dialog', d => d.accept());
  await page.locator('#btn-details').click();
  await page.locator('#btn-remove-station').click();
  await expect(roster(page)).toHaveText(['OE0QX?']);
  await page.locator('#tab-control').click();
  await page.getByRole('button', { name: 'Restore OE0QXB' }).click();
  await expect(roster(page)).toHaveText(['OE0QXB', 'OE0QX?']);
  await page.locator('#tab-live').click();
  await openStation(page, 'OE0QXB');
  await page.locator('#btn-remove-station').click();
  await page.locator('#tab-control').click();
  await page.getByRole('button', { name: 'Erase OE0QXB and everything recorded about it permanently' }).click();
  await expect(page.locator('#removed-list')).toHaveText('No removed stations.');
  expect(await page.evaluate(async () => (await globalThis.NETLOG_APP.store.getAll('notes')).length)).toBe(0);
});
