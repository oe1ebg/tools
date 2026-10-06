import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latLonToMaidenhead, maidenheadToBounds, isValidLocator, isLocatorPrefix, formatLocator } from '../tools/shared/js/maidenhead.js';

test('known locators', () => {
  assert.equal(latLonToMaidenhead(48.2083, 16.3731, 6), 'JN88ee');   // Stephansplatz
  assert.equal(latLonToMaidenhead(41.714775, -72.72726, 6), 'FN31pr'); // W1AW
  assert.equal(latLonToMaidenhead(-33.8688, 151.2093, 6), 'QF56od');  // Sydney
  assert.equal(latLonToMaidenhead(48.2083, 16.3731, 4), 'JN88');
  assert.equal(latLonToMaidenhead(48.2083, 16.3731, 2), 'JN');
  assert.equal(latLonToMaidenhead(48.2083, 16.3731, 8).length, 8);
  assert.equal(latLonToMaidenhead(48.2083, 16.3731, 10).length, 10);
});

test('round trip: point lies inside its locator box', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 2000; k++) {
    const lat = rnd() * 180 - 90, lon = rnd() * 360 - 180;
    for (const p of [2, 4, 6, 8, 10]) {
      const b = maidenheadToBounds(latLonToMaidenhead(lat, lon, p));
      assert.ok(lat >= b.south && lat < b.north && lon >= b.west && lon < b.east, `${lat},${lon} p${p}`);
    }
  }
});

test('boundaries', () => {
  assert.equal(latLonToMaidenhead(-90, -180, 6), 'AA00aa');
  assert.equal(latLonToMaidenhead(90, 180, 6), 'RR99xx');
  assert.equal(latLonToMaidenhead(89.99999, 179.99999, 4), 'RR99');
  assert.equal(latLonToMaidenhead(91, 0), '');
  assert.equal(latLonToMaidenhead(0, 181), '');
});

test('bounds and center of JN88ee', () => {
  const b = maidenheadToBounds('jn88EE');
  assert.equal(b.precision, 6);
  assert.ok(Math.abs(b.west - 16 - 4 / 12) < 1e-9 && Math.abs(b.east - 16 - 5 / 12) < 1e-9);
  assert.ok(Math.abs(b.south - 48 - 4 / 24) < 1e-9 && Math.abs(b.north - 48 - 5 / 24) < 1e-9);
  assert.ok(Math.abs(b.centerLat - 48.1875) < 1e-9 && Math.abs(b.centerLon - 16.375) < 1e-9);
});

test('validation', () => {
  for (const ok of ['JN', 'JN88', 'jn88ee', 'JN88ee12', 'JN88ee12ab']) assert.ok(isValidLocator(ok), ok);
  for (const bad of ['', 'J', 'JN8', 'JN88e', 'SN88', 'JN88yy', 'JNAA', 'JN88ee1', '1234']) assert.ok(!isValidLocator(bad), bad);
  assert.ok(isLocatorPrefix('JN88e'));
  assert.ok(isLocatorPrefix('JN8'));
  assert.ok(!isLocatorPrefix('Donau'));
  assert.equal(formatLocator('jn88EE12ab'), 'JN88ee12ab');
});

test('full length up to 20 characters (digit/letter pairs alternate)', () => {
  const full = 'JN88EE05UO43UF06QD23';
  assert.ok(isValidLocator(full));
  assert.ok(isValidLocator(full.toLowerCase()));
  for (let n = 2; n <= 20; n += 2) assert.ok(isValidLocator(full.slice(0, n)), full.slice(0, n));
  assert.ok(!isValidLocator(full + 'AA'), 'longer than 20');
  assert.ok(!isValidLocator('JN88EE05UO4AUF'), 'letter where a digit belongs');
  assert.ok(!isValidLocator('JN88EE05UY'), 'Y is no subsquare letter');
  assert.ok(isLocatorPrefix('JN88EE05UO43U'));
  assert.ok(!isLocatorPrefix('JN88EE05UO4X'));
  assert.equal(formatLocator(full), 'JN88ee05uo43uf06qd23');
  // round trip through the center at every length
  for (let n = 2; n <= 20; n += 2) {
    const b = maidenheadToBounds(full.slice(0, n));
    assert.equal(b.precision, n);
    assert.equal(latLonToMaidenhead(b.centerLat, b.centerLon, n).toUpperCase(), full.slice(0, n), `length ${n}`);
  }
  // 20 characters: a cell of about 6e-10° (well under a millimetre)
  const b = maidenheadToBounds(full);
  assert.ok(b.east - b.west < 1e-9 && b.north - b.south < 1e-9);
  // nests inside its 10-character parent
  const p = maidenheadToBounds(full.slice(0, 10));
  assert.ok(b.west >= p.west && b.east <= p.east && b.south >= p.south && b.north <= p.north);
  assert.equal(latLonToMaidenhead(48.2082, 16.3738, 20).length, 20);
});
