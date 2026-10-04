import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationOptions } from '../content/confirm/js/locfield.js';

const loc = {
  type: 'address', label: 'Quellenstraße 10', street: 'Quellenstraße', houseNumber: '10',
  postcode: '1100', district: 10, lat: 48.17, lon: 16.37, maidenhead: 'JN88ee',
  source: 'vienna-ogd', confidence: 'exact', manual: true, input: 'Quellenstr 10',
};
const rec = { call: 'OE1EBG', loc, at: '2026-09-27T19:42:07Z', eventTitle: 'Rundspruch' };

test('locationOptions: last location first, then the callsign-list city', () => {
  const opts = locationOptions(rec, '1030 Wien');
  assert.equal(opts.length, 2);
  assert.equal(opts[0].label, 'zuletzt: Quellenstraße 10');
  assert.equal(opts[0].loc, loc);
  assert.match(opts[0].detail, /^27\.09\.2026 · /);
  assert.equal(opts[1].text, '1030 Wien');
  assert.equal(opts[1].loc, undefined);
});

test('locationOptions: no record, no city', () => {
  assert.deepEqual(locationOptions(null, ''), []);
  assert.deepEqual(locationOptions(undefined, undefined), []);
  const onlyCity = locationOptions(null, ' Mödling ');
  assert.equal(onlyCity.length, 1);
  assert.equal(onlyCity[0].text, 'Mödling');
  const onlyRec = locationOptions(rec, '');
  assert.equal(onlyRec.length, 1);
  assert.ok(onlyRec[0].loc);
});

test('locationOptions: city equal to the last location is not offered twice', () => {
  assert.equal(locationOptions(rec, 'quellenstraße 10').length, 1);
  assert.equal(locationOptions(rec, 'Quellenstr 10').length, 1); // the originally typed text
});
