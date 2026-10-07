import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  latLonToUtm, utmToLatLon, utmZoneOf, utmBand, latLonToMgrs, latLonToMgrsParts, formatMgrs, parseMgrs,
  mgrsToBounds, mgrsPrecisionName, mgrsDigitsForSize, mgrsCellSize, utmReference, UTM_DIGITS,
} from '../tools/shared/js/utm.js';
import { distanceMeters } from '../tools/shared/js/geo.js';

// Reference values from PROJ (pyproj 3.7, EPSG:4326 -> EPSG:326zz/327zz):
//   uv run --with pyproj python -c "from pyproj import Transformer; ..."
// [name, lat, lon, zone, easting, northing, UTMREF]
const REF = [
  ['Stephansdom', 48.208493, 16.373118, 33, 602013.958, 5340385.254, '33U XP 02013 40385'],
  ['Bregenz (Vorarlberg, zone 32)', 47.503, 9.747, 32, 556255.79, 5261333.537, '32T NT 56255 61333'],
  ['just west of 12° E', 47.27, 11.99, 32, 726160.774, 5239505.579, '32T QT 26160 39505'],
  ['just east of 12° E', 47.27, 12.01, 33, 273839.226, 5239505.579, '33T TN 73839 39505'],
  ['Kufstein', 47.583, 12.17, 33, 287206.836, 5273835.311, '33T TN 87206 73835'],
  ['Graz', 47.0707, 15.4395, 33, 533369.116, 5213114.503, '33T WN 33369 13114'],
  ['Neusiedl am See', 47.95, 16.85, 33, 638132.537, 5312399.18, '33T XP 38132 12399'],
  ['Sydney (south)', -33.8568, 151.2153, 56, 334900.57, 6252288.753, '56H LH 34900 52288'],
  ['Bergen (32V exception)', 60.39, 5.32, 32, 297230.22, 6700510.175, '32V KN 97230 00510'],
  ['Svalbard (33X exception)', 78.22, 15.65, 33, 514813.527, 8683004.153, '33X WG 14813 83004'],
];

test('UTM matches PROJ within 1 mm', () => {
  for (const [name, lat, lon, zone, e, n] of REF) {
    const u = latLonToUtm(lat, lon);
    assert.equal(u.zone, zone, name);
    assert.ok(Math.abs(u.easting - e) < 0.001, `${name}: E ${u.easting} vs ${e}`);
    assert.ok(Math.abs(u.northing - n) < 0.001, `${name}: N ${u.northing} vs ${n}`);
    const back = utmToLatLon(u.zone, u.hemisphere, e, n);
    assert.ok(distanceMeters(lat, lon, back.lat, back.lon) < 0.001, `${name}: inverse`);
  }
});

test('UTMREF of the reference points (Austrian spaced form)', () => {
  for (const [name, lat, lon, , , , mgrs] of REF) assert.equal(latLonToMgrs(lat, lon), mgrs, name);
  assert.equal(latLonToMgrs(48.208493, 16.373118, 8), '33U XP 0201 4038');
  assert.equal(latLonToMgrs(48.208493, 16.373118, 6), '33U XP 020 403');
  assert.equal(latLonToMgrs(48.208493, 16.373118, 0), '33U XP');
});

test('zone boundary at 12° E and bands in Austria', () => {
  assert.equal(utmZoneOf(47.3, 11.999999), 32);
  assert.equal(utmZoneOf(47.3, 12), 33);
  assert.equal(utmBand(47.9), 'T');
  assert.equal(utmBand(48.0), 'U');
  assert.equal(utmBand(84), 'X');
  assert.equal(utmBand(85), '');
  assert.equal(latLonToUtm(85, 10), null);
  assert.equal(latLonToMgrs(-81, 10), '');
});

test('100 km square boundary (PROJ inverse of 33U 600000/5300000 ± 0.4 m)', () => {
  assert.equal(latLonToMgrs(47.845564788, 16.336596412), '33T XP 00000 00000');
  assert.equal(latLonToMgrs(47.845557717, 16.336585538), '33T WN 99999 99999');
  const b = mgrsToBounds('33T XP 0 0');
  assert.ok(Math.abs(b.south - 47.8455) < 0.003 && Math.abs(b.west - 16.3366) < 0.001, JSON.stringify(b));
});

test('round trip at every precision stays inside the square', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 500; k++) {
    const lat = 46.3 + rnd() * 2.8, lon = 9.5 + rnd() * 7.7; // Austria and around
    for (const d of UTM_DIGITS) {
      const text = latLonToMgrs(lat, lon, d);
      const b = mgrsToBounds(text);
      assert.ok(b, text);
      const dist = distanceMeters(lat, lon, b.centerLat, b.centerLon);
      assert.ok(dist <= mgrsCellSize(d) * Math.SQRT1_2 * 1.001, `${lat},${lon} ${text}: ${dist} m`);
      // Squares cut by a zone or band boundary may have their centre in the next one.
      if (latLonToMgrs(b.centerLat, b.centerLon, 0).startsWith(`${b.zone}${b.band} `)) assert.equal(latLonToMgrs(b.centerLat, b.centerLon, d), text, `centre of ${text}`);
    }
  }
});

test('parse: spaces, case, zone optional', () => {
  const full = parseMgrs('33UXP0201340385');
  assert.equal(full.text, '33U XP 02013 40385');
  assert.equal(full.zoneGiven, true);
  assert.equal(full.digits, 10);
  assert.equal(parseMgrs('33u xp 02013 40385').text, '33U XP 02013 40385');
  assert.equal(parseMgrs('33 U XP 0201 4038').text, '33U XP 0201 4038');
  const short = parseMgrs('XP 0123 5678');
  assert.deepEqual([short.zone, short.band, short.square, short.east, short.north, short.digits, short.zoneGiven],
    [33, 'U', 'XP', '0123', '5678', 8, false]);
  assert.equal(parseMgrs('xp01235678').text, '33U XP 0123 5678');
  // Zone from the reference (own location in zone 32)
  assert.equal(parseMgrs('NT 5625 6133', { zone: 32, band: 'T' }).text, '32T NT 5625 6133');
  assert.equal(parseMgrs('NT 5625 6133'), null, 'N is no column letter in zone 33');
  // The reference band only picks the 2000 km cycle: Klagenfurt is in band T.
  assert.equal(parseMgrs('VM 4681 6369').text, '33T VM 4681 6369');
});

test('parse: rejects what is not a UTMREF', () => {
  for (const s of ['', 'JN88', 'JN88ee', 'XP 012 34', 'XP 1 2', '33U XP 012 3456', '33U XP 0123456789012', 'XI 1234 5678',
    'Hauptstraße 12', '1100', '61U XP 1234 5678', '33U XP 99999']) {
    assert.equal(parseMgrs(s), null, s);
  }
});

test('bounds like maidenheadToBounds', () => {
  const b = mgrsToBounds('33U XP 0201 4038');
  assert.equal(b.precision, 8);
  assert.ok(b.south < 48.208493 && b.north > 48.208493 && b.west < 16.373118 && b.east > 16.373118);
  assert.ok(distanceMeters(b.south, b.west, b.north, b.east) < 20);
  assert.equal(mgrsToBounds('nonsense'), null);
});

test('precision names and digits for an area', () => {
  assert.equal(mgrsPrecisionName(10), '1 m');
  assert.equal(mgrsPrecisionName(8), '10 m');
  assert.equal(mgrsPrecisionName(6), '100 m');
  assert.equal(mgrsPrecisionName(4), '1 km');
  assert.equal(mgrsDigitsForSize(4600), 2);
  assert.equal(mgrsDigitsForSize(15), 6);
  assert.equal(mgrsDigitsForSize(0.5), 10);
});

test('reference zone: own position, else 33U', () => {
  assert.deepEqual(utmReference(47.5, 9.7), { zone: 32, band: 'T' });
  assert.deepEqual(utmReference(48.2, 16.37), { zone: 33, band: 'U' });
  assert.deepEqual(utmReference(undefined, undefined), { zone: 33, band: 'U' });
});

test('formatMgrs / parts', () => {
  const p = latLonToMgrsParts(48.208493, 16.373118, 4);
  assert.deepEqual(p, { zone: 33, band: 'U', square: 'XP', east: '02', north: '40', digits: 4 });
  assert.equal(formatMgrs(p), '33U XP 02 40');
  assert.equal(formatMgrs(null), '');
  assert.equal(latLonToMgrsParts(48, 16, 5), null);
});
