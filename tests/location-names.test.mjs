// Name types and place sources (vienna-locations.json schema 2): colloquial
// and former names, curated aliases with a type, places around Vienna,
// "zwischen A und B" and vague corners. Synthetic data, always runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationIndex, locate } from '../tools/shared/js/location/index.js';

function synthetic() {
  const S = 1e5, B = (v, base) => Math.round((v - base) * S);
  const plz = ['1020', '1030', '1060', '1220'];
  const rows = [
    ['Handelskai', '131-147', '1020', 2, 48.2277, 16.4036],
    ['Mariahilfer Straße', '1', '1060', 6, 48.2000, 16.3550],
    ['Rasumofskygasse', '1', '1030', 3, 48.2040, 16.3910],
    ['Wagramer Straße', '1', '1220', 22, 48.2400, 16.4300],
  ];
  const streets = [];
  rows.forEach((r, i) => {
    if (!streets.length || streets.at(-1)[0] !== r[0]) streets.push([r[0], i, 0]);
    streets.at(-1)[2]++;
  });
  const place = (name, cat, lat, lon, alts = [], src = 'osm', umland = 0) => [name, cat, B(lat, 48), B(lon, 16), alts, src, umland];
  return {
    schema: 2, scale: S, latBase: 48, lonBase: 16, plz, streets,
    hn: rows.map(r => r[1]), ap: rows.map(r => plz.indexOf(r[2])), ad: rows.map(r => r[3]),
    alat: rows.map(r => B(r[4], 48)), alon: rows.map(r => B(r[5], 16)),
    places: [
      place('Klinik Landstraße', 'amenity=hospital', 48.1959, 16.3912, [['Rudolfstiftung', 'h']]),
      place('DC Tower 1', 'building=yes', 48.2321, 16.4134, [['Kaisermühlner Grabstein', 'c']], 'osm+gip'),
      place('MuseumsQuartier', 'tourism=attraction', 48.2032, 16.3586, ['MQ', 'Mariahilfer Straße']),
      place('Praterstern', 'place=square', 48.2182, 16.3919, [], 'osm+gip'),
      place('Riesenrad', 'tourism=attraction', 48.2167, 16.3959),
      place('Reichsbrücke', 'man_made=bridge', 48.2281, 16.4093),
      place('Schottentor', 'stop', 48.2151, 16.3630, [], 'wl'),
      place('Vienna Airport', 'aeroway=aerodrome', 48.1046, 16.5592, ['Flughafen Wien-Schwechat'], 'osm', 1),
      place('Mauer', 'place=village', 48.3000, 16.0000, [], 'osm', 1),
      place('Mauer', 'place=suburb', 48.1508, 16.2686),
    ],
    districts: [[2, ['Leopoldstadt']], [3, ['Landstraße']], [22, ['Donaustadt']]],
    aliases: [['VIE', 'place', 7, ''], ['Lainzer Krankenhaus', 'place', 0, 'h']],
    meta: {},
  };
}
const idx = buildLocationIndex(synthetic());
const top = q => locate(idx, q).results[0];

test('former and colloquial names: shown as such, capped at "high"', () => {
  const r = top('Rudolfstiftung');
  assert.equal(r.label, 'Klinik Landstraße');
  assert.equal(r.matchedName, 'Rudolfstiftung');
  assert.equal(r.nameType, 'historical');
  assert.equal(r.note, 'früher „Rudolfstiftung“');
  assert.ok(r.reasons.includes('früherer Name'));
  assert.notEqual(locate(idx, 'Rudolfstiftung 1030').results[0].confidence, 'exact', 'not an official name');
  const c = top('Kaisermühlner Grabstein');
  assert.equal(c.label, 'DC Tower 1');
  assert.equal(c.nameType, 'colloquial');
  assert.deepEqual(c.sources, ['osm', 'gip']);
  assert.equal(top('DC Tower 1').nameType, undefined, 'own name: no name type');
});

test('curated aliases carry their type', () => {
  assert.equal(top('VIE').label, 'Vienna Airport');
  assert.equal(top('VIE').nameType, 'alias');
  assert.equal(top('Lainzer Krankenhaus').nameType, 'historical');
});

test('places around Vienna: found, marked, ranked below a Vienna place of the same name', () => {
  const a = top('Flughafen Wien-Schwechat');
  assert.equal(a.label, 'Vienna Airport');
  assert.equal(a.umland, true);
  const m = locate(idx, 'Mauer').results;
  assert.equal(m[0].lat.toFixed(2), '48.15', 'Vienna Mauer first');
  assert.ok(m.some(r => r.umland), 'the other Mauer is offered too');
});

test('a place alias that is a street name does not hide the street', () => {
  const r = top('Mariahilfer Straße');
  assert.equal(r.type, 'street');
  assert.ok(!locate(idx, 'Mariahilfer Straße').results.some(x => x.label === 'MuseumsQuartier'));
  assert.equal(top('MQ').label, 'MuseumsQuartier');
});

test('stops (Wiener Linien) are places with the role "stop"', () => {
  const r = top('Schottentor');
  assert.equal(r.source, 'wl');
  assert.equal(r.role, 'stop');
});

test('"zwischen A und B": the midpoint, then A and B', () => {
  const r = locate(idx, 'zwischen Praterstern und Riesenrad');
  assert.equal(r.results[0].type, 'between');
  assert.equal(r.results[0].label, 'zwischen Praterstern und Riesenrad');
  assert.ok(Math.abs(r.results[0].lat - (48.2182 + 48.2167) / 2) < 1e-4);
  assert.deepEqual(r.results.slice(1).map(x => x.label), ['Praterstern', 'Riesenrad']);
  assert.equal(r.autoSelect, null);
  assert.notEqual(top('zwischen Praterstern und Vienna Airport')?.type, 'between', 'too far apart');
});

test('a corner with a one-point side: vague, "low"; nothing near: each side alone', () => {
  const v = top('Handelskai Ecke Reichsbrücke');
  assert.equal(v.type, 'intersection');
  assert.equal(v.confidence, 'low');
  assert.match(v.note, /ungefähr/);
  const far = locate(idx, 'Rasumofskygasse Ecke Wagramer Straße').results;
  assert.ok(!far.some(r => r.type === 'intersection'));
  assert.ok(far.some(r => r.label === 'Rasumofskygasse') && far.some(r => r.label === 'Wagramer Straße'));
  assert.ok(far.every(r => r.confidence === 'low'));
  assert.match(far[0].note, /nicht gefunden/);
});

test('schema 1 rows (no sources/umland) still load', () => {
  const d = synthetic();
  d.places = d.places.map(p => p.slice(0, 5).map(x => (Array.isArray(x) ? x.map(a => (Array.isArray(a) ? a[0] : a)) : x)));
  d.aliases = d.aliases.map(a => a.slice(0, 3));
  const i1 = buildLocationIndex(d);
  assert.equal(locate(i1, 'Rudolfstiftung').results[0].label, 'Klinik Landstraße');
  assert.equal(locate(i1, 'Rudolfstiftung').results[0].nameType, 'alias');
});
