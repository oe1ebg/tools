import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { stationsForMap, ownPosition, maidenheadGridLines } from '../content/confirm/js/mapdata.js';
import { mapLinkUrls, mapLinkZoom } from '../content/confirm/js/sources.js';

test('map links: Google Maps / OSM URLs, 5 decimals, zoom by type', () => {
  const u = mapLinkUrls(48.2083012, 16.37, 18);
  assert.equal(u.google, 'https://www.google.com/maps/search/?api=1&query=48.20830,16.37000');
  assert.equal(u.osm, 'https://www.openstreetmap.org/?mlat=48.20830&mlon=16.37000#map=18/48.20830/16.37000');
  assert.match(mapLinkUrls(-33.5, -70.25).osm, /mlat=-33\.50000&mlon=-70\.25000#map=15\//);
  assert.equal(mapLinkUrls(NaN, 16), null);
  assert.equal(mapLinkUrls(undefined, undefined), null);
  assert.equal(mapLinkZoom({ type: 'address' }), 18);
  assert.equal(mapLinkZoom({ type: 'postcode' }), 12);
  assert.ok(mapLinkZoom({ type: 'bezirk' }) <= 12);
  assert.equal(mapLinkZoom({ type: 'maidenhead', maidenhead: 'JN88' }), 9);
  assert.equal(mapLinkZoom({ type: 'maidenhead', maidenhead: 'JN88ef' }), 13);
  assert.equal(mapLinkZoom({ type: 'maidenhead', maidenhead: 'JN88ef12' }), 16);
  assert.equal(mapLinkZoom({ type: 'unknown' }), 15);
});

const L = (lat, lon, extra = {}) => ({ lat, lon, label: 'x', maidenhead: 'JN88ee', confidence: 'high', ...extra });
const E = (id, call, ts, loc, extra = {}) => ({ id, seq: +id, call, ts, loc, ...extra });

test('stationsForMap: one record per station at its latest located check-in', () => {
  const entries = [
    E('1', 'OE1AAA', '2026-10-04T10:00:00Z', L(48.20, 16.37)),
    E('2', 'OE1AAA', '2026-10-04T10:05:00Z', null),          // later check-in without location
    E('3', 'OE1AAA', '2026-10-04T10:10:00Z', L(48.25, 16.40)), // moved
    E('4', 'OE1BBB', '2026-10-04T10:01:00Z', null),
    E('5', 'OE1CCC', '2026-10-04T10:02:00Z', L(48.18, 16.30), { deleted: '2026-10-04T10:03:00Z' }),
  ];
  const { placed, unplaced } = stationsForMap(entries);
  assert.deepEqual(placed.map(s => s.call), ['OE1AAA']);
  assert.equal(placed[0].loc.lat, 48.25, 'latest located check-in wins');
  assert.deepEqual(placed[0].checkins.map(e => e.id), ['1', '2', '3'], 'all check-ins, oldest first');
  assert.deepEqual(unplaced.map(s => s.call), ['OE1BBB'], 'deleted entries ignored');
});

test('ownPosition: QTH result, else locator centre with its square, else null', () => {
  assert.deepEqual(ownPosition({ myQth: 'x', myGrid: 'JN88ef' }, { lat: 48.2, lon: 16.3, label: 'Hier' }), { lat: 48.2, lon: 16.3, label: 'Hier', source: 'qth' });
  const g = ownPosition({ myGrid: 'JN88ef' }, null);
  assert.equal(g.source, 'locator');
  assert.ok(Math.abs(g.lat - 48.229167) < 1e-5 && Math.abs(g.lon - 16.375) < 1e-5);
  assert.ok(g.bounds.north > g.lat && g.bounds.south < g.lat);
  assert.equal(ownPosition({ myGrid: 'nonsense' }, null), null);
  assert.equal(ownPosition({}, null), null);
});

test('maidenheadGridLines: 6-char squares covering Vienna', () => {
  const g = maidenheadGridLines([[48.118, 16.18], [48.323, 16.578]], 6);
  const locs = g.labels.map(l => l.loc);
  for (const want of ['JN88ee', 'JN88ef', 'JN88dg', 'JN88fe']) assert.ok(locs.includes(want), want);
  assert.ok(locs.every(l => /^JN88[c-g][c-h]$/.test(l)), locs.join()); // south edge 48.118° is row c
  assert.ok(g.lines.length >= 10);
});

const real = new URL('../content/confirm/data/vienna-map.json', import.meta.url);
test('generated basemap is plausible and small', { skip: !existsSync(real) && 'run `just build-map` first' }, () => {
  const raw = readFileSync(real, 'utf8');
  assert.ok(raw.length < 2 * 1024 * 1024, `${raw.length} bytes`);
  const d = JSON.parse(raw);
  assert.equal(d.districts.length, 23);
  assert.deepEqual(d.districts.map(x => x.nr), Array.from({ length: 23 }, (_, i) => i + 1));
  assert.ok(d.water.some(w => w.name === 'Donau') && d.water.some(w => w.name === 'Donaukanal'));
  assert.ok(d.roads.some(r => r.c === 'motorway'));
  for (const x of d.districts) assert.ok(x.label[0] > 48.1 && x.label[0] < 48.33 && x.label[1] > 16.18 && x.label[1] < 16.58, `${x.nr} label inside Vienna`);
});
