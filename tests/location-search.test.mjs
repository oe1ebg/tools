// Ranking behaviour on a small synthetic dataset (always runs), plus the
// brief's examples against the real generated data when it has been built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildLocationIndex, locate, lookupCoordinates, lookupMaidenhead } from '../tools/shared/js/location/index.js';

function synthetic() {
  const S = 1e5, B = (v, base) => Math.round((v - base) * S);
  const plz = ['1090', '1100', '1180', '1190', '1220'];
  const rows = [
    // street, hn, plz, district, lat, lon
    ['Kahlenberger Straße', '1', '1190', 19, 48.2700, 16.3500],
    ['Quellenstraße', '10', '1100', 10, 48.1750, 16.3700],
    ['Quellenstraße', '12', '1100', 10, 48.1752, 16.3710],
    ['Quellenstraße', '40-44', '1100', 10, 48.1760, 16.3750],
    ['Quellenstraße', '', '1100', 10, 48.1755, 16.3720],
    ['Währinger Straße', '42', '1090', 9, 48.2200, 16.3550],
    ['Währinger Straße', '42A', '1090', 9, 48.2201, 16.3551],
    ['Währinger Straße', '150', '1180', 18, 48.2280, 16.3350],
    ['Wagramer Straße', '5', '1220', 22, 48.2350, 16.4200],
  ];
  const streets = [];
  rows.forEach((r, i) => {
    if (!streets.length || streets.at(-1)[0] !== r[0]) streets.push([r[0], i, 0]);
    streets.at(-1)[2]++;
  });
  return {
    scale: S, latBase: 48, lonBase: 16, plz, streets,
    hn: rows.map(r => r[1]), ap: rows.map(r => plz.indexOf(r[2])), ad: rows.map(r => r[3]),
    alat: rows.map(r => B(r[4], 48)), alon: rows.map(r => B(r[5], 16)),
    places: [
      ['Donauturm', 'tourism=attraction', B(48.2404, 48), B(16.4098, 16), []],
      ['Kahlenberg', 'natural=peak', B(48.2742, 48), B(16.3330, 16), []],
      ['Kahlenbergerdorf', 'place=suburb', B(48.2800, 16.3550 - 16 + 48), B(16.3550, 16), []],
      ['Vienna International Centre', 'landmark', B(48.2347, 48), B(16.4162, 16), ['VIC', 'UNO City']],
    ],
    districts: [[9, ['Alsergrund']], [10, ['Favoriten']], [18, ['Währing']], [19, ['Döbling']], [22, ['Donaustadt']]],
    aliases: [['DI', 'place', 0]],
    meta: {},
  };
}
const idx = buildLocationIndex(synthetic());
const top = (q, o) => locate(idx, q, o).results[0];

test('exact address -> PLZ, coordinates, 6-char locator', () => {
  const r = top('Währinger Straße 42');
  assert.equal(r.type, 'address');
  assert.equal(r.houseNumber, '42');
  assert.equal(r.postcode, '1090');
  assert.equal(r.maidenhead.length, 6);
  assert.equal(r.confidence, 'exact');
  assert.equal(top('Waehringerstr. 42a').houseNumber, '42A');
});

test('house number inside a range, and nearest number when missing', () => {
  assert.equal(top('Quellenstraße 42').houseNumber, '40-44');
  const r = top('Quellenstraße 14');
  assert.equal(r.houseNumber, '12');
  assert.match(r.note, /nicht gefunden/);
  assert.notEqual(r.confidence, 'exact');
});

test('misspelled street finds the canonical street', () => {
  for (const q of ['Wahringerstrase', 'Waehringerstr', 'Währinger Str.']) assert.equal(top(q).street, 'Währinger Straße', q);
});

test('PLZ evidence outranks other sections; contradictory PLZ is penalized', () => {
  const r = locate(idx, '1180 Waehringerstr').results;
  assert.equal(r[0].postcode, '1180');
  assert.ok(r[0].score > r.find(x => x.postcode === '1090').score);
  assert.equal(top('1100 Quellenstr').confidence, 'exact');
  assert.equal(top('1220 Quellenstraße').evidence.postcodeMatch, false);
  assert.notEqual(top('1220 Quellenstraße').confidence, 'exact');
});

test('district name narrows the search', () => {
  const r = top('Favoriten Quellenstr');
  assert.equal(r.street, 'Quellenstraße');
  assert.equal(r.evidence.districtMatch, true);
});

test('POIs, aliases, and ambiguous names', () => {
  assert.equal(top('Donauturm').label, 'Donauturm');
  assert.equal(top('DI').label, 'Donauturm', 'alias resolves');
  assert.equal(top('VIC').label, 'Vienna International Centre');
  assert.equal(top('UNO City').label, 'Vienna International Centre');
  const k = locate(idx, 'Kahlenberg');
  assert.equal(k.results[0].label, 'Kahlenberg');
  assert.ok(k.results.length > 1, 'similar names are offered too');
  assert.equal(k.autoSelect, null, 'not auto-selected with a close competitor far away');
  assert.equal(locate(idx, 'Kahlenberg 1190').autoSelect?.label, 'Kahlenberg');
});

test('locator evidence re-ranks; locator-only input gives the area', () => {
  const near = locate(idx, 'Wagramer Straße JN88ff').results[0];
  assert.equal(near.evidence.locatorMatch, true);
  const m = locate(idx, 'JN88ee').results[0];
  assert.equal(m.type, 'maidenhead');
  assert.equal(m.maidenhead, 'JN88ee');
  const info = lookupMaidenhead(idx, 'JN88ee');
  assert.ok(info.postalCodes.some(p => p.postcode === '1100'));
  assert.equal(info.precision, 6);
});

test('PLZ-only and district-only input give the area (Vienna data only)', () => {
  const p = top('1190');
  assert.equal(p.type, 'postcode');
  assert.equal(p.label, '1190 Wien');
  assert.equal(p.confidence, 'likely');
  const d = top('22. Bezirk');
  assert.equal(d.type, 'district');
  assert.equal(d.district, 22);
  assert.equal(d.postcode, '1220');
});

test('coordinates -> nearest PLZ', () => {
  const c = lookupCoordinates(idx, 48.1751, 16.3705);
  assert.equal(c.postcode, '1100');
  assert.ok(c.nearestAddressDistanceMeters < 100);
  const far = lookupCoordinates(idx, 47.0, 15.0);
  assert.equal(far.postcode, null);
  assert.equal(top('48.1751, 16.3705').postcode, '1100');
});

test('weak fuzzy matches are never auto-selected', () => {
  const r = locate(idx, 'Quolanstrse');
  assert.ok(!r.autoSelect || r.autoSelect.confidence !== 'low');
  assert.equal(locate(idx, 'xyzzy').results.length, 0);
});

// --- real data -------------------------------------------------------
const realPath = new URL('../tools/confirm/data/vienna-locations.json', import.meta.url);
const haveReal = existsSync(realPath);
test('real data: brief examples', { skip: !haveReal && 'run `just build-location` first' }, () => {
  const real = buildLocationIndex(JSON.parse(readFileSync(realPath, 'utf8')));
  const R = q => locate(real, q);
  const a = R('Währinger Straße 42').results[0];
  assert.equal(a.street, 'Währinger Straße');
  assert.ok(a.houseNumber.startsWith('40') || a.houseNumber.startsWith('42'));
  assert.equal(a.confidence, 'exact');
  // Same canonical street for spelling variants.
  for (const q of ['Waehringerstr', 'Wahringerstrase', 'Währinger Str.']) assert.equal(R(q).results[0].street, 'Währinger Straße', q);
  const q1 = R('1100 Quellenstr').results[0];
  assert.equal(q1.street, 'Quellenstraße');
  assert.equal(q1.postcode, '1100');
  assert.equal(R('Favoriten Quellenstr').results[0].district, 10);
  for (const [q, label] of [['Donauturm', 'Donauturm'], ['Kahlenberg', 'Kahlenberg'], ['Stephansplatz', 'Stephansplatz'],
    ['VIC', 'Vienna International Centre'], ['UNO City', 'Vienna International Centre'], ['AKH', 'AKH Wien']]) {
    assert.equal(R(q).results[0].label, label, q);
  }
  assert.equal(R('Kahlenberg 1190').autoSelect?.label, 'Kahlenberg');
  assert.ok(R('Donauinsel JN88ge').results[0].label.startsWith('Donauinsel'));
  const c = R('48.2083, 16.3731').results[0];
  assert.equal(c.postcode, '1010');
  assert.equal(c.maidenhead, 'JN88ee');
  const m = lookupMaidenhead(real, 'JN88ee');
  assert.ok(m.postalCodes.length > 3, 'a subsquare spans several PLZ');
  // performance target (desktop): < 100 ms per lookup
  const t = performance.now();
  for (const q of ['Wahringerstrase 42', 'Favoriten Quellenstr', 'Donauinsel JN88ge', 'Kahlenberg']) R(q);
  assert.ok((performance.now() - t) / 4 < 100);
});

test('autoSelect levels: unknown level never auto-selects', () => {
  assert.ok(locate(idx, 'Donauturm', { autoSelect: 'likely' }).autoSelect);
  assert.equal(locate(idx, 'Donauturm', { autoSelect: 'none' }).autoSelect, null);
  assert.equal(locate(idx, 'Donauturm', { autoSelect: 'never' }).autoSelect, null);
});
