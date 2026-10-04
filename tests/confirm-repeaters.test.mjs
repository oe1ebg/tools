import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildRepeaterIndex, searchRepeaters, headerFromRepeater, formatShift, formatMHz, positionFromLocator } from '../content/confirm/js/repeaters.js';
import { emptyHeader } from '../content/confirm/js/model.js';

const R = (call, site, city, lat, lon, band, out, inp, modes, extra = {}) =>
  ({ call, site, city, lat, lon, locator: '', band, out, in: inp, shift: Math.round((inp - out) * 1e4) / 1e4, ctcss: null, modes, status: 'active', ...extra });
const idx = buildRepeaterIndex({ retrieved: '2026-10-04', repeaters: [
  R('OE1XUU', 'Kahlenberg', 'Wien', 48.276, 16.333, '70cm', 438.95, 431.35, ['FM'], { ctcss: 162.2 }),
  R('OE1XKS', 'Laaerberg', 'Wien', 48.169, 16.384, '2m', 145.6, 145.0, ['FM', 'C4FM']),
  R('OE1XDS', 'AKH', 'Wien', 48.22, 16.347, '70cm', 438.525, 430.925, ['DMR']),
  R('OE3XSA', 'Sandl', 'Krems', 48.433, 15.471, '2m', 145.7, 145.1, ['FM'], { ctcss: 162.2 }),
  R('OE7XZT', 'Ahorn', 'Mayrhofen', 47.137, 11.869, '70cm', 438.95, 431.35, ['FM']),
  R('OE8XYZ', 'Planned', 'Villach', 46.6, 13.85, '70cm', 439.0, 431.4, ['FM'], { status: 'planned' }),
]});
const calls = (q, o) => searchRepeaters(idx, q, o).map(h => h.r.call);

test('search by callsign (full, prefix, suffix)', () => {
  assert.equal(calls('OE1XUU')[0], 'OE1XUU');
  assert.equal(calls('oe1xuu')[0], 'OE1XUU');
  assert.deepEqual(calls('OE1X').sort(), ['OE1XDS', 'OE1XKS', 'OE1XUU']);
  assert.equal(calls('xuu')[0], 'OE1XUU');
});

test('search by site / town (umlaut-insensitive)', () => {
  assert.equal(calls('Kahlenberg')[0], 'OE1XUU');
  assert.equal(calls('krems')[0], 'OE3XSA');
  assert.equal(calls('Laaer')[0], 'OE1XKS');
});

test('search by frequency (output or input) and filters', () => {
  assert.deepEqual(calls('438.95').sort(), ['OE1XUU', 'OE7XZT']);
  assert.deepEqual(calls('431.35').sort(), ['OE1XUU', 'OE7XZT'], 'input frequency matches too');
  assert.deepEqual(calls('438,525'), ['OE1XDS']);
  assert.deepEqual(calls('145').sort(), ['OE1XKS', 'OE3XSA'], 'integer = whole MHz');
  assert.deepEqual(calls('Wien dmr'), ['OE1XDS']);
  assert.deepEqual(calls('2m wien'), ['OE1XKS']);
  assert.deepEqual(calls('c4fm'), ['OE1XKS']);
});

test('nearest first with a position; locator token as position', () => {
  const near = searchRepeaters(idx, '438.95', { position: positionFromLocator('JN57WD') });
  assert.equal(near[0].r.call, 'OE7XZT');
  assert.ok(near[0].distKm < 10);
  assert.equal(calls('438.95 JN88ef')[0], 'OE1XUU');
  assert.equal(calls('', { position: positionFromLocator('JN78RK') })[0], 'OE3XSA');
  assert.equal(calls('').length, 6, 'empty query lists all (UI shows a hint instead)');
});

test('inactive/planned repeaters rank lower', () => {
  const all = calls('');
  assert.equal(all.at(-1), 'OE8XYZ');
});

test('headerFromRepeater fills frequencies, shift, tone, mode', () => {
  const h = { ...emptyHeader(), mode: 'DMR' };
  const n = headerFromRepeater(idx.list.find(r => r.call === 'OE1XUU'), h);
  assert.equal(n.viaRepeater, true);
  assert.equal(n.repeaterCall, 'OE1XUU');
  assert.equal(n.repeaterFreq, '438.950');
  assert.equal(n.repeaterShift, '-7.6');
  assert.equal(n.repeaterTone, '162.2');
  assert.equal(n.mode, 'FM', 'switches to a mode the repeater supports');
  assert.equal(n.freq, '438.950', 'empty direct frequency is filled');
  const keep = headerFromRepeater(idx.list.find(r => r.call === 'OE1XKS'), { ...emptyHeader(), mode: 'C4FM', freq: '145.500' });
  assert.equal(keep.mode, 'C4FM');
  assert.equal(keep.freq, '145.500');
  assert.equal(keep.repeaterTone, '');
});

test('formatting', () => {
  assert.equal(formatShift(-7.6), '−7.6');
  assert.equal(formatShift(0.6), '+0.6');
  assert.equal(formatShift(0), 'simplex');
  assert.equal(formatMHz(438.95), '438.950');
  assert.equal(formatMHz(145.6125), '145.6125');
});

const real = new URL('../content/confirm/data/repeaters-at.json', import.meta.url);
test('generated repeater list is plausible', { skip: !existsSync(real) && 'run `just fetch-repeaters` first' }, () => {
  const data = JSON.parse(readFileSync(real, 'utf8'));
  assert.ok(data.repeaters.length > 100);
  const ri = buildRepeaterIndex(data);
  for (const p of ['OE1', 'OE3', 'OE5', 'OE6', 'OE7', 'OE8']) assert.ok(ri.list.some(r => r.call.startsWith(p)), `${p} present`);
  for (const r of ri.list) {
    assert.ok(r.out > 28 && r.out < 10500, r.call); // up to 13cm/3cm
    assert.ok(r.lat > 46 && r.lat < 49.1 && r.lon > 9.4 && r.lon < 17.2, `${r.call} inside Austria`);
    assert.ok(['active', 'planned', 'inactive'].includes(r.status));
  }
  const xuu = searchRepeaters(ri, 'OE1XUU')[0].r;
  assert.equal(xuu.out, 438.95);
  assert.equal(xuu.shift, -7.6);
});

test('GHz repeaters are searchable by frequency', () => {
  const g = buildRepeaterIndex({ repeaters: [R('OE1XQU', 'Wienerberg', 'Wien', 48.168, 16.345, '13cm', 2449.6, 2400.6, ['FM'])] });
  assert.equal(searchRepeaters(g, '2449.6')[0]?.r.call, 'OE1XQU');
});
