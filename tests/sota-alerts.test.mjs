// SOTA Alerts Map (tools/sota-alerts/js/): the pure parts — alert
// normalisation, the date window, band/mode filters, the share link, the
// summit shapes and the static-first lookup order (AGENTS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAlert, computeDataBounds, filterAlertsByRange, capDefaultToDate, groupAlertsBySummit,
  parseFrequencyFacets, alertBandsModes, matchesBandModeFilter, facetsPresent, sortByOrder, BAND_SORT_ORDER,
  normalizeCallsignBase, parseOwnCallsigns, isOwnAlert,
} from '../tools/sota-alerts/js/alerts.js';
import { timeDisplayPair, formatAlertsBrief } from '../tools/sota-alerts/js/format.js';
import {
  splitSummitKey, summitFromApi, candidateFromSearchResult, candidateFromOsmElement, lookupFromRows,
  summitMetaLine, referenceDiff, referenceDiffText, sotlasPointsColor, summitLinks, sotlasMapUrl,
} from '../tools/sota-alerts/js/summits.js';
import { shareSearch, parseShareSearch } from '../tools/sota-alerts/js/share.js';
import { createSummitResolver, lazy } from '../tools/sota-alerts/js/lookup.js';

const alert = (date, extra = {}) => normalizeAlert({ id: 1, dateActivated: date, associationCode: 'OE', summitCode: 'WI-001', ...extra });

test('normalizeAlert: every field a string, missing ones empty', () => {
  const a = normalizeAlert({ id: 7, dateActivated: '2026-10-07T08:00:00', summitCode: 'WI-001', frequency: null });
  assert.equal(a.id, 7);
  assert.equal(a.associationCode, '');
  assert.equal(a.frequency, '');
  assert.equal(a.comments, '');
  assert.deepEqual(Object.keys(a).sort(), ['activatingCallsign', 'activatorName', 'associationCode', 'comments',
    'dateActivated', 'frequency', 'id', 'posterCallsign', 'summitCode', 'summitDetails']);
});

test('date window: bounds, inclusive filter, 14-day default capped at the data', () => {
  const alerts = [alert('2026-10-09T10:00:00'), alert('2026-10-07T23:59:00'), alert('2026-12-01T06:00:00')];
  assert.deepEqual(computeDataBounds(alerts), { min: '2026-10-07', max: '2026-12-01' });
  assert.equal(computeDataBounds([]), null);
  assert.equal(filterAlertsByRange(alerts, '2026-10-07', '2026-10-09').length, 2);
  assert.equal(filterAlertsByRange(alerts, '', '2026-10-08').length, 1);
  assert.equal(filterAlertsByRange(alerts, '', '').length, 3);
  assert.equal(capDefaultToDate('2026-10-07', '2026-12-01'), '2026-10-20');
  assert.equal(capDefaultToDate('2026-10-07', '2026-10-10'), '2026-10-10');
  // across a month end, in UTC
  assert.equal(capDefaultToDate('2026-10-25', '2027-01-01'), '2026-11-07');
});

test('groupAlertsBySummit: one group per ASSOC/CODE', () => {
  const groups = groupAlertsBySummit([alert('2026-10-07'), alert('2026-10-08'), alert('2026-10-08', { summitCode: 'NO-001' })]);
  assert.deepEqual([...groups.keys()], ['OE/WI-001', 'OE/NO-001']);
  assert.equal(groups.get('OE/WI-001').alerts.length, 2);
  assert.equal(groups.get('OE/NO-001').summitCode, 'NO-001');
});

test('band/mode facets from free-text frequencies', () => {
  const f = s => { const { bands, modes } = parseFrequencyFacets(s); return [[...bands].sort(), [...modes].sort()]; };
  assert.deepEqual(f('145-fm, 14-ssb, 7-ssb'), [['20m', '2m', '40m'], ['FM', 'SSB']]);
  assert.deepEqual(f('146.520FM'), [['2m'], ['FM']]);
  assert.deepEqual(f('146,52-FM'), [['2m'], ['FM']]);
  assert.deepEqual(f('Hf, cw, vhf'), [['HF', 'VHF'], ['CW']]);
  assert.deepEqual(f('20m ft8'), [['20m'], ['FT8']]);
  // known quirk, kept as is: the bare number in "70cm" also reads as 70 MHz (4m)
  assert.deepEqual(f('70cm fm'), [['4m', '70cm'], ['FM']]);
  // "fm" inside a word isn't a mode
  assert.deepEqual(f('confirm'), [[], []]);
  // nothing recognizable: still visible, under "other"
  const other = alertBandsModes(alert('2026-10-07', { frequency: 'tba' }));
  assert.deepEqual([...other.bands, ...other.modes], ['other', 'other']);
});

test('band/mode filter: empty sets show all, otherwise both must match', () => {
  const a = alert('2026-10-07', { frequency: '7.032-cw' });
  const none = new Set();
  assert.ok(matchesBandModeFilter(a, none, none));
  assert.ok(matchesBandModeFilter(a, new Set(['40m']), none));
  assert.ok(matchesBandModeFilter(a, new Set(['40m', '2m']), new Set(['CW'])));
  assert.ok(!matchesBandModeFilter(a, new Set(['2m']), none));
  assert.ok(!matchesBandModeFilter(a, new Set(['40m']), new Set(['SSB'])));
  const present = facetsPresent([a, alert('2026-10-07', { frequency: 'xyz' })]);
  assert.deepEqual(sortByOrder(present.bands, BAND_SORT_ORDER), ['40m', 'other']);
  assert.deepEqual(sortByOrder(['other', 'zz', 'HF', '2m', 'aa'], BAND_SORT_ORDER), ['2m', 'HF', 'other', 'aa', 'zz']);
});

test('own callsigns: base call, portable prefixes and suffixes', () => {
  assert.equal(normalizeCallsignBase('oe1abc/p'), 'OE1ABC');
  assert.equal(normalizeCallsignBase('W4/OE1ABC'), 'OE1ABC');
  assert.equal(normalizeCallsignBase(''), '');
  const own = parseOwnCallsigns('OE1ABC/P, , oe3xyz');
  assert.deepEqual([...own], ['OE1ABC', 'OE3XYZ']);
  assert.ok(isOwnAlert(alert('2026-10-07', { activatingCallsign: 'HB9/OE1ABC/P' }), own));
  assert.ok(!isOwnAlert(alert('2026-10-07', { activatingCallsign: 'OE1ABD' }), own));
});

test('time display: UTC primary by default, local as the other zone', () => {
  const utc = timeDisplayPair('2026-10-07T08:05:00Z', true, 'utc');
  assert.equal(utc.primary, '2026-10-07 08:05Z');
  assert.match(utc.secondary, /^local /);
  assert.equal(timeDisplayPair('2026-10-07T08:05:00Z', false, 'utc').primary, '08:05Z');
  const local = timeDisplayPair('2026-10-07T08:05:00Z', false, 'local');
  assert.equal(local.secondary, 'UTC 08:05Z');
  assert.deepEqual(timeDisplayPair('soon', false, 'utc'), { primary: 'soon', secondary: '' });
  const alerts = ['A', 'B', 'C', 'D'].map(c => ({ dateActivated: '2026-10-07T08:05:00Z', activatingCallsign: c, activatorName: '' }));
  assert.equal(formatAlertsBrief(alerts.slice(0, 1), 'utc'), '2026-10-07 08:05Z · A');
  assert.match(formatAlertsBrief(alerts, 'utc'), /· C \+1 more$/);
  assert.equal(formatAlertsBrief([], 'utc'), null);
});

test('summit shapes: API, search, OSM and the build-time lookup', () => {
  assert.deepEqual(splitSummitKey('OE/WI-001'), { assoc: 'OE', code: 'WI-001' });
  assert.deepEqual(splitSummitKey('W7A/AW-001/x'), { assoc: 'W7A', code: 'AW-001/x' });
  assert.equal(summitFromApi({ name: 'X', latitude: null, longitude: 1 }, 'OE', 'WI-001'), null);
  assert.deepEqual(summitFromApi({ altM: 542, points: 1, latitude: 48.27, longitude: 16.29 }, 'OE', 'WI-001', 5),
    { name: 'OE/WI-001', altM: 542, points: 1, lat: 48.27, lon: 16.29, locator: null, fetchedAt: 5 });
  assert.deepEqual(candidateFromSearchResult({ summitCode: 'OE/WI-001', name: 'Hermannskogel', altM: 542, points: 1, latitude: 48.27, longitude: 16.29 }),
    { key: 'OE/WI-001', assoc: 'OE', code: 'WI-001', name: 'Hermannskogel', altM: 542, points: 1, lat: 48.27, lon: 16.29, locator: null });
  assert.equal(candidateFromOsmElement({ tags: { name: 'x' } }), null);
  assert.deepEqual(candidateFromOsmElement({ lat: 1, lon: 2, tags: { 'communication:amateur_radio:sota': 'OE/NO-001', ele: '1234.6', 'communication:amateur_radio:sota:points': '8' } }),
    { key: 'OE/NO-001', assoc: 'OE', code: 'NO-001', name: 'OE/NO-001', altM: 1235, points: 8, lat: 1, lon: 2 });
  const lookup = lookupFromRows([['OE/WI-001', 48.27, 16.29, 'Hermannskogel', 542, 1, null], ['ZZ/X-1', 1, 2, 'X', null, null, 3]]);
  assert.deepEqual(lookup.get('OE/WI-001'), { name: 'Hermannskogel', lat: 48.27, lon: 16.29, locator: null, altM: 542, points: 1 });
  assert.deepEqual(lookup.get('ZZ/X-1'), { name: 'X', lat: 1, lon: 2, locator: null, bonusPoints: 3 });
});

test('meta line, distance/elevation to the reference', () => {
  assert.equal(summitMetaLine({ altM: 480, points: 8, bonusPoints: 3, locator: 'JN67dn' }), '480m · 8 pts (+3 bonus) · JN67dn');
  assert.equal(summitMetaLine({ points: 0 }), '0 pts');
  assert.equal(summitMetaLine({}), '');
  const summits = new Map([
    ['OE/WI-001', { name: 'Hermannskogel', lat: 48.2702, lon: 16.2939, altM: 542 }],
    ['OE/NO-001', { name: 'Schneeberg', lat: 47.7675, lon: 15.8072, altM: 2076 }],
  ]);
  const diff = referenceDiff(summits.get('OE/NO-001'), 'OE/WI-001', summits);
  assert.equal(diff.heightDiffM, 1534);
  assert.ok(Math.abs(diff.distKm - 66.4) < 1, String(diff.distKm));
  assert.match(referenceDiffText(diff), /^\d+\.\d km, \+1534 m from reference \(Hermannskogel\)$/);
  assert.match(referenceDiffText(referenceDiff(summits.get('OE/WI-001'), 'OE/NO-001', summits)), /, -1534 m /);
  assert.equal(referenceDiff(summits.get('OE/WI-001'), null, summits), null);
  assert.equal(referenceDiff(summits.get('OE/WI-001'), 'XX/NONE', summits), null);
  assert.equal(referenceDiffText(referenceDiff({ lat: 48.2702, lon: 16.2939 }, 'OE/WI-001', summits)), '0.0 km from reference (Hermannskogel)');
  assert.equal(referenceDiffText(null), '');
});

test('points colours (sotl.as) and links', () => {
  assert.deepEqual([1, 2, 4, 6, 8, 10, 3, null].map(sotlasPointsColor),
    ['#4d7a20', '#6da536', '#aea727', '#efa818', '#dc5d04', '#c8101e', '#000', '#000']);
  // each segment encoded, the separator a literal "/"
  assert.deepEqual(summitLinks('W7A', 'AW 1'), {
    sotadata: 'https://www.sotadata.org.uk/en/summit/W7A/AW%201',
    sotlas: 'https://sotl.as/summits/W7A/AW%201',
  });
  assert.equal(sotlasMapUrl(48.123456, 16.5, 9.04), 'https://sotl.as/map/coordinates/48.12346,16.50000/9');
});

test('share link: round trip, and only what is set', () => {
  const s = { from: '2026-10-07', to: '2026-10-20', ref: 'OE/WI-001', pins: ['OE/WI-001', 'OE/NO-001'], bands: ['2m', '40m'], modes: ['CW'] };
  const search = shareSearch(s);
  assert.equal(search, 'from=2026-10-07&to=2026-10-20&ref=OE%2FWI-001&pins=OE%2FWI-001%2COE%2FNO-001&bands=2m%2C40m&modes=CW');
  assert.deepEqual(parseShareSearch('?' + search), s);
  assert.equal(shareSearch({ from: '', to: '', ref: null }), '');
  assert.equal(parseShareSearch(''), null);
  // bands/modes absent: null (keep the stored filter), not an empty filter
  assert.deepEqual(parseShareSearch('?ref=OE/WI-001'), { from: null, to: null, ref: 'OE/WI-001', pins: [], bands: null, modes: null });
  assert.deepEqual(parseShareSearch('?bands=&pins=,A/B,').bands, []);
  assert.deepEqual(parseShareSearch('?bands=&pins=,A/B,').pins, ['A/B']);
});

function resolver({ cache = {}, lookup = new Map(), live = {} } = {}){
  const calls = { live: [], lookup: 0, saved: null };
  const resolve = createSummitResolver({
    loadCache: () => structuredClone(cache),
    saveCache: c => { calls.saved = c; },
    loadLookup: async () => { calls.lookup++; return lookup; },
    fetchSummit: async (assoc, code) => { calls.live.push(`${assoc}/${code}`); return live[`${assoc}/${code}`] ?? null; },
    now: () => 1_000_000_000_000,
  });
  return { resolve, calls };
}
const entry = key => ({ key, ...splitSummitKey(key) });

test('summit lookup: cache, then the static lookup, the live API only for the rest', async () => {
  const now = 1_000_000_000_000;
  const { resolve, calls } = resolver({
    cache: { 'A/1': { name: 'cached', lat: 1, lon: 1, fetchedAt: now - 1000 }, 'A/2': { name: 'stale', lat: 2, lon: 2, fetchedAt: now - 31 * 86400_000 } },
    lookup: new Map([['A/2', { name: 'static', lat: 2, lon: 2, locator: null }], ['A/3', { name: 'static3', lat: 3, lon: 3, locator: null }]]),
    live: { 'B/1': { name: 'live', lat: 4, lon: 4, fetchedAt: now } },
  });
  const out = await resolve(['A/1', 'A/2', 'A/3', 'B/1', 'C/9'].map(entry), false);
  assert.equal(out.get('A/1').name, 'cached');
  assert.equal(out.get('A/2').name, 'static'); // stale cache entry replaced from the lookup
  assert.equal(out.get('A/3').fetchedAt, now);
  assert.equal(out.get('B/1').name, 'live');
  assert.ok(!out.has('C/9')); // not found anywhere: absent, never guessed
  assert.deepEqual(calls.live.sort(), ['B/1', 'C/9']);
  assert.deepEqual(Object.keys(calls.saved).sort(), ['A/1', 'A/2', 'A/3', 'B/1']);
});

test('summit lookup: force goes to the live API for every entry', async () => {
  const { resolve, calls } = resolver({
    cache: { 'A/1': { name: 'cached', lat: 1, lon: 1, fetchedAt: 1_000_000_000_000 } },
    lookup: new Map([['A/2', { name: 'static', lat: 2, lon: 2 }]]),
    live: { 'A/1': { name: 'fresh', lat: 1, lon: 1 } },
  });
  const out = await resolve(['A/1', 'A/2'].map(entry), true);
  assert.equal(calls.lookup, 0);
  assert.deepEqual(calls.live.sort(), ['A/1', 'A/2']);
  assert.equal(out.get('A/1').name, 'fresh');
  assert.ok(!out.has('A/2'));
});

test('summit lookup: no static load and no save when the cache has everything', async () => {
  const { resolve, calls } = resolver({ cache: { 'A/1': { name: 'c', lat: 1, lon: 1, fetchedAt: 1_000_000_000_000 } } });
  await resolve([entry('A/1')], false);
  assert.equal(calls.lookup, 0);
  assert.equal(calls.saved, null);
});

test('summit lookup: at most FETCH_POOL_SIZE live requests at once', async () => {
  let inFlight = 0, peak = 0;
  const resolve = createSummitResolver({
    loadCache: () => ({}), saveCache: () => {}, loadLookup: async () => new Map(),
    fetchSummit: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 2)); inFlight--; return { lat: 0, lon: 0 }; },
  });
  const out = await resolve(Array.from({ length: 20 }, (_, i) => entry(`Z/${i}`)), false);
  assert.equal(out.size, 20);
  assert.equal(peak, 6);
});

test('lazy: one load for concurrent callers; the fallback is kept, a plain failure retried', async () => {
  let n = 0;
  const get = lazy(async () => { n++; return [n]; });
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(a, b);
  assert.equal(n, 1);
  assert.deepEqual(get.loaded(), [1]);

  let tries = 0;
  const failing = lazy(async () => { tries++; throw new Error('nope'); });
  await assert.rejects(failing());
  await assert.rejects(failing());
  assert.equal(tries, 2);
  assert.equal(failing.loaded(), null);

  let tries2 = 0;
  const withFallback = lazy(async () => { tries2++; throw new Error('nope'); }, () => new Map());
  assert.equal((await withFallback()).size, 0);
  await withFallback();
  assert.equal(tries2, 1);
});
