// Free-text structure around names (tools/shared/js/location/query.js and
// its use in locate()): position words, street corners and families,
// category word + name/area, all-words matches, generic street names.
// Synthetic data, always runs; the gold set covers the real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationIndex, locate } from '../tools/shared/js/location/index.js';
import { splitRelation, cornerSplits, splitCategory, rewriteOrdinals } from '../tools/shared/js/location/query.js';
import { searchKeys } from '../tools/shared/js/location/normalize.js';

test('splitRelation: position words, weak ones flagged', () => {
  assert.deepEqual(splitRelation('beim Schottentor'), { relation: 'beim', rest: 'Schottentor', weak: false });
  assert.deepEqual(splitRelation('in der Nähe vom Donauturm'), { relation: 'in der Nähe vom', rest: 'Donauturm', weak: false });
  assert.equal(splitRelation('gegenüber Stephansdom').rest, 'Stephansdom');
  assert.equal(splitRelation('Höhe Matzleinsdorfer Platz').rest, 'Matzleinsdorfer Platz');
  assert.equal(splitRelation('Am Spitz').weak, true);
  assert.equal(splitRelation('Schottentor'), null);
  assert.equal(splitRelation('beim'), null, 'nothing left');
});

test('cornerSplits: separators and a leading "Ecke"', () => {
  assert.deepEqual(cornerSplits('Thaliastraße/Gürtel'), [['Thaliastraße', 'Gürtel']]);
  assert.deepEqual(cornerSplits('Gürtel Ecke Thaliastraße'), [['Gürtel', 'Thaliastraße']]);
  assert.deepEqual(cornerSplits('Wagramer Straße und Siebeckstraße'), [['Wagramer Straße', 'Siebeckstraße']]);
  assert.deepEqual(cornerSplits('Ecke Thaliastraße Gürtel'), [['Thaliastraße', 'Gürtel']]);
  assert.equal(cornerSplits('Ecke Mariahilfer Straße Neubaugasse').length, 2, 'every word boundary');
  assert.deepEqual(cornerSplits('Rudolfsheim-Fünfhaus'), []);
  assert.deepEqual(cornerSplits('Thaliastraße'), []);
});

test('splitCategory: first or last word, U-Bahn lines', () => {
  assert.equal(splitCategory('Kirche Mauer').category.key, 'church');
  assert.equal(splitCategory('Kirche Mauer').rest, 'Mauer');
  assert.equal(splitCategory('Klosterneuburg Stift').category.key, 'monastery');
  assert.equal(splitCategory('U6 Josefstädter Straße').category.key, 'station');
  assert.equal(splitCategory('U-Bahn Schottentor').rest, 'Schottentor');
  assert.equal(splitCategory('Kirche'), null, 'needs something besides the word');
  assert.equal(splitCategory('Mauer Hauptplatz'), null);
});

test('rewriteOrdinals and Sankt', () => {
  assert.equal(rewriteOrdinals('Zentralfriedhof 2. Tor'), 'Zentralfriedhof Tor 2');
  assert.deepEqual(searchKeys('St. Marx'), searchKeys('Sankt Marx'));
});

function synthetic() {
  const S = 1e5, B = (v, base) => Math.round((v - base) * S);
  const plz = ['1010', '1030', '1070', '1130', '1160', '1170', '1210', '1230'];
  const rows = [
    // street, hn, plz, district, lat, lon (contiguous per street)
    ['Hauptstraße', '1', '1230', 23, 48.1400, 16.2900],
    ['Hernalser Gürtel', '2', '1170', 17, 48.2150, 16.3420],
    ['Hietzinger Hauptstraße', '1', '1130', 13, 48.1860, 16.2990],
    ['Landstraßer Hauptstraße', '1', '1030', 3, 48.2060, 16.3850],
    ['Lerchenfelder Gürtel', '1', '1160', 16, 48.2084, 16.3378],
    ['Lerchenfelder Gürtel', '20', '1160', 16, 48.2040, 16.3380],
    ['Simmeringer Hauptstraße', '1', '1030', 3, 48.1900, 16.4000],
    ['Thaliastraße', '1', '1160', 16, 48.2084, 16.3378],
    ['Thaliastraße', '50', '1160', 16, 48.2090, 16.3250],
    ['Wagramer Straße', '1', '1210', 21, 48.2600, 16.4000],
  ];
  const streets = [];
  rows.forEach((r, i) => {
    if (!streets.length || streets.at(-1)[0] !== r[0]) streets.push([r[0], i, 0]);
    streets.at(-1)[2]++;
  });
  const place = (name, cat, lat, lon, alts = []) => [name, cat, B(lat, 48), B(lon, 16), alts];
  return {
    scale: S, latBase: 48, lonBase: 16, plz, streets,
    hn: rows.map(r => r[1]), ap: rows.map(r => plz.indexOf(r[2])), ad: rows.map(r => r[3]),
    alat: rows.map(r => B(r[4], 48)), alon: rows.map(r => B(r[5], 16)),
    places: [
      place('Schottentor', 'railway=station', 48.2151, 16.3630),
      place('Mauer', 'place=suburb', 48.1508, 16.2686),
      place('Pfarrkirche Mauer', 'amenity=place_of_worship', 48.1500, 16.2700),
      place('St. Erhard', 'amenity=place_of_worship', 48.1520, 16.2650),
      place('Kirche Am Hof', 'amenity=place_of_worship', 48.2110, 16.3680),
      place('Klinik Floridsdorf', 'amenity=hospital', 48.2671, 16.4066),
      place('Josefstädter Straße', 'railway=station', 48.2115, 16.3392),
      place('Alte Technik - Ottakringer Brauerei', 'building=industrial', 48.2127, 16.3242),
    ],
    districts: [[1, ['Innere Stadt']], [16, ['Ottakring']], [21, ['Floridsdorf']], [23, ['Liesing']]],
    aliases: [],
    families: [['Gürtel', [1, 4]]],
    genericStreets: ['Bahnhofstraße', 'Hauptstraße'],
    meta: {},
  };
}
const idx = buildLocationIndex(synthetic());
const top = q => locate(idx, q).results[0];

test('position words are stripped and shown; the place keeps its confidence', () => {
  const r = locate(idx, 'beim Schottentor');
  assert.equal(r.results[0].label, 'Schottentor');
  assert.ok(r.results[0].reasons.includes('Lage „beim“'));
  assert.equal(r.autoSelect?.label, 'Schottentor');
  assert.equal(top('Nähe Mauer').label, 'Mauer');
});

test('street corners: midpoint of the nearest address points, family member chosen', () => {
  for (const q of ['Thaliastraße/Gürtel', 'Gürtel Ecke Thaliastraße', 'Ecke Thaliastraße Gürtel', 'Thaliastr. u. Lerchenfelder Gürtel']) {
    const r = top(q);
    assert.equal(r.type, 'intersection', q);
    assert.equal(r.label, q.startsWith('Gürtel') ? 'Lerchenfelder Gürtel / Thaliastraße' : 'Thaliastraße / Lerchenfelder Gürtel', q);
    assert.ok(Math.abs(r.lat - 48.2084) < 0.0005 && Math.abs(r.lon - 16.3378) < 0.0005, q);
    assert.equal(r.postcode, '1160');
    assert.equal(r.confidence, 'likely', `${q}: a corner of two named streets is "likely", never auto-selected`);
  }
  assert.deepEqual(top('Gürtel Ecke Thaliastraße').resolved, ['„Gürtel“ = Lerchenfelder Gürtel'], 'what each side was taken to mean');
  assert.equal(top('Thaliastraße/Lerchenfelder Gürtel').resolved, undefined, 'nothing to explain');
  assert.notEqual(top('Thaliastraße / Wagramer Straße')?.type, 'intersection', 'streets far apart do not cross');
});

test('a family name lists its members, none auto-selected', () => {
  const r = locate(idx, 'Gürtel');
  const labels = r.results.map(x => x.label);
  assert.ok(labels.includes('Lerchenfelder Gürtel') && labels.includes('Hernalser Gürtel'));
  assert.equal(r.autoSelect, null);
});

test('generic street names need Vienna evidence to be auto-selected', () => {
  const r = locate(idx, 'Hauptstraße');
  assert.equal(r.results[0].label, 'Hauptstraße');
  assert.equal(r.autoSelect, null);
  assert.ok(r.results[0].reasons.some(x => x.startsWith('häufiger Straßenname')));
  assert.equal(locate(idx, 'Hauptstraße 1230').autoSelect?.label, 'Hauptstraße');
  assert.equal(locate(idx, 'Landstraßer Hauptstraße').autoSelect?.label, 'Landstraßer Hauptstraße', 'the full name is not generic');
});

test('category word + area, + name, + district', () => {
  assert.equal(top('Kirche Mauer').label, 'Pfarrkirche Mauer', 'official name with another category word');
  const near = locate(idx, 'Kirche Mauer').results.find(r => r.label === 'St. Erhard');
  assert.match(near.note, /m von Mauer/, 'other churches near the area');
  assert.notEqual(near.confidence, 'high');
  const u6 = top('U6 Josefstädter Straße');
  assert.equal(u6.label, 'Josefstädter Straße');
  assert.equal(u6.category, 'railway=station');
  const k = top('Spital Floridsdorf');
  assert.equal(k.label, 'Klinik Floridsdorf');
  assert.equal(top('Krankenhaus Floridsdorf').label, 'Klinik Floridsdorf');
});

test('all query words inside a longer name', () => {
  const r = top('Ottakringer Brauerei');
  assert.equal(r.label, 'Alte Technik - Ottakringer Brauerei');
  assert.notEqual(r.confidence, 'exact');
  assert.notEqual(r.confidence, 'high');
});

test('known names starting with a position word are kept', () => {
  const data = synthetic();
  data.places.push(['Am Spitz', 'place=square', 26700, 40000, []]);
  const i2 = buildLocationIndex(data);
  assert.equal(locate(i2, 'Am Spitz').results[0].label, 'Am Spitz');
  assert.equal(locate(i2, 'beim Am Spitz').results[0].label, 'Am Spitz');
});
