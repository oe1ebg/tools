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
