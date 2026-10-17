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

async function startSession(page, { round, own = 'OE0QXZ' } = {}) {
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
  await page.locator('#btn-edit-identity').click();
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
  await expect(page.locator('#turn-title')).toHaveText('My Turn — OE0QXZ — Round 4');
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
  await page.locator('#btn-next').click(); // a speaking turn
  await page.keyboard.press('Escape');
  await page.locator('#roster button.person', { hasText: 'OE0QXB' }).click();
  await page.locator('#station-status').selectOption('paused');
  await page.locator('#station-status').selectOption('out');
  await page.locator('#station-status').selectOption('active');
  await page.locator('#btn-edit-identity').click();
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
  await expect(page.locator('#data-msg')).toContainText('Download of the backup (JSON) started');
  expect(dl.suggestedFilename()).toMatch(/^\d{4}-\d{2}-\d{2}_netlog_backup\.json$/);
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
  await page.locator('#btn-edit-identity').click();
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

// ---------- time display, callsign list ----------

test('times in UTC or local time, always labelled; a handover typed in local time is stored in UTC', async ({ page }) => {
  await open(page, { lang: 'en' });
  await oneNote(page);
  const noteTime = page.locator('#station-rounds li.note .note-lead .time').first();
  await expect(noteTime).toHaveText(/^\d{2}:\d{2} UTC$/);
  await expect(page.locator('#clock-zone')).toHaveText('UTC');
  await page.locator('#time-toggle button[data-time=local]').click();
  await expect(page.locator('#time-toggle button[data-time=local]')).toHaveAttribute('aria-pressed', 'true');
  // the test browsers run in Europe/Vienna
  await expect(noteTime).toHaveText(/^\d{2}:\d{2} UTC\+[12]$/);
  await expect(page.locator('#clock-zone')).toHaveText(/^UTC\+[12]$/);
  await expect(page.locator('#st-save')).toHaveText(/UTC\+[12]$/);
  // a handover time typed in local time
  await page.locator('#btn-ncs').click();
  await page.locator('#tab-control').click();
  const time = page.locator('#ncs-history li input.ev-time');
  await expect(page.locator('#ncs-history li .inline-field span')).toHaveText(/^Time \(UTC\+[12]\)$/);
  await time.fill('21:05');
  await time.press('Enter');
  await expect.poll(() => page.evaluate(() => globalThis.NETLOG_APP.sd.events.find(e => e.type === 'ncs').time.iso.slice(11, 16))).toMatch(/^(19|20):05$/);
  // the choice is kept; back to UTC shows the stored time
  await page.reload();
  await ready(page);
  await expect(page.locator('#ncs-history li input.ev-time')).toHaveValue('21:05');
  await page.locator('#time-toggle button[data-time=utc]').click();
  await expect(page.locator('#ncs-history li input.ev-time')).toHaveValue(/^(19|20):05$/);
});

// A synthetic stand-in for the shared callsign list (no real people).
const CALLBOOK = { stand: '2026-09-10', source: 'test', fields: ['call', 'name', 'location'], calls: [['OE0QXB', 'Jonas Test', 'Musterdorf'], ['OE0QXC', 'Lea Probe', 'Beispielstadt']] };

test('the callsign list fills name and QTH at check-in and when a partial callsign is resolved', async ({ page }) => {
  // a page route (it takes precedence over the fixture's catch-all)
  await page.route('**/shared/data/callsigns-oe.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CALLBOOK) }));
  await open(page, { lang: 'en' });
  await expect(page.locator('#st-callbook')).toContainText('as of 2026-09-10, 2 callsigns');
  await startSession(page);
  await page.locator('#checkin-call').fill('OE0QXB');
  await expect(page.locator('#checkin-info')).toHaveText('Callsign list: Jonas Test · Musterdorf');
  await page.locator('#checkin-call').press('Enter');
  await page.locator('#checkin-name').press('Enter');
  await expect(page.locator('#roster li', { hasText: 'OE0QXB' })).toContainText('Jonas Test');
  await page.locator('#roster button.person', { hasText: 'OE0QXB' }).click();
  await page.locator('#btn-edit-identity').click();
  await expect(page.locator('#det-qth')).toHaveValue('Musterdorf');
  // a name typed by hand is kept
  await page.locator('#checkin-call').fill('OE0QXC');
  await page.locator('#checkin-name').fill('Lea');
  await page.locator('#checkin-name').press('Enter');
  await expect(page.locator('#roster li', { hasText: 'OE0QXC' })).toContainText('Lea');
  await expect(page.locator('#roster li', { hasText: 'OE0QXC' })).not.toContainText('Probe');
  // a partial callsign: the list suggests what fits; resolving fills the rest
  await page.locator('#checkin-call').fill('OE0QX?');
  await expect(page.locator('#checkin-pop')).toContainText('callsign list');
  await page.locator('#checkin-name').press('Enter');
  await page.locator('#roster button.person', { hasText: 'OE0QX?' }).click();
  await page.locator('#btn-edit-identity').click();
  await page.locator('#identity-call').fill('OE0QXD');
  await expect(page.locator('#identity-info')).toHaveText('');
  // searching by name
  await page.locator('#identity-call').fill('probe');
  await expect(page.locator('#identity-pop button')).toContainText(['OE0QXC']);
});

test('Net Control: check stations out and in, pause them, from the list; presence follows', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  await checkIn(page, 'OE0QXA');
  await checkIn(page, 'OE0QXB');
  await page.locator('#tab-control').click();
  const sel = page.getByRole('combobox', { name: 'Status of OE0QXB' });
  await expect(sel).toHaveValue('active');
  await sel.selectOption('paused');
  await expect(page.locator('#roster li', { hasText: 'OE0QXB' }).locator('.dot')).toHaveClass(/paused/);
  await sel.selectOption('out');
  await expect(page.locator('#order-list li', { hasText: 'OE0QXB' })).toHaveClass(/out/);
  await sel.selectOption('active');
  await expect(sel).toHaveValue('active');
  // checkout closed the interval, coming back opened a new one
  await page.locator('#tab-live').click();
  await page.locator('#roster button.person', { hasText: 'OE0QXB' }).click();
  await page.locator('#btn-edit-identity').click();
  await expect(page.locator('#presence-list li')).toHaveCount(2);
  const events = await page.evaluate(() => globalThis.NETLOG_APP.sd.events.filter(e => e.type === 'status').sort((a, b) => (a.created < b.created ? -1 : 1)).map(e => e.to));
  expect(events).toEqual(['paused', 'out', 'active']);
});

test('my own callsign: changed in Net Control, marked "me" in the lists; the backup chip', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page, { own: '' });
  await checkIn(page, 'OE0QXB');
  await page.locator('#tab-control').click();
  await expect(page.locator('#btn-checkin-own')).toBeHidden();
  await page.locator('#se-own').fill('oe0qxa');
  await page.locator('#se-own').press('Enter');
  await expect(page.locator('#session-line')).toContainText('me: OE0QXA');
  await page.locator('#btn-checkin-own').click();
  await expect(page.locator('#roster li', { hasText: 'OE0QXA' }).locator('.pill.own')).toHaveText('me');
  await expect(page.locator('#roster li', { hasText: 'OE0QXB' }).locator('.pill.own')).toHaveCount(0);
  await expect(page.locator('#order-list li.own')).toContainText('OE0QXA (me)');
  await expect(page.locator('#btn-checkin-own')).toBeHidden();
  // the backup chip: notes not in a backup yet, a click downloads one
  await openStation(page, 'OE0QXB');
  await page.keyboard.type('One note.');
  await page.keyboard.press('Enter');
  await expect(page.locator('#st-backup')).toHaveText('no backup yet · 1 note');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#st-backup').click()]);
  expect(dl.suggestedFilename()).toMatch(/_backup\.json$/);
  await expect(page.locator('#st-backup')).toHaveText(/^backup started \d{2}:\d{2} UTC · nothing new since$/);
  await composer(page).focus();
  await page.keyboard.type('Another.');
  await page.keyboard.press('Enter');
  await expect(page.locator('#st-backup')).toHaveText(/· 1 note not in it$/);
});

test('series and session fields: repeater search and callsign completion', async ({ page }) => {
  const repeaters = { source: 'test', retrieved: '2026-10-01', repeaters: [
    { call: 'OE0XRA', site: 'Testberg', city: 'Musterdorf', lat: 48.2, lon: 16.4, locator: 'JN88EF', alt: 500, band: '2m', out: 145.6, in: 145.0, shift: -0.6, ctcss: 88.5, modes: ['FM'], status: 'active', comment: '' },
  ] };
  await page.route('**/shared/data/repeaters-at.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(repeaters) }));
  await page.route('**/shared/data/callsigns-oe.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CALLBOOK) }));
  await open(page, { lang: 'en' });
  await page.locator('#btn-new-series').click();
  await page.locator('#srf-repeater').fill('testberg');
  await expect(page.locator('#srf-repeater').locator('xpath=..').locator('.ac-pop button')).toContainText(['OE0XRA']);
  await page.locator('#srf-repeater').press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#srf-repeater')).toHaveValue('OE0XRA 145.600');
  await page.locator('#srf-ncs').fill('OE0QX');
  const pop = page.locator('#srf-ncs').locator('xpath=..').locator('.ac-pop');
  await expect(pop.locator('button')).toContainText(['OE0QXB', 'OE0QXC']);
  await pop.locator('button', { hasText: 'OE0QXC' }).click();
  await expect(page.locator('#srf-ncs')).toHaveValue('OE0QXC');
  // Enter in the field keeps what was typed (no suggestion swapped in)
  await page.locator('#srf-name').fill('Evening net');
  await page.locator('#series-form button[type=submit]').click();
  await expect(page.locator('#series-list')).toContainText('Evening net');
  await expect(page.locator('#series-list')).toContainText('OE0XRA 145.600');
});

test('j/k and the arrow keys wrap around at the ends of the roster', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  for (const c of ['OE0QXA', 'OE0QXB', 'OE0QXC']) await checkIn(page, c);
  await page.locator('#roster button.person', { hasText: 'OE0QXC' }).focus();
  await page.keyboard.press('j');
  await expect(page.locator('#roster button.person', { hasText: 'OE0QXA' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#roster button.person', { hasText: 'OE0QXC' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#roster button.person', { hasText: 'OE0QXA' })).toBeFocused();
  await page.keyboard.press('k');
  await expect(page.locator('#roster li.active .call')).toHaveText('OE0QXC');
});

test('running a round: NCS first, Next through the order, my turn opens My Turn, the next round offered; status lines in the log', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page, { own: 'OE0QXA' });
  for (const c of ['OE0QXA', 'OE0QXB', 'OE0QXN', 'OE0QXC']) await checkIn(page, c);
  await page.locator('#roster button.person', { hasText: 'OE0QXN' }).click();
  await page.locator('#btn-ncs').click();
  await expect(roster(page)).toHaveText(['OE0QXN', 'OE0QXA', 'OE0QXB', 'OE0QXC']);
  await expect(page.locator('#speak-style')).toHaveText('Star net (via the NCS)');
  await expect(page.locator('#roster')).toHaveClass(/topo-star/);
  await expect(page.locator('#topo-hint')).toHaveText('Star: every station gives back to OE0QXN.');
  // the NCS opens the round; I am next
  await expect(page.locator('#speak-state')).toHaveText('Speaking: OE0QXN · Next to speak: OE0QXA (me)');
  await expect(page.locator('#roster li.on-air .call')).toHaveText('OE0QXN');
  await expect(page.locator('#speak-me')).toHaveText('▶ You are next');
  // my turn: Next opens My Turn, not notes about myself
  await page.locator('#btn-next').click();
  await expect(page.locator('#view-turn')).toBeVisible();
  await expect(page.locator('#speak-me')).toHaveText('🎙 Your turn now');
  await expect(page.locator('#tab-turn')).toHaveClass(/me-onAir/);
  // star: back to the NCS, then the next station
  await expect(page.locator('#speak-state')).toHaveText('Speaking: OE0QXA (me) · Next: back to OE0QXN, then OE0QXB');
  await expect(page.locator('#roster li.up-next')).toContainText('OE0QXN');
  await page.locator('#btn-next').click();
  await expect(page.locator('#station-call')).toHaveText('OE0QXN');
  await expect(page.locator('#roster li.on-air')).toContainText('OE0QXN');
  await page.locator('#btn-next').click();
  await expect(page.locator('#station-call')).toHaveText('OE0QXB');
  await expect(composer(page)).toBeFocused();
  // a station that is away is skipped
  await page.locator('#tab-control').click();
  await page.getByRole('combobox', { name: 'Status of OE0QXC' }).selectOption('paused');
  await expect(page.locator('#speak-state')).toHaveText('Speaking: OE0QXB · Next to speak: OE0QXN');
  await page.locator('#btn-next').click();
  await expect(page.locator('#speak-state')).toHaveText('Speaking: OE0QXN · round 1: everyone has spoken');
  await page.locator('#btn-next').click();
  await expect(page.locator('#round-indicator')).toHaveText('Round 2');
  // a new round: the NCS still has the turn, I am next again
  await expect(page.locator('#speak-state')).toHaveText('Speaking: OE0QXN · Next to speak: OE0QXA (me)');
  await expect(page.locator('#speak-me')).toHaveText('▶ You are next');
  // one click: no dialog; undo takes it back
  await page.locator('#btn-new-round').click();
  await expect(page.locator('#round-indicator')).toHaveText('Round 3');
  await page.locator('#btn-undo').click();
  await expect(page.locator('#round-indicator')).toHaveText('Round 2');
  // the status change is a line in the station's log and the Continuous Log
  await page.locator('#tab-live').click();
  await page.locator('#roster button.person', { hasText: 'OE0QXC' }).click();
  await expect(page.locator('#station-rounds li.event-line').filter({ hasText: 'paused / away' })).toHaveCount(1);
  await page.locator('#tab-log').click();
  await expect(page.locator('#log-rounds li.event-line').filter({ hasText: 'OE0QXC: paused / away' })).toHaveCount(1);
  // the NCS stays first; the others reorder below it
  await page.locator('#tab-control').click();
  await expect(page.locator('#order-list li').first()).toContainText('OE0QXN');
  await expect(page.getByRole('button', { name: 'Move OE0QXA up' })).toBeDisabled();
});

test('my own station shows My Turn for a click and for j/k alike; j/k switch stations from My Turn', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page, { own: 'OE0QXA' });
  for (const c of ['OE0QXA', 'OE0QXB']) await checkIn(page, c);
  // the check-in fields are at the bottom of the column
  const [list, form] = await Promise.all([page.locator('#roster').boundingBox(), page.locator('#checkin-form').boundingBox()]);
  expect(form.y).toBeGreaterThan(list.y);
  await page.locator('#roster button.person', { hasText: 'OE0QXB' }).focus();
  await page.keyboard.press('k');
  await expect(page.locator('#view-turn')).toBeVisible();
  await expect(page.locator('#roster button.person', { hasText: 'OE0QXA' })).toBeFocused();
  await page.keyboard.press('j');
  await expect(page.locator('#view-live')).toBeVisible();
  await expect(page.locator('#station-call')).toHaveText('OE0QXB');
  await page.locator('#roster button.person', { hasText: 'OE0QXA' }).click();
  await expect(page.locator('#view-turn')).toBeVisible();
  // in My Turn, with the focus in the roster, j/k still switch stations
  await page.locator('#roster button.person', { hasText: 'OE0QXA' }).focus();
  await page.keyboard.press('j');
  await expect(page.locator('#station-call')).toHaveText('OE0QXB');
});

test('circle net: stations pass on in turn, the NCS included; the roster draws a chain', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  for (const c of ['OE0QXN', 'OE0QXA', 'OE0QXB']) await checkIn(page, c);
  await page.locator('#roster button.person', { hasText: 'OE0QXN' }).click();
  await page.locator('#btn-ncs').click();
  await page.locator('#tab-control').click();
  await page.locator('#se-style').selectOption('circle');
  await expect(page.locator('#speak-style')).toHaveText('Circle net (in turn)');
  await expect(page.locator('#roster')).toHaveClass(/topo-circle/);
  await expect(page.locator('#topo-hint')).toContainText('back to the first');
  for (const call of ['OE0QXN', 'OE0QXA', 'OE0QXB']) {
    await page.locator('#btn-next').click();
    await expect(page.locator('#roster li.on-air .call')).toHaveText(call);
  }
  await expect(page.locator('#btn-next')).toHaveText('▶ Start round 2');
});

test('status looks the same in both lists; checked-out stations are struck through and skipped by j/k; "me" from Net Control', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page, { own: '' });
  for (const c of ['OE0QXA', 'OE0QXB', 'OE0QXC']) await checkIn(page, c);
  await page.locator('#tab-control').click();
  await page.getByRole('combobox', { name: 'Status of OE0QXB' }).selectOption('out');
  await page.getByRole('combobox', { name: 'Status of OE0QXC' }).selectOption('listening');
  await expect(page.locator('#roster li', { hasText: 'OE0QXB' })).toHaveClass(/st-out/);
  await expect(page.locator('#order-list li', { hasText: 'OE0QXB' })).toHaveClass(/st-out/);
  await expect(page.locator('#roster li', { hasText: 'OE0QXB' }).locator('.call')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.locator('#order-list li', { hasText: 'OE0QXB' }).locator('.open')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.locator('#roster li', { hasText: 'OE0QXC' }).locator('.pill.st')).toHaveAttribute('title', 'monitoring (listening only)');
  await expect(page.locator('#order-list li', { hasText: 'OE0QXC' }).locator('.st-mark')).toHaveText('🎧');
  // j/k skip the checked-out station
  await page.locator('#roster button.person', { hasText: 'OE0QXA' }).focus();
  await page.keyboard.press('j');
  await expect(page.locator('#roster button.person', { hasText: 'OE0QXC' })).toBeFocused();
  // "me" set from the Net Control list
  await page.getByRole('button', { name: 'This is me: OE0QXA' }).click();
  await expect(page.locator('#session-line')).toContainText('me: OE0QXA');
  await expect(page.locator('#roster li', { hasText: 'OE0QXA' }).locator('.pill.own')).toHaveText('me');
});

test('"." moves the net on; j/k only move in the list; the panel and tabs keep their size', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page, { own: 'OE0QXA' });
  for (const c of ['OE0QXN', 'OE0QXA', 'OE0QXB', 'OE0QXC']) await checkIn(page, c);
  await page.locator('#roster button.person', { hasText: 'OE0QXN' }).click();
  await page.locator('#btn-ncs').click();
  await page.locator('#roster button.person', { hasText: 'OE0QXB' }).focus();
  const size = () => page.evaluate(() => {
    const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return [Math.round(b.y + scrollY), Math.round(b.height)]; };
    return { panel: r('#speak-panel'), next: r('#btn-next'), tabs: [...document.querySelectorAll('.viewbar a')].map(a => Math.round(a.getBoundingClientRect().x)) };
  });
  const first = await size();
  await page.keyboard.press('j');
  await expect(page.locator('#roster li.on-air .call')).toHaveText('OE0QXN'); // j moved nothing on
  for (const call of ['OE0QXA', 'OE0QXN', 'OE0QXB']) {
    await page.locator('#roster button.person').first().focus();
    await page.keyboard.press('.');
    await expect(page.locator('#roster li.on-air .call')).toHaveText(call);
    // the station opens ready for notes (my own turn opens My Turn)
    if (call !== 'OE0QXA') await expect(page.locator('#station-rounds .composer-text')).toBeFocused();
    expect(await size()).toEqual(first);
  }
});

test('export: stations and notes as CSV, check-ins as ADIF (what is left out listed), a printable report', async ({ page }) => {
  await open(page, { lang: 'en' });
  await startSession(page);
  for (const [c, n] of [['OE0QXN', 'Nora'], ['OE0QXA', 'Anna'], ['OE0QX?', '']]) await checkIn(page, c, n);
  await page.locator('#roster button.person', { hasText: 'OE0QXN' }).click();
  await page.locator('#btn-ncs').click();
  await page.locator('#roster button.person', { hasText: 'OE0QXA' }).click();
  await page.locator('#station-rounds .composer-text').fill('asks about the antenna');
  await page.locator('#station-rounds .composer-text').press('Enter');
  await expect(page.locator('#st-save')).toContainText('saved');
  await page.locator('#tab-control').click();
  // nothing says which frequency or mode yet
  await expect(page.locator('#export-issues')).toContainText('No mode');
  await expect(page.locator('#export-issues')).toContainText('No frequency');
  await expect(page.locator('#export-issues')).toContainText('OE0QX?: partial callsign, left out');
  await page.locator('#se-repeater').fill('OE0XQR 438.950');
  await page.locator('#se-repeater').press('Tab');
  await page.locator('#se-mode').selectOption('FM');
  await expect(page.locator('#export-issues')).not.toContainText('No mode');
  await expect(page.locator('#export-issues')).not.toContainText('No frequency');
  const save = async button => {
    const dl = page.waitForEvent('download');
    await page.locator(button).click();
    const d = await dl;
    return { name: d.suggestedFilename(), text: (await readFile(await d.path(), 'utf8')) };
  };
  const st = await save('#btn-export-stations');
  expect(st.name).toMatch(/^\d{4}-\d\d-\d\d_netlog_stations\.csv$/);
  expect(st.text.split('\r\n')[1]).toMatch(/^OE0QXN;Nora;;;active \(checked in\);NCS;\d{4}-\d\d-\d\d;\d\d:\d\d:\d\d;exact;/);
  const notes = await save('#btn-export-notes');
  expect(notes.text).toContain(';OE0QXA;Anna;asks about the antenna;');
  const adi = await save('#btn-export-adif');
  expect(adi.name).toMatch(/_log\.adi$/);
  expect(adi.text).toContain('<CALL:6>OE0QXN');
  expect(adi.text).toContain('<CALL:6>OE0QXA');
  expect(adi.text).not.toContain('OE0QX?');
  expect(adi.text).toContain('<MODE:2>FM');
  expect(adi.text).toContain('<BAND:4>70cm');
  expect(adi.text).not.toContain('antenna');
  // the report: print is stubbed, the content checked
  await page.evaluate(() => { window.print = () => { globalThis.__printed = true; }; });
  await page.locator('#btn-export-print').click();
  await expect.poll(() => page.evaluate(() => globalThis.__printed === true)).toBe(true);
  await expect(page.locator('#print-report h1')).toHaveText('Netlog · ad-hoc session');
  await expect(page.locator('#print-report table tbody tr')).toHaveCount(3);
  await expect(page.locator('#print-report .rp-round')).toContainText('asks about the antenna');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#print-report')).toBeHidden();
});
