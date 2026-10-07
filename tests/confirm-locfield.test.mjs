import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationOptions, previousLocation, snapshotLocation, describeLocation } from '../tools/shared/js/locfield.js';
import { locOrigin, locOriginText, LOC_ORIGINS, locHints, locNameType } from '../tools/shared/js/locmeta.js';

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

test('location origin: suggestions carry where they come from', () => {
  const opts = locationOptions(rec, '1030 Wien');
  assert.equal(opts[0].at, rec.at);
  assert.equal(opts[1].origin, 'callbook');
});

test('location origin: search result keeps the typed text', () => {
  const r = { type: 'address', label: 'Grinzinger Allee 3', street: 'Grinzinger Allee', houseNumber: '3', postcode: '1190',
    lat: 48.2556, lon: 16.3501, source: 'vienna-ogd', confidence: 'high' };
  const s = snapshotLocation(r, 'beim Heurigen Grinzing', true);
  assert.equal(s.origin, 'search');
  assert.equal(s.input, 'beim Heurigen Grinzing');
  assert.equal(snapshotLocation(r, '', true, 'callbook').origin, 'callbook');
});

test('location origin: taking over an earlier location clears the old typed text', () => {
  const p = previousLocation({ ...loc, origin: 'previous', originAt: '2026-01-01T10:00:00Z' }, rec.at);
  assert.equal(p.origin, 'previous');
  assert.equal(p.originAt, rec.at);
  assert.equal(p.input, '', 'nothing was typed for this line');
  assert.equal(p.label, loc.label);
  assert.equal(p.lat, loc.lat);
  assert.equal(loc.input, 'Quellenstr 10', 'the stored location is not changed');
});

test('location origin: keys, labels and text', () => {
  assert.equal(locOrigin(null, ''), '');
  assert.equal(locOrigin(null, 'irgendwo im Wald'), 'text');
  assert.equal(locOrigin(loc, 'x'), '', 'old data without origin: unknown');
  assert.equal(locOrigin({ ...loc, origin: 'callbook' }), 'callbook');
  assert.equal(locOriginText(previousLocation(loc, rec.at)), 'früheres Log 27.09.2026');
  assert.equal(locOriginText(null, 'Wald'), 'Freitext');
  for (const o of Object.values(LOC_ORIGINS)) assert.ok('label' in o && o.text && o.title);
});

test('name type, matched name and Umland are stored and shown', () => {
  const r = { type: 'poi', label: 'Klinik Landstraße', postcode: '1030', lat: 48.1959, lon: 16.39118, source: 'osm',
    confidence: 'high', matchedName: 'Rudolfstiftung', nameType: 'historical' };
  const s = snapshotLocation(r, 'Rudolfstiftung', false);
  assert.equal(s.matched, 'Rudolfstiftung');
  assert.equal(s.nameType, 'historical');
  assert.deepEqual(locHints(s), ['früher „Rudolfstiftung“']);
  assert.equal(locNameType(s), 'historical');
  const plain = snapshotLocation({ ...r, matchedName: undefined, nameType: undefined }, '', false);
  assert.ok(!('matched' in plain) && !('nameType' in plain), 'nothing extra for an own name');
  assert.equal(locNameType(plain), 'name');
  const u = snapshotLocation({ type: 'poi', label: 'Seegrotte', postcode: '2371', city: 'Hinterbrühl', umland: true,
    lat: 48.0862, lon: 16.2572, source: 'osm', confidence: 'high' }, 'Seegrotte', false);
  assert.match(describeLocation(u), /^Seegrotte, 2371 Hinterbrühl · /);
  assert.deepEqual(locHints(u), ['außerhalb Wiens']);
  assert.deepEqual(locHints({ type: 'intersection', label: 'A / B' }), ['Kreuzung']);
  assert.equal(locNameType({ type: 'maidenhead' }), '');
  assert.equal(locNameType(null), '');
});

test('UTMREF in the info line only when asked, typed UTMREF kept', async () => {
  const { locationFieldText } = await import('../tools/shared/js/locfield.js');
  assert.equal(describeLocation(loc), 'Quellenstraße 10, 1100 · JN88ee', 'off by default');
  assert.equal(describeLocation(loc, 10), 'Quellenstraße 10, 1100 · JN88ee · 33U XP 01858 36102');
  assert.equal(describeLocation(loc, 6), 'Quellenstraße 10, 1100 · JN88ee · 33U XP 018 361');
  const r = { type: 'utm', label: '33U XP 0185 3610 (10 m)', lat: 48.17, lon: 16.37, utm: '33U XP 0185 3610', postcode: '1100', confidence: 'exact', source: 'computed' };
  const snap = snapshotLocation(r, 'xp 0185 3610', false);
  assert.equal(snap.utm, '33U XP 0185 3610');
  assert.equal(snap.type, 'utm');
  assert.equal(locationFieldText(snap), '33U XP 0185 3610');
  assert.equal(describeLocation(snap, 10), '33U XP 0185 3610 (10 m), 1100 · JN88ee', 'the label already is the UTMREF');
  assert.equal(snapshotLocation(loc, 'x', false).utm, undefined, 'only typed UTMREFs are stored');
});
