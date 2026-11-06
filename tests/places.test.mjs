// Named places of the user (issue #181): CSV import (encodings, separators,
// skipped rows, limits), the search and its merge into the location
// lookup, the snapshot a place leaves on a message, the shared store
// (generations, soft delete, total limit) and the map. Invented places only
// (tests/fixtures/places/): the real lists are private and never shipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { memoryStore } from '../tools/netlog/js/memstore.js';
import {
  placesDecode, placesParseCsv, placesSkippedText, placesToCsv, placesNumber, placesIndex, placesSearch,
  placesResolve, placesMerge, PLACES_MAX_BYTES, PLACES_MAX_ROWS, PLACES_MAX_TOTAL,
} from '../tools/shared/js/places.js';
import {
  PLACES_SCHEMA, PLACES_STORES, importPlacesList, loadPlacesStore, placesActive, swapPlacesGeneration,
  deletePlacesList, restorePlacesList, erasePlacesList, PlacesLimitError,
} from '../tools/shared/js/places-store.js';
import { createPlacesService } from '../tools/shared/js/places-service.js';
import { snapshotLocation, describeLocation, locationFieldText } from '../tools/shared/js/locfield.js';
import { messagesForMap } from '../tools/notfunk/js/mapdata.js';

const FIXTURE = new URL('./fixtures/places/orte-erfunden.csv', import.meta.url);
const fixture = () => placesDecode(readFileSync(FIXTURE));
const HEAD = 'Name;Typ;Adresse;Breite;Länge;Aliase';

test('the fixture: BOM, ; and decimal comma, quotes, skipped rows by line', () => {
  const r = placesParseCsv(fixture());
  assert.equal(r.sep, ';');
  assert.deepEqual(r.rows.map(p => p.name), ['Lichtinsel Testpark', 'Lichtinsel Musterhof', 'K-Vorsorge Probeschule', 'Verbindungsstation "Nord"']);
  const [a, , , d] = r.rows;
  assert.deepEqual(a, { name: 'Lichtinsel Testpark', type: 'Lichtinsel', address: 'Erfundene Gasse 1, 1210 Wien', lat: 48.2701, lon: 16.4012, aliases: ['LI Testpark', 'Testpark'] });
  assert.equal(d.address, 'Am Erfundenen Berg 2; 1190 Wien');
  assert.deepEqual(r.skipped, [{ line: 6, reason: 'coords' }, { line: 7, reason: 'swapped' }]);
  assert.equal(placesSkippedText(r.skipped), '2 Zeilen übersprungen: Zeile 6 ohne gültige Breite/Länge; Zeile 7 Breite und Länge vertauscht?');
});

test('separators, header names and order, decimal point, Windows-1252', () => {
  const comma = placesParseCsv('lat,lon,name,alias\n48.2,16.3,Ort A,A1|A2\n"48,25","16,35",Ort B,\n');
  assert.equal(comma.sep, ',');
  assert.deepEqual(comma.rows.map(p => [p.name, p.lat, p.lon, p.aliases]), [['Ort A', 48.2, 16.3, ['A1', 'A2']], ['Ort B', 48.25, 16.35, []]]);
  const tab = placesParseCsv('Name\tBreite\tLaenge\nOrt C\t48\t16\n');
  assert.equal(tab.rows[0].name, 'Ort C');
  // Excel's "CSV" on Windows: ä ö ü ß as single bytes
  const cp = Uint8Array.from([...'Name;Breite;L\xe4nge;Adresse\nGr\xfcnpunkt;48,1;16,2;Stra\xdfe 1\n'].map(c => c.charCodeAt(0)));
  const win = placesParseCsv(placesDecode(cp));
  assert.deepEqual([win.rows[0].name, win.rows[0].address], ['Grünpunkt', 'Straße 1']);
  assert.equal(placesNumber('+48,5°'), 48.5);
  assert.ok(Number.isNaN(placesNumber('48,5,1')));
});

test('a file without a usable header writes nothing; limits are refused as a whole', () => {
  assert.deepEqual(placesParseCsv('Lichtinsel X;48,2;16,4\n'), { error: 'no-header', missing: ['name', 'lat', 'lon'] });
  assert.deepEqual(placesParseCsv('Name;Adresse\nX;Y\n').missing, ['lat', 'lon']);
  assert.deepEqual(placesParseCsv(''), { error: 'no-header', missing: ['name', 'lat', 'lon'] });
  const rows = n => [HEAD, ...Array.from({ length: n }, (_, i) => `Ort ${i};;;48,2;16,3;`)].join('\n');
  assert.equal(placesParseCsv(rows(PLACES_MAX_ROWS)).rows.length, PLACES_MAX_ROWS);
  assert.deepEqual(placesParseCsv(rows(PLACES_MAX_ROWS + 1)), { error: 'too-many' });
  const big = `${HEAD}\nOrt;;${'x'.repeat(PLACES_MAX_BYTES)};48;16;\n`;
  assert.deepEqual(placesParseCsv(big), { error: 'too-large' });
  // over-long texts and too many aliases: that row is skipped, not cut
  const r = placesParseCsv(`${HEAD}\nLang;;${'x'.repeat(301)};48;16;\nViele;;;48;16;${Array.from({ length: 21 }, (_, i) => `a${i}`).join('|')}\nGut;;;48;16;\n`);
  assert.deepEqual(r.rows.map(p => p.name), ['Gut']);
  assert.deepEqual(r.skipped.map(s => s.reason), ['long', 'aliases']);
});

test('export round-trips through the import (also formula-like names)', () => {
  const rows = placesParseCsv(fixture()).rows.concat([{ name: '=Probe', type: '', address: '', lat: -1.5, lon: 2.25, aliases: ['@x'] }]);
  const csv = placesToCsv(rows);
  assert.ok(csv.startsWith('﻿Name;Typ;Adresse;Breite;Länge;Aliase\r\n'));
  assert.match(csv, /'=Probe;;;-1,5;2,25;'@x/);
  assert.deepEqual(placesParseCsv(placesDecode(new TextEncoder().encode(csv))).rows, rows);
});

const listed = (rows, listName = 'Erfundene Orte') => rows.map((p, i) => ({ ...p, id: `l:1:${i}`, list: 'l', listName }));

test('search: exact name or alias, prefix, words, folding; resolve only exact', () => {
  const idx = placesIndex(listed(placesParseCsv(fixture()).rows));
  const [hit] = placesSearch(idx, 'lichtinsel testpark');
  assert.equal(hit.label, 'Lichtinsel Testpark');
  assert.equal(hit.confidence, 'exact');
  assert.equal(hit.type, 'place');
  assert.equal(hit.address, 'Erfundene Gasse 1, 1210 Wien');
  assert.equal(hit.list, 'Erfundene Orte');
  assert.equal(hit.maidenhead.length, 6);
  const alias = placesSearch(idx, 'LI-Testpark')[0];
  assert.deepEqual([alias.label, alias.matchedName, alias.nameType, alias.confidence], ['Lichtinsel Testpark', 'LI Testpark', 'alias', 'exact']);
  assert.deepEqual(placesSearch(idx, 'Lichtinsel').map(h => [h.label, h.confidence]), [['Lichtinsel Musterhof', 'high'], ['Lichtinsel Testpark', 'high']]);
  assert.equal(placesSearch(idx, 'probeschule')[0].label, 'K-Vorsorge Probeschule');
  assert.equal(placesSearch(idx, 'verbindungsstation nord')[0].confidence, 'exact');
  assert.equal(placesSearch(idx, 'probestrasse').length, 0);   // addresses are not names
  assert.equal(placesSearch(idx, 'L').length, 0);
  assert.equal(placesResolve(idx, 'testpark').label, 'Lichtinsel Testpark');
  assert.equal(placesResolve(idx, 'Lichtinsel'), null);
});

test('merge into the address lookup: an exact place wins, otherwise after the automatic match', () => {
  const idx = placesIndex(listed(placesParseCsv(fixture()).rows));
  const addr = { type: 'address', label: 'Probestraße 3', confidence: 'high' };
  const other = { type: 'street', label: 'Probestraße', confidence: 'likely' };
  const exact = placesSearch(idx, 'Testpark');
  let m = placesMerge({ results: [addr, other], autoSelect: addr }, exact, { level: 'high' });
  assert.equal(m.autoSelect.label, 'Lichtinsel Testpark');
  assert.deepEqual(m.results.map(r => r.label), ['Lichtinsel Testpark', 'Probestraße 3', 'Probestraße']);
  m = placesMerge({ results: [addr], autoSelect: addr }, exact, { level: 'never' });
  assert.equal(m.autoSelect, addr);
  const partial = placesSearch(idx, 'Lichtinsel');
  m = placesMerge({ results: [addr, other], autoSelect: addr }, partial);
  assert.deepEqual(m.results.map(r => r.label), ['Probestraße 3', 'Lichtinsel Musterhof', 'Lichtinsel Testpark', 'Probestraße']);
  m = placesMerge({ results: [other], autoSelect: null }, partial);
  assert.equal(m.autoSelect, null);
  assert.equal(m.results[0].label, 'Lichtinsel Musterhof');
  assert.deepEqual(placesMerge(null, partial).results.length, 2);   // no address data: places alone
});

test('a picked place is a location snapshot: address in the info line, on the map', () => {
  const idx = placesIndex(listed(placesParseCsv(fixture()).rows));
  const snap = snapshotLocation(placesSearch(idx, 'LI Testpark')[0], 'LI Testpark', true);
  assert.deepEqual([snap.type, snap.label, snap.address, snap.placeType, snap.list, snap.lat, snap.lon, snap.matched, snap.nameType],
    ['place', 'Lichtinsel Testpark', 'Erfundene Gasse 1, 1210 Wien', 'Lichtinsel', 'Erfundene Orte', 48.2701, 16.4012, 'LI Testpark', 'alias']);
  assert.equal(locationFieldText(snap), 'Lichtinsel Testpark');
  assert.match(describeLocation(snap), /^Lichtinsel Testpark, Erfundene Gasse 1, 1210 Wien · JN88/);
  // an ordinary address keeps its description
  assert.equal(describeLocation({ type: 'address', label: 'Probestraße 3', postcode: '1100', maidenhead: 'JN88ee' }), 'Probestraße 3, 1100 · JN88ee');
  const { placed, unplaced } = messagesForMap([
    { id: 'a', location: snap },
    { id: 'b', location: null, locationText: 'VS Nord' },
    { id: 'c', location: null, locationText: 'Nirgendwo' },
  ], new Map([['VS Nord', placesResolve(idx, 'VS Nord')], ['Nirgendwo', null]]));
  assert.deepEqual(placed.map(p => [p.msg.id, p.loc.label]), [['a', 'Lichtinsel Testpark'], ['b', 'Verbindungsstation "Nord"']]);
  assert.deepEqual(unplaced.map(m => m.id), ['c']);
});

const rowsOf = n => Array.from({ length: n }, (_, i) => ({ name: `Ort ${i}`, type: '', address: '', lat: 48, lon: 16, aliases: [] }));

test('store: stable name; lists, replace with undo, soft delete, erase', async () => {
  assert.equal(PLACES_SCHEMA.name, 'oe1ebg-places');
  assert.equal(PLACES_SCHEMA.version, 1);
  const created = [];
  PLACES_SCHEMA.upgrade(0, n => created.push(n));
  assert.deepEqual(created.sort(), Object.keys(PLACES_STORES).sort());
  const s = memoryStore(PLACES_STORES);
  const rows = placesParseCsv(fixture()).rows;
  const a = await importPlacesList(s, { name: 'Lichtinseln', fileName: 'a.csv', rows });
  const b = await importPlacesList(s, { name: 'Weitere', rows: rowsOf(2) });
  let { lists, places } = await loadPlacesStore(s);
  assert.equal(placesActive(lists, places).length, 6);
  assert.deepEqual(placesActive(lists, places).map(p => p.listName).slice(0, 4), Array(4).fill('Lichtinseln'));
  // replace, undo, redo
  await importPlacesList(s, { name: 'Lichtinseln', fileName: 'a2.csv', rows: rows.slice(0, 1), replaceId: a.id });
  ({ lists, places } = await loadPlacesStore(s));
  assert.equal(placesActive(lists, places).filter(p => p.list === a.id).length, 1);
  await swapPlacesGeneration(s, a.id);
  ({ lists, places } = await loadPlacesStore(s));
  assert.equal(placesActive(lists, places).filter(p => p.list === a.id).length, 4);
  assert.equal(lists.find(l => l.id === a.id).count, 4);
  // a new version after an undo keeps the current one, erases the other,
  // and never mixes with it
  await importPlacesList(s, { name: 'Lichtinseln', rows: rowsOf(3), replaceId: a.id });
  assert.deepEqual([...new Set((await s.getByEvent('places', a.id)).map(p => p.gen))].sort(), [1, 3]);
  ({ lists, places } = await loadPlacesStore(s));
  assert.deepEqual(placesActive(lists, places).filter(p => p.list === a.id).map(p => p.name), ['Ort 0', 'Ort 1', 'Ort 2']);
  await swapPlacesGeneration(s, a.id);
  ({ lists, places } = await loadPlacesStore(s));
  assert.equal(placesActive(lists, places).filter(p => p.list === a.id).length, 4);
  // soft delete keeps the places, restore brings them back, erase removes all
  await deletePlacesList(s, b.id);
  ({ lists, places } = await loadPlacesStore(s));
  assert.equal(placesActive(lists, places).some(p => p.list === b.id), false);
  assert.equal((await s.getByEvent('places', b.id)).length, 2);
  await restorePlacesList(s, b.id);
  ({ lists, places } = await loadPlacesStore(s));
  assert.equal(placesActive(lists, places).filter(p => p.list === b.id).length, 2);
  await erasePlacesList(s, b.id);
  assert.equal((await s.getByEvent('places', b.id)).length, 0);
  assert.equal(await s.get('lists', b.id), undefined);
});

test('store: the total limit refuses an import or a restore before writing', async () => {
  const s = memoryStore(PLACES_STORES);
  const a = await importPlacesList(s, { name: 'A', rows: rowsOf(PLACES_MAX_TOTAL - 1) });
  await assert.rejects(importPlacesList(s, { name: 'B', rows: rowsOf(2) }), PlacesLimitError);
  assert.equal((await s.getAll('lists')).length, 1);
  assert.equal((await s.getAll('places')).length, PLACES_MAX_TOTAL - 1);
  // replacing a list counts the new version only
  await importPlacesList(s, { name: 'A', rows: rowsOf(PLACES_MAX_TOTAL), replaceId: a.id });
  await deletePlacesList(s, a.id);
  const b = await importPlacesList(s, { name: 'B', rows: rowsOf(1) });
  await assert.rejects(restorePlacesList(s, a.id), PlacesLimitError);
  assert.equal((await s.get('lists', a.id)).deleted, true);
  assert.ok(b);
});

test('service: search and resolve over the active lists, refresh after a change elsewhere', async () => {
  const s = memoryStore(PLACES_STORES);
  let changes = 0;
  const svc = createPlacesService({ openStore: async () => s, onChange: () => changes++ });
  await svc.init();
  assert.deepEqual(svc.summary(), { available: true, lists: 0, places: 0 });
  assert.deepEqual(svc.search('Testpark'), []);
  const l = await importPlacesList(s, { name: 'Erfunden', rows: placesParseCsv(fixture()).rows });
  assert.equal(await svc.refresh(), true);
  assert.equal(await svc.refresh(), false);
  assert.equal(svc.resolve('LI Musterhof').label, 'Lichtinsel Musterhof');
  assert.equal(svc.search('Lichtinsel').length, 2);
  assert.equal(svc.placesOf(l.id).length, 4);
  await deletePlacesList(s, l.id);
  await svc.refresh();
  assert.equal(svc.resolve('LI Musterhof'), null);
  assert.ok(changes >= 3);
  // without IndexedDB: no places, nothing fails
  const none = createPlacesService({ openStore: async () => null });
  await none.init();
  assert.deepEqual([none.available(), none.search('Testpark').length], [false, 0]);
});

test('no place data in the repository: only the invented fixture', () => {
  assert.deepEqual(readdirSync(new URL('./fixtures/places/', import.meta.url)), ['orte-erfunden.csv']);
});
