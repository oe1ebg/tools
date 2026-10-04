import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCall, isPlausibleCall, parseUtcInput, splitUtc, bandForMHz,
  checkinNumbers, previousCheckins, stats, lineFrequencies, headerSnapshot,
} from '../docs/confirm/js/model.js';

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
