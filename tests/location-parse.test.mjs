import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocationInput } from '../tools/shared/js/location/parse.js';
import { foldName, searchKeys, normalizeHouseNumber } from '../tools/shared/js/location/normalize.js';

const districts = new Map([['favoriten', 10], ['landstrasse', 3], ['doebling', 19]]);
const P = (s, d) => {
  const ev = parseLocationInput(s, d);
  delete ev.raw;
  return ev;
};

test('spelling variants share a search key', () => {
  const keys = ['Währinger Straße', 'Währinger Strasse', 'waehringer strasse', 'Waehringerstr.', 'Waehringerstr', 'Wahringerstrasse', 'WAEHRINGER STRASSE', 'Währinger Str.']
    .map(s => new Set(searchKeys(s)));
  for (const k of keys) assert.ok(k.has('waehringerstrasse') || k.has('wahringerstrasse'), [...k].join());
  assert.ok(new Set(searchKeys('Währinger Straße')).has('wahringerstrasse'));
  assert.equal(foldName('Quelleng. 5'), 'quellengasse 5');
  assert.equal(foldName('Erne-Seder-Gasse'), 'erne seder gasse');
  assert.equal(foldName('Hauptpl.'), 'hauptplatz');
  assert.equal(foldName('Döblinger  Hauptstr'), 'doeblinger hauptstrasse');
});

test('house numbers', () => {
  assert.equal(normalizeHouseNumber('42 A'), '42a');
  assert.equal(normalizeHouseNumber('42–44'), '42-44');
  for (const [inp, hn] of [['Währinger Straße 42', '42'], ['Währinger Straße 42A', '42A'], ['Währinger Straße 42 A', '42 A'],
    ['Währinger Straße 42/3', '42/3'], ['Währinger Straße 42-44', '42-44'], ['Währinger Straße 42–44', '42–44'], ['Hauptstraße 1a', '1a'], ['Hauptstraße Nr. 7', '7']]) {
    const ev = P(inp);
    assert.equal(ev.houseNumber, hn, inp);
    assert.match(ev.street, /straße$/i, inp);
  }
});

test('postcode, locator, coordinates, district evidence', () => {
  assert.deepEqual(P('1030'), { postcode: '1030' });
  assert.deepEqual(P('1030 Wien'), { postcode: '1030' });
  assert.deepEqual(P('A-1100 Quellenstr'), { postcode: '1100', text: 'Quellenstr' });
  assert.deepEqual(P('Donauinsel 1220 JN88ge'), { postcode: '1220', locator: 'JN88ge', text: 'Donauinsel' });
  assert.deepEqual(P('jn88EE12'), { locator: 'JN88ee12' });
  assert.deepEqual(P('Kahlenberg JN88d'), { partialLocator: 'JN88d', text: 'Kahlenberg' });
  assert.deepEqual(P('48.2083, 16.3731'), { latitude: 48.2083, longitude: 16.3731 });
  assert.deepEqual(P('48.2083 16.3731'), { latitude: 48.2083, longitude: 16.3731 });
  assert.deepEqual(P('48,2083 16,3731'), { latitude: 48.2083, longitude: 16.3731 });
  assert.deepEqual(P('48.2083 N, 16.3731 E'), { latitude: 48.2083, longitude: 16.3731 });
  assert.deepEqual(P('3. Bezirk'), { district: 3 });
  assert.deepEqual(P('Quellenstr 10 Bez'), { district: 10, text: 'Quellenstr' });
  assert.deepEqual(P('Wien 22, Donauinsel'), { district: 22, text: 'Donauinsel' });
  assert.deepEqual(P('Favoriten Quellenstr', districts), { district: 10, text: 'Quellenstr' });
  assert.deepEqual(P('Quellenstr Favoriten', districts), { district: 10, text: 'Quellenstr' });
  assert.deepEqual(P('Landstraße', districts), { district: 3, text: 'Landstraße' });
  assert.equal(P('1100').houseNumber, undefined, 'lone PLZ is not a house number');
  assert.equal(P('Hauptstraße 1100').postcode, '1100');
});

test('Austrian PLZ (with a PLZ set), 1031, "Bezirk <Name>"', () => {
  const plz = new Set(['1100', '2340', '8010']);
  const Q = s => { const ev = parseLocationInput(s, undefined, plz); delete ev.raw; return ev; };
  assert.deepEqual(P('1031'), { postcode: '1031' });
  assert.deepEqual(Q('2340'), { postcode: '2340' });
  assert.deepEqual(Q('A-8010 Graz'), { postcode: '8010', text: 'Graz' });
  assert.deepEqual(Q('A2340'), { postcode: '2340' });
  assert.equal(P('2340').postcode, undefined, 'without the set only Vienna PLZ');
  assert.deepEqual(Q('Hauptstraße 1234'), { street: 'Hauptstraße', houseNumber: '1234', text: 'Hauptstraße' }, 'unknown 4 digits = house number');
  assert.deepEqual(P('Bezirk Mödling'), { bezirkHint: true, text: 'Mödling' });
  assert.deepEqual(P('Bez. Baden'), { bezirkHint: true, text: 'Baden' });
  assert.deepEqual(P('BH Liezen'), { bezirkHint: true, text: 'Liezen' });
  assert.deepEqual(P('Bezirk 3'), { district: 3 });
  assert.deepEqual(P('Bezirk Favoriten', districts), { bezirkHint: true, district: 10, text: 'Favoriten' });
});
