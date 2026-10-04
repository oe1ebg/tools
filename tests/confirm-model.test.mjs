process.env.TZ = 'Europe/Vienna'; // local-time tests assume Vienna (CET/CEST)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCall, isPlausibleCall, parseUtcInput, splitUtc, bandForMHz,
  checkinNumbers, previousCheckins, stats, lineFrequencies, headerSnapshot,
  splitTime, zoneLabel, isoUtc, isoWithOffset, parseTimeInput,
} from '../tools/confirm/js/model.js';

test('normalizeCall uppercases and strips junk', () => {
  assert.equal(normalizeCall(' oe1ebg '), 'OE1EBG');
  assert.equal(normalizeCall('oe 1 x k s'), 'OE1XKS');
  assert.equal(normalizeCall('dl/oe1ebg/p'), 'DL/OE1EBG/P');
  assert.equal(normalizeCall('oe1-ebg!'), 'OE1EBG');
});

test('isPlausibleCall', () => {
  for (const c of ['OE1EBG', 'OE1XKS', 'OE3A', 'DL1ABC', 'OE1EBG/P', 'HB9/OE1EBG', 'K1A', '9A1AA', 'OE18M']) {
    assert.ok(isPlausibleCall(c), c);
  }
  for (const c of ['', 'OE', '12345', 'OEEBG', 'ABCDEFGHIJ']) assert.ok(!isPlausibleCall(c), c);
});

test('parseUtcInput validates and returns ISO UTC', () => {
  assert.equal(parseUtcInput('2026-10-04 19:42'), '2026-10-04T19:42:00.000Z');
  assert.equal(parseUtcInput('2026-10-04T07:05:09'), '2026-10-04T07:05:09.000Z');
  assert.equal(parseUtcInput('2026-02-30 10:00'), null);
  assert.equal(parseUtcInput('2026-10-04 25:00'), null);
  assert.equal(parseUtcInput('gestern'), null);
});

test('splitUtc', () => {
  assert.deepEqual(splitUtc('2026-10-04T19:42:07.123Z'), { date: '2026-10-04', time: '19:42:07' });
  assert.deepEqual(splitUtc('nope'), { date: '', time: '' });
});

test('bandForMHz', () => {
  assert.equal(bandForMHz(145.5), '2m');
  assert.equal(bandForMHz(438.95), '70cm');
  assert.equal(bandForMHz(3.65), '80m');
  assert.equal(bandForMHz(100), '');
  assert.equal(bandForMHz(null), '');
});

const E = (id, call, ts, extra = {}) => ({ id, call, ts, seq: Number(id.slice(1)), ...extra });

test('checkin numbers follow time order and skip deleted lines', () => {
  const entries = [
    E('e1', 'OE1AAA', '2026-10-04T19:00:00Z'),
    E('e2', 'OE1BBB', '2026-10-04T19:01:00Z'),
    E('e3', 'OE1AAA', '2026-10-04T19:05:00Z', { deleted: '2026-10-04T19:06:00Z' }),
    E('e4', 'OE1AAA', '2026-10-04T19:10:00Z'),
    E('e5', 'OE1AAA', '2026-10-04T18:59:00Z'), // corrected time: earlier than e1
  ];
  const n = checkinNumbers(entries);
  assert.equal(n.get('e5'), 1);
  assert.equal(n.get('e1'), 2);
  assert.equal(n.get('e4'), 3);
  assert.equal(n.get('e2'), 1);
  assert.equal(n.has('e3'), false);
  assert.deepEqual(previousCheckins(entries, 'OE1AAA', 'e4').map(e => e.id), ['e5', 'e1']);
  assert.deepEqual(stats(entries), { total: 4, unique: 2 });
});

test('line frequencies: repeater uses output + shift', () => {
  const snap = headerSnapshot({ freq: '145.500', repeaterFreq: '438.950', repeaterShift: '-7.6' });
  assert.deepEqual(lineFrequencies({ viaRepeater: true, snap }), { tx: 431.35, rx: 438.95 });
  assert.deepEqual(lineFrequencies({ viaRepeater: false, snap }), { tx: 145.5, rx: null });
  const noOut = headerSnapshot({ freq: '145,6' });
  assert.deepEqual(lineFrequencies({ viaRepeater: true, snap: noOut }), { tx: 145.6, rx: 145.6 });
});

test('time display modes; storage stays ISO UTC', () => {
  const summer = '2026-10-04T19:42:07.123Z', winter = '2026-12-24T23:30:00.000Z';
  assert.deepEqual(splitTime(summer, 'utc'), { date: '2026-10-04', time: '19:42:07' });
  assert.deepEqual(splitTime(summer, 'local'), { date: '2026-10-04', time: '21:42:07' });
  assert.deepEqual(splitTime(winter, 'local'), { date: '2026-12-25', time: '00:30:00' }, 'date rolls over in local time');
  assert.equal(zoneLabel(summer, 'utc'), 'UTC');
  assert.equal(zoneLabel(summer, 'local'), 'UTC+2');
  assert.equal(zoneLabel(winter, 'local'), 'UTC+1');
  assert.equal(isoUtc(summer), '2026-10-04T19:42:07Z');
  assert.equal(isoWithOffset(summer), '2026-10-04T21:42:07+02:00');
  assert.equal(isoWithOffset(winter), '2026-12-25T00:30:00+01:00');
});

test('typed corrections are interpreted in the display mode', () => {
  const base = '2026-10-04T19:42:07.000Z'; // 21:42 local
  assert.equal(parseTimeInput('19:30', 'utc', base), '2026-10-04T19:30:00.000Z');
  assert.equal(parseTimeInput('21:30', 'local', base), '2026-10-04T19:30:00.000Z');
  assert.equal(parseTimeInput('2026-10-04 21:30:15', 'local', base), '2026-10-04T19:30:15.000Z');
  assert.equal(parseTimeInput('2026-12-25 00:30', 'local', base), '2026-12-24T23:30:00.000Z');
  // HH:MM uses the base date *in that mode*: 23:30 UTC on Dec 24 is Dec 25 locally.
  assert.equal(parseTimeInput('00:45', 'local', '2026-12-24T23:30:00.000Z'), '2026-12-24T23:45:00.000Z');
  assert.equal(parseTimeInput('2026-03-29 02:30', 'local', base), null, 'skipped by DST');
  assert.equal(parseTimeInput('2026-02-30 10:00', 'utc', base), null);
  assert.equal(parseTimeInput('25:00', 'utc', base), null);
  assert.equal(parseTimeInput('gestern', 'local', base), null);
});

test('templates: transitive visibility and platform-dependent version options', async () => {
  const { templateFor, fieldVisible, currentOptions, fieldDisplay } = await import('../tools/confirm/js/templates.js');
  const tpl = templateFor('zivilschutz');
  const f = k => tpl.fields.find(x => x.key === k);
  assert.ok(fieldVisible(f('os_version'), { atalert: 'nein', platform: 'ios' }, tpl));
  assert.ok(!fieldVisible(f('os_version'), { atalert: 'ja', platform: 'ios' }, tpl), 'hidden when its parent is hidden');
  assert.ok(!fieldVisible(f('os_version'), { atalert: 'nein', platform: 'andere' }, tpl));
  assert.ok(currentOptions(f('os_version'), { platform: 'ios' }).every(o => o[0].startsWith('ios')));
  assert.ok(currentOptions(f('os_version'), { platform: 'android' }).some(o => o[1] === 'Android 16'));
  assert.equal(fieldDisplay(f('os_version'), 'ios26'), 'iOS 26');
  assert.deepEqual(['siren_closed', 'siren_open', 'siren_outside'].map(k => f(k).options.map(o => o[0]).join('')), ['12345', '12345', '12345']);
});

test('templates: short summary for map cards', async () => {
  const { templateFor, shortSummary } = await import('../tools/confirm/js/templates.js');
  const z = templateFor('zivilschutz');
  assert.equal(shortSummary(z, { address: 'Stephansplatz 1', plz: '1010', siren_closed: '2', siren_open: '1', siren_outside: '1', atalert: 'nein', platform: 'android', os_version: 'android14' }),
    'Sirene zu 2 offen 1 außen 1 · AT-Alert nicht erhalten · Android 14');
  assert.equal(shortSummary(z, { siren_outside: '3', atalert: 'ja', platform: 'ios', os_version: 'ios17' }),
    'Sirene außen 3 · AT-Alert erhalten', 'hidden platform/version are left out');
  assert.equal(shortSummary(z, { atalert: 'nein', platform: 'andere' }), 'AT-Alert nicht erhalten · andere');
  assert.equal(shortSummary(templateFor('rst'), { rst_rcvd: '59', rst_sent: '57', name: 'Franz', qth: 'Wien' }), 'erh. 59 · geg. 57 · Franz');
  assert.equal(shortSummary(templateFor('calls'), { qth: 'Wien' }), '');
});
