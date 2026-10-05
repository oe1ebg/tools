// tools/shared/js/geo.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters } from '../tools/shared/js/geo.js';

test('distanceMeters: known distances, symmetric, zero', () => {
  // Stephansdom -> Schneeberg (Klosterwappen), about 65 km
  const d = distanceMeters(48.2085, 16.3731, 47.7675, 15.8072);
  assert.ok(Math.abs(d - 64950) < 500, String(d));
  assert.equal(distanceMeters(48.2, 16.4, 48.2, 16.4), 0);
  assert.equal(distanceMeters(48, 16, 47, 15), distanceMeters(47, 15, 48, 16));
  // one degree of latitude is ~111.2 km
  assert.ok(Math.abs(distanceMeters(0, 0, 1, 0) - 111195) < 1);
  // antipodes: half the circumference, no NaN from rounding
  assert.ok(Math.abs(distanceMeters(0, 0, 0, 180) - Math.PI * 6371008.8) < 1);
});
