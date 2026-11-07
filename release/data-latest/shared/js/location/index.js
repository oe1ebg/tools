// Offline location lookup: operator input -> ranked candidates with PLZ,
// coordinates and Maidenhead locator. Streets/addresses/landmarks: Vienna
// only (data/vienna-locations.json, scripts/build_location_data.py). PLZ and
// political Bezirke: all of Austria, with the locator squares they cover
// (data/austria-areas.json, scripts/build_austria_areas.py; optional).
// Design: oe1ebg/tools/confirm/README.md.
//
//   const idx = buildLocationIndex(data, areas);
//   locate(idx, 'Waehringerstr 42 1180')   -> { evidence, results, autoSelect }
//   lookupCoordinates(idx, 48.21, 16.37)    -> { postcode, district, ... }
//   lookupMaidenhead(idx, 'JN88ee')         -> { bounds, postalCodes, ... }
//   locate(idx, 'XP 0201 4038', { utmRef: { zone: 33, band: 'U' } }) -> a 'utm' area result

import { latLonToMaidenhead, maidenheadToBounds, isValidLocator, locatorPrecisionName, formatLocator } from '../maidenhead.js';
import { foldName, compactKey, foldedForms, keysOfForms, searchKeys, normalizeHouseNumber, leadingNumber } from './normalize.js';
import { parseLocationInput } from './parse.js';
import { buildTrigramIndex, trigramCandidates, nameSimilarity } from './fuzzy.js';
import { buildGrid, nearestPoints, pointsInBox } from './spatial.js';
import { splitRelation, cornerSplits, splitCategory, categoryOfWord, rewriteOrdinals, STOP_WORDS } from './query.js';
import { distanceMeters } from '../geo.js';
import { mgrsToBounds, mgrsPrecisionName } from '../utm.js';

// Ranking (see the brief): text match base + structured-evidence bonuses.
export const SCORE = {
  exactAddress: 100, exactName: 95, exactAlias: 90, prefix: 85, fuzzyMax: 80,
  plzMatch: 30, plzMismatch: -25, districtMatch: 20, districtMismatch: -15,
  locatorInside: 30, locatorNear: 10, locatorOutside: -20,
  houseExact: 20, houseNear: 5, landmark: 3,
  // Name rebuilt with the official category word ("Spital X" -> "Klinik X").
  categoryRewrite: 92,
  // Category word confirms a name match ("U6 Josefstädter Straße" -> the station).
  categoryFits: 6,
  // All query words inside a longer name ("Ottakringer Brauerei").
  wordsMax: 82,
  // "Kirche Mauer": a place of that category near the named area.
  nearContextMax: 80,
};
// Name types (schema 2): what kind of name matched, and its exact-match base.
// Only official names ("name") can reach confidence "exact"; the others are
// capped at "high". Alt names in the data are "name" strings (alias) or
// ["name", code] with code c/h/g.
const NAME_TYPE_CODES = { '': 'alias', c: 'colloquial', h: 'historical', g: 'generated' };
const NAME_TYPES = {
  name: { base: 95, how: 'Name exakt' },
  alias: { base: 90, how: 'Alias exakt' },
  colloquial: { base: 90, how: 'umgangssprachlicher Name' },
  historical: { base: 88, how: 'früherer Name' },
  generated: { base: 85, how: 'Kurzform' },
};
// Places outside Vienna rank below Vienna's for the same text.
const UMLAND_PENALTY = 5;
const FUZZY_MIN_SIMILARITY = 0.6;
const CONFIDENCE_ORDER = ['low', 'ambiguous', 'likely', 'high', 'exact'];
// A street corner: the two streets' nearest address points must be this close.
const CORNER_MAX_METERS = 150, CORNER_VAGUE_METERS = 500;
// "zwischen A und B" only for places this close together.
const BETWEEN_MAX_METERS = 5000;
// Radius for "category near <place>" ("Kirche Mauer"); areas get the larger one.
const NEAR_CONTEXT_METERS = 1200, NEAR_AREA_METERS = 2500;
// A street name that ends this many other Vienna street names ("Hauptstraße")
// is an everyday short form, not one street.
const GENERIC_SUFFIX_COUNT = 3;

/* ------------------------------------------------------------------ build */

export function buildLocationIndex(data, areas) {
  const S = data.scale, n = data.hn.length;
  const lat = new Float64Array(n), lon = new Float64Array(n), num = new Int32Array(n);
  const hnNorm = new Array(n);
  for (let i = 0; i < n; i++) {
    lat[i] = data.latBase + data.alat[i] / S;
    lon[i] = data.lonBase + data.alon[i] / S;
    num[i] = leadingNumber(data.hn[i]);
    hnNorm[i] = normalizeHouseNumber(data.hn[i]);
  }
  const places = data.places.map(([name, cat, la, lo, alts, src = 'osm', umland = 0]) => ({
    name, cat, alts, sources: src.split('+'), umland: !!umland, lat: data.latBase + la / S, lon: data.lonBase + lo / S,
    landmark: /^(place|natural=(peak|hill|island)|tourism=(attraction|viewpoint)|railway=station|aeroway=aerodrome|landmark)/.test(cat),
  }));
  const streets = data.streets.map(([name, start, count]) => {
    const plz = new Set(), dist = new Set();
    for (let i = start; i < start + count; i++) { plz.add(data.plz[data.ap[i]]); dist.add(data.ad[i]); }
    return { name, start, count, plz, dist };
  });

  const districtNames = new Map();
  const districts = new Map();
  for (const [nr, names] of data.districts) {
    districts.set(nr, { nr, name: names[0], names });
    for (const nm of names) districtNames.set(foldName(nm), nr);
  }

  const { areaPlz, bezirke, states } = readAreas(areas);

  // Vocabulary: every searchable name -> entities.
  // { kind: street|place|district|bezirk|postcode|family, id, label, nameType, alias, bonus }
  const terms = [];
  const keyTerms = new Map(); // compact key -> [term ids]
  const addTerm = (kind, id, text, nameType = 'name', bonus = 0) => {
    const forms = foldedForms(text);
    const t = terms.push({ kind, id, label: text, nameType, alias: nameType !== 'name', bonus, forms }) - 1;
    // "Zentralfriedhof 2.Tor" is also found as "Zentralfriedhof Tor 2".
    const keys = keysOfForms(forms);
    if (/\d\.\s*\p{L}/u.test(text)) keys.push(...searchKeys(rewriteOrdinals(text)));
    for (const k of new Set(keys)) {
      let list = keyTerms.get(k);
      if (!list) keyTerms.set(k, (list = []));
      list.push(t);
    }
  };
  streets.forEach((s, i) => addTerm('street', i, s.name));
  // A place's alt name that is exactly a street name (OSM sometimes has the
  // address there) would make "Mariahilfer Straße" find the museum.
  const isStreetName = text => searchKeys(text).some(k => (keyTerms.get(k) || []).some(t => terms[t].kind === 'street'));
  places.forEach((p, i) => {
    addTerm('place', i, p.name);
    for (const a of p.alts) {
      const [text, code] = typeof a === 'string' ? [a, ''] : a;
      if (!isStreetName(text)) addTerm('place', i, text, NAME_TYPE_CODES[code] || 'alias');
    }
  });
  for (const d of districts.values()) for (const nm of d.names) addTerm('district', d.nr, nm, d.names[0] !== nm ? 'alias' : 'name');
  for (const [alias, kind, id, code = ''] of data.aliases) addTerm(kind, id, alias, NAME_TYPE_CODES[code] || 'alias');
  // "Gürtel", "Ring": one everyday name for several streets.
  const families = (data.families || []).map(([name, members]) => ({ name, members }));
  families.forEach((f, i) => addTerm('family', i, f.name, 'alias'));
  addAreaTerms(addTerm, areaPlz, bezirke);

  const keys = [...keyTerms.keys()];
  const idx = {
    data, lat, lon, num, hnNorm, streets, places, districts, districtNames,
    areaPlz, bezirke, states, families,
    viennaPlz: new Set(data.plz),
    postcodeSet: new Set([...data.plz, ...areaPlz.keys()]),
    terms, keyTerms, keys,
    sortedKeys: [...keys].sort(),
    genericStreets: genericStreetKeys(streets, data.genericStreets || []),
    words: buildWordIndex(terms),
    trigrams: buildTrigramIndex(keys),
    grid: buildGrid(lat, lon),
    meta: data.meta,
    areasMeta: areas?.meta || null,
    counts: {
      addresses: n, streets: streets.length, places: places.length, postcodes: areaPlz.size, bezirke: bezirke.size,
      osm: places.filter(p => p.sources.includes('osm')).length, umland: places.filter(p => p.umland).length,
      gip: places.filter(p => p.sources.includes('gip')).length, stops: places.filter(p => p.sources.includes('wl')).length,
    },
  };
  // District/PLZ centroids from their addresses.
  idx.districtStats = groupStats(idx, i => data.ad[i]);
  idx.plzStats = groupStats(idx, i => data.plz[data.ap[i]]);
  return idx;
}

// Compact keys of street names that are everyday short forms rather than one
// street: the curated list (in every Austrian municipality) plus names that
// end several other Vienna street names ("Hauptstraße" in "Landstraßer
// Hauptstraße", "Hietzinger Hauptstraße", ...).
function genericStreetKeys(streets, curated) {
  const out = new Set();
  for (const name of curated) for (const k of searchKeys(name)) out.add(k);
  const suffixCount = new Map();
  for (const s of streets) {
    const words = foldName(s.name).split(' ');
    for (let n = 1; n < words.length; n++) {
      const k = compactKey(words.slice(n).join(' '));
      suffixCount.set(k, (suffixCount.get(k) || 0) + 1);
    }
  }
  for (const s of streets) {
    for (const k of searchKeys(s.name)) if ((suffixCount.get(k) || 0) >= GENERIC_SUFFIX_COUNT) out.add(k);
  }
  return out;
}

// Folded word -> term ids, for names that contain all the query's words
// ("Ottakringer Brauerei" in "Alte Technik - Ottakringer Brauerei").
function buildWordIndex(terms) {
  const words = new Map();
  terms.forEach((t, id) => {
    for (const form of t.forms) {
      for (const w of form.split(' ')) {
        if (w.length < 2 || STOP_WORDS.has(w)) continue;
        let list = words.get(w);
        if (!list) words.set(w, (list = []));
        if (list[list.length - 1] !== id) list.push(id);
      }
    }
  });
  return words;
}

// austria-areas.json rows -> Maps (empty without the file).
function readAreas(areas) {
  const areaPlz = new Map(), bezirke = new Map();
  if (!areas) return { areaPlz, bezirke, states: [] };
  for (const [code, name, more, state, bez, lat, lon, n, loc6, n6, loc4] of areas.plz) {
    areaPlz.set(code, { kind: 'postcode', code, name, more, state, bezirke: bez, lat, lon, n, loc6, n6, loc4 });
  }
  for (const [code, name, aliases, state, lat, lon, n, loc6, n6, loc4, topPlz] of areas.bezirke) {
    bezirke.set(code, { kind: 'bezirk', code, name, aliases, state, lat, lon, n, loc6, n6, loc4, topPlz });
  }
  return { areaPlz, bezirke, states: areas.states };
}

// Search terms for Austrian Bezirke (Vienna's own districts are already
// terms) and for the Gemeinden in each PLZ ("Perchtoldsdorf" -> 2380). A
// Gemeinde with many PLZ that is also a Bezirk name ("Graz", "Linz") is
// left to the Bezirk; otherwise its PLZ are ranked by size.
function addAreaTerms(addTerm, areaPlz, bezirke) {
  const bezirkKeys = new Set();
  for (const b of bezirke.values()) {
    if (b.code.startsWith('9')) continue;
    addTerm('bezirk', b.code, b.name);
    for (const a of b.aliases) addTerm('bezirk', b.code, a, 'alias');
    for (const nm of [b.name, ...b.aliases]) bezirkKeys.add(foldName(nm));
  }
  // PLZ named after the Gemeinde first, then those it only shares; each by size.
  const byName = new Map();
  const bySize = [...areaPlz.values()].sort((a, b) => b.n - a.n);
  for (const pass of [e => [e.name], e => e.more]) {
    for (const e of bySize) {
      for (const nm of pass(e)) {
        if (nm === 'Wien') continue;
        let list = byName.get(nm);
        if (!list) byName.set(nm, (list = []));
        list.push(e.code);
      }
    }
  }
  for (const [nm, codes] of byName) {
    if (codes.length > 3 && bezirkKeys.has(foldName(nm))) continue;
    // +1: a PLZ is more specific than the Bezirk of the same name.
    codes.forEach((code, i) => addTerm('postcode', code, nm, 'name', i ? -2 - i : 1));
  }
}

function groupStats(idx, keyOf) {
  const acc = new Map();
  for (let i = 0; i < idx.lat.length; i++) {
    const k = keyOf(i);
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { lat: 0, lon: 0, n: 0, plz: new Map() }));
    a.lat += idx.lat[i];
    a.lon += idx.lon[i];
    a.n++;
    const p = idx.data.plz[idx.data.ap[i]];
    a.plz.set(p, (a.plz.get(p) || 0) + 1);
  }
  for (const a of acc.values()) {
    a.lat /= a.n;
    a.lon /= a.n;
    a.mainPlz = [...a.plz.entries()].sort((x, y) => y[1] - x[1])[0][0];
  }
  return acc;
}

/* ------------------------------------------------------------------ coordinates / locator */

export function lookupCoordinates(idx, lat, lon) {
  const near = nearestPoints(idx.grid, lat, lon, 12, 1500);
  const base = { lat, lon, maidenhead: latLonToMaidenhead(lat, lon, 6) };
  if (!near.length) {
    return { ...base, postcode: null, district: null, confidence: 'low', nearestAddressDistanceMeters: null, alternatives: [],
      note: 'Weit entfernt von jeder Wiener Adresse (außerhalb Wiens?)' };
  }
  const weights = new Map();
  for (const { i, d } of near) {
    const p = idx.data.plz[idx.data.ap[i]];
    weights.set(p, (weights.get(p) || 0) + 1 / Math.max(d, 10));
  }
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const share = ranked[0][1] / total;
  const nearest = near[0];
  const d = Math.round(nearest.d);
  const confidence = d <= 100 && share >= 0.8 ? 'high' : d <= 400 && share >= 0.6 ? 'likely' : 'low';
  return {
    ...base,
    postcode: ranked[0][0],
    district: idx.data.ad[nearest.i],
    confidence,
    nearestAddressDistanceMeters: d,
    nearestAddress: addressLabel(idx, nearest.i),
    alternatives: ranked.slice(1).map(([p, w]) => ({ postcode: p, share: Math.round((w / total) * 100) / 100 })),
  };
}

export function lookupMaidenhead(idx, locator) {
  const loc = formatLocator(locator);
  const b = maidenheadToBounds(loc);
  if (!b) return null;
  const counts = new Map();
  pointsInBox(idx.grid, b.south, b.west, b.north, b.east, i => {
    const p = idx.data.plz[idx.data.ap[i]];
    counts.set(p, (counts.get(p) || 0) + 1);
  });
  const center = lookupCoordinates(idx, b.centerLat, b.centerLon);
  const areaPostcodes = postcodesInLocator(idx, loc);
  return {
    locator: loc,
    precision: loc.length,
    precisionName: locatorPrecisionName(loc.length),
    bounds: { west: b.west, east: b.east, south: b.south, north: b.north },
    center: { lat: b.centerLat, lon: b.centerLon },
    postalCodes: [...counts.entries()].sort((a, c) => c[1] - a[1]).map(([postcode, addressCount]) => ({ postcode, addressCount })),
    centerPostcode: center.postcode || areaPostcodes[0]?.postcode || null,
    areaPostcodes,
  };
}

// Austrian PLZ with a share of their addresses in this locator (from the
// build-time coverage lists, so only the main squares of each PLZ count).
// Sorted by estimated address count.
function postcodesInLocator(idx, loc) {
  const out = [];
  const key = loc.slice(0, 6);
  for (const e of idx.areaPlz.values()) {
    let share = 0;
    if (key.length === 6) share = e.loc6.find(l => l[0] === key)?.[1] || 0;
    else for (const [l4, s] of e.loc4) if (l4.startsWith(key)) share += s;
    if (share) out.push({ postcode: e.code, name: e.name, share, addressCount: Math.round((e.n * share) / 100) });
  }
  return out.sort((a, b) => b.addressCount - a.addressCount);
}

// PLZ and Gemeinde of a point outside Vienna (no address data there), an
// estimate without boundaries: of the Austrian PLZ whose addresses lie in
// its 6-character locator, the one with the nearest centre; else the
// nearest PLZ centre within 15 km. Without the areas file: nothing.
export function umlandArea(idx, lat, lon) {
  const loc = latLonToMaidenhead(lat, lon, 6);
  let best = null;
  for (const e of idx.areaPlz.values()) {
    const covers = e.loc6.some(l => l[0] === loc);
    const d = distanceMeters(lat, lon, e.lat, e.lon);
    if (!best || covers > best.covers || (covers === best.covers && d < best.d)) best = { e, d, covers };
  }
  if (!best || (!best.covers && best.d > 15000)) return { postcode: null, city: undefined, district: null };
  return { postcode: best.e.code, city: best.e.name, district: null };
}

/* ------------------------------------------------------------------ text candidates */

function addressLabel(idx, i) {
  const s = idx.streets.find(st => i >= st.start && i < st.start + st.count);
  const hn = idx.data.hn[i];
  return `${s ? s.name : '?'}${hn ? ' ' + hn : ''}, ${idx.data.plz[idx.data.ap[i]]} Wien`;
}

// All keys starting with prefix, by binary search over the sorted keys.
function keysWithPrefix(sorted, prefix) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < prefix) lo = mid + 1; else hi = mid;
  }
  const out = [];
  for (let i = lo; i < sorted.length && sorted[i].startsWith(prefix); i++) out.push(sorted[i]);
  return out;
}

// Text -> { termId: { base, kind, how, similarity } }
function textMatches(idx, text) {
  const out = new Map();
  const put = (t, base, how, similarity, exact = false) => {
    const prev = out.get(t);
    if (!prev || prev.base < base) out.set(t, { base, how, similarity, exact });
  };
  const qkeys = searchKeys(text);
  if (!qkeys.length) return out;
  // exact
  for (const k of qkeys) {
    for (const t of idx.keyTerms.get(k) || []) {
      const term = idx.terms[t];
      const nt = NAME_TYPES[term.nameType] || NAME_TYPES.alias;
      put(t, nt.base, nt.how, 1, true);
    }
  }
  // prefix (abbreviated input: "Quellen", "Donaust")
  const longest = qkeys.reduce((a, b) => (b.length > a.length ? b : a));
  if (longest.length >= 4) {
    // The shortest completions first, whatever kind of name they are.
    const found = new Set();
    for (const q of qkeys) for (const k of keysWithPrefix(idx.sortedKeys, q)) if (k.length > longest.length) found.add(k);
    for (const k of [...found].sort((a, b) => a.length - b.length).slice(0, 60)) {
      for (const t of idx.keyTerms.get(k)) put(t, SCORE.prefix - Math.min(15, (k.length - longest.length) / 2), 'Anfang passt', longest.length / k.length);
    }
  }
  // fuzzy (typos)
  if (longest.length >= 4) {
    for (const q of qkeys) {
      for (const [kid] of trigramCandidates(idx.trigrams, q, 150)) {
        const k = idx.keys[kid];
        const sim = nameSimilarity(q, k);
        if (sim < FUZZY_MIN_SIMILARITY) continue;
        for (const t of idx.keyTerms.get(k)) put(t, Math.round(SCORE.fuzzyMax * sim), 'ähnlich geschrieben', sim);
      }
    }
  }
  return out;
}

function makeResult(idx, type, label, lat, lon, extra) {
  return { type, label, lat, lon, maidenhead: latLonToMaidenhead(lat, lon, 6), ...extra };
}

function areaInfoOf(idx, e) {
  return {
    kind: e.kind, code: e.code, name: e.name, state: idx.states[e.state] || '', addresses: e.n,
    locators: e.loc6, locatorCount: e.n6, locators4: e.loc4,
    gemeinden: e.kind === 'postcode' ? [e.name, ...e.more] : undefined,
    postcodes: e.topPlz, bezirke: e.bezirke,
  };
}

// A whole PLZ area (Austria-wide data): centre + covered locators.
function postcodeResult(idx, e, extra) {
  const nr = e.state === 9 ? +e.code.slice(1, 3) : 0;
  return makeResult(idx, 'postcode', `${e.code} ${e.name}`, e.lat, e.lon, {
    postcode: e.code, city: e.name, district: nr >= 1 && nr <= 23 ? nr : undefined, bezirk: e.bezirke[0],
    source: 'bev', areaInfo: areaInfoOf(idx, e), note: 'Mitte des PLZ-Gebiets – kein genauer Ort', ...extra,
  });
}

function bezirkResult(idx, e, extra) {
  const state = idx.states[e.state];
  return makeResult(idx, 'bezirk', `Bezirk ${e.name}${state ? ', ' + state : ''}`, e.lat, e.lon, {
    bezirk: e.code, source: 'bev', areaInfo: areaInfoOf(idx, e),
    note: 'Bezirksmitte – Gebiet, kein genauer Ort', ...extra,
  });
}

function viennaDistrictArea(idx, nr) {
  const e = idx.bezirke.get(`9${String(nr).padStart(2, '0')}`);
  return e ? areaInfoOf(idx, e) : undefined;
}

// Expand a matched vocabulary term into concrete location candidates.
function expandTerm(idx, term, match, ev) {
  const out = [];
  const d = idx.data;
  if (term.kind === 'street') {
    const s = idx.streets[term.id];
    if (ev.houseNumber) {
      const want = normalizeHouseNumber(ev.houseNumber);
      const wantBase = want.split('/')[0];
      const wantNum = leadingNumber(want);
      const exact = [];
      for (let i = s.start; i < s.start + s.count; i++) {
        if (d.hn[i] && (idx.hnNorm[i] === want || idx.hnNorm[i] === wantBase)) exact.push(i);
      }
      if (!exact.length) {
        // Ranges like "40-44" contain 42.
        for (let i = s.start; i < s.start + s.count; i++) {
          const m = /^(\d+)[a-z]?-(\d+)/.exec(idx.hnNorm[i]);
          if (m && wantNum >= +m[1] && wantNum <= +m[2] && (+m[1] % 2) === (wantNum % 2)) exact.push(i);
        }
      }
      for (const i of exact) {
        out.push(makeResult(idx, 'address', `${s.name} ${d.hn[i]}`, idx.lat[i], idx.lon[i], {
          street: s.name, houseNumber: d.hn[i], postcode: d.plz[d.ap[i]], district: d.ad[i], source: 'vienna-ogd',
          base: match.base + (SCORE.exactAddress - SCORE.exactName), houseNumberMatch: true, match,
        }));
      }
      if (!exact.length && wantNum >= 0) {
        // Not found: nearest numbers on the same street (same side preferred), per PLZ.
        const byPlz = new Map();
        for (let i = s.start; i < s.start + s.count; i++) {
          if (idx.num[i] < 0) continue;
          const diff = Math.abs(idx.num[i] - wantNum) + ((idx.num[i] % 2) !== (wantNum % 2) ? 1000 : 0);
          const p = d.ap[i];
          const best = byPlz.get(p);
          if (!best || diff < best.diff) byPlz.set(p, { i, diff });
        }
        for (const { i } of byPlz.values()) {
          out.push(makeResult(idx, 'address', `${s.name} ${d.hn[i]}`, idx.lat[i], idx.lon[i], {
            street: s.name, houseNumber: d.hn[i], postcode: d.plz[d.ap[i]], district: d.ad[i], source: 'vienna-ogd',
            base: match.base, houseNumberNear: true, match,
            note: `Nr. ${ev.houseNumber} nicht gefunden – nächste Nr. ${d.hn[i]}`,
          }));
        }
      }
      if (out.length) return out;
    }
    // Street without (found) number: one candidate per PLZ section.
    const groups = new Map();
    for (let i = s.start; i < s.start + s.count; i++) {
      const p = d.ap[i];
      let g = groups.get(p);
      if (!g) groups.set(p, (g = { lat: 0, lon: 0, n: 0, dist: d.ad[i] }));
      g.lat += idx.lat[i];
      g.lon += idx.lon[i];
      g.n++;
    }
    for (const [p, g] of groups) {
      out.push(makeResult(idx, 'street', s.name, g.lat / g.n, g.lon / g.n, {
        street: s.name, postcode: d.plz[p], district: g.dist, source: 'vienna-ogd', base: match.base, match,
        note: ev.houseNumber ? `Nr. ${ev.houseNumber} nicht gefunden` : (groups.size > 1 ? `Straßenabschnitt im ${d.plz[p]}` : undefined),
      }));
    }
  } else if (term.kind === 'place') {
    const p = idx.places[term.id];
    let c = p.umland ? null : lookupCoordinates(idx, p.lat, p.lon);
    // Around Vienna, or a Vienna dataset's name just outside the city ("Flughafen Wien").
    if (!c?.postcode) c = umlandArea(idx, p.lat, p.lon);
    out.push(makeResult(idx, 'poi', p.name, p.lat, p.lon, {
      postcode: c.postcode || undefined, city: c.city, district: c.district || undefined, source: PLACE_SOURCE[p.sources[0]] || p.sources[0], sources: p.sources,
      category: p.cat, role: placeRole(p), umland: p.umland || undefined,
      base: match.base + (p.landmark ? SCORE.landmark : 0) - (p.umland ? UMLAND_PENALTY : 0), match,
    }));
  } else if (term.kind === 'district') {
    const st = idx.districtStats.get(term.id);
    const dd = idx.districts.get(term.id);
    if (st) {
      out.push(makeResult(idx, 'district', `${term.id}. Bezirk, ${dd.name}`, st.lat, st.lon, {
        postcode: st.mainPlz, district: term.id, source: 'computed', base: match.base, match,
        areaInfo: viennaDistrictArea(idx, term.id), note: 'Bezirksmitte – Gebiet, kein genauer Ort',
      }));
    }
  } else if (term.kind === 'family') {
    // "Gürtel": every member street, never one of them for sure.
    for (const sid of idx.families[term.id].members) {
      for (const r of expandTerm(idx, { kind: 'street', id: sid }, { ...match, base: match.base - 3 }, ev)) {
        out.push({ ...r, note: r.note || `„${term.label}“`, cap: 'likely' });
      }
    }
  } else if (term.kind === 'bezirk') {
    out.push(bezirkResult(idx, idx.bezirke.get(term.id), { base: match.base, match }));
  } else if (term.kind === 'postcode') {
    const e = idx.areaPlz.get(term.id);
    const extra = { base: match.base + term.bonus, match };
    if (term.label !== e.name) extra.note = `Gemeinde ${term.label} – Mitte des PLZ-Gebiets`;
    out.push(postcodeResult(idx, e, extra));
  }
  // Found by another name than the result's own: say which, and how it is
  // known ("Rudolfstiftung" -> Klinik Landstraße, a former name).
  if (term.alias && term.nameType && term.label) {
    for (const r of out) {
      if (r.label === term.label) continue;
      r.matchedName ??= term.label;
      r.nameType ??= term.nameType;
      r.cap ??= 'high';
    }
  }
  return out;
}

// Data source codes (schema 2) -> result `source`.
const PLACE_SOURCE = { osm: 'osm', gip: 'gip', wl: 'wl', curated: 'alias' };

// What the point of a place stands for (a label is not an entrance).
function placeRole(p) {
  if (p.cat === 'stop' || /railway=(station|halt)|public_transport=station|gip:(u-bahnstation|bahnhof)/i.test(p.cat)) return 'stop';
  if (/^place=|^gip:(flurname|katastralgemeinde|gemeindebezirk|wohngebiete|riedbezeichnung|gartensiedlung)/i.test(p.cat)) return 'area';
  if (p.cat.startsWith('gip:')) return 'label_point';
  return 'point';
}

/* ------------------------------------------------------------------ structured free text */

// What a corner side can mean: streets (their address points), family
// members, or a named place (one point, e.g. a bridge). The best few,
// keyed "s<id>" / "p<id>": { name, pts: [[lat, lon], ...], base }.
function cornerSide(idx, text) {
  const best = new Map();
  const set = (key, name, pts, base) => { if (!(best.get(key)?.base >= base)) best.set(key, { name, pts, base }); };
  const streetPts = sid => {
    const st = idx.streets[sid], pts = [];
    for (let i = st.start; i < st.start + st.count; i++) pts.push([idx.lat[i], idx.lon[i]]);
    return pts;
  };
  for (const [t, m] of textMatches(idx, text)) {
    if (m.base < SCORE.fuzzyMax * 0.9) continue;
    const term = idx.terms[t];
    if (term.kind === 'street') set(`s${term.id}`, idx.streets[term.id].name, () => streetPts(term.id), m.base);
    else if (term.kind === 'family') for (const sid of idx.families[term.id].members) set(`s${sid}`, idx.streets[sid].name, () => streetPts(sid), m.base - 1);
    else if (term.kind === 'place' && !idx.places[term.id].umland) {
      const p = idx.places[term.id];
      set(`p${term.id}`, p.name, () => [[p.lat, p.lon]], m.base - 2);
    }
  }
  const top = Math.max(0, ...[...best.values()].map(b => b.base));
  return [...best.values()].filter(b => b.base >= top - 8).map(b => ({ ...b, pts: b.pts() }));
}

// "Gürtel Ecke Thaliastraße": the two sides' nearest points (corner houses
// carry both addresses, so usually 0 m apart); their midpoint. Up to
// CORNER_MAX_METERS a corner, up to CORNER_VAGUE_METERS a vague one (a
// bridge or square has one point only). Neither: each side on its own, so
// the operator still gets something to pick.
function cornerResults(idx, ev) {
  const out = [];
  const cos = Math.cos(48.2 * Math.PI / 180);
  for (const [a, b] of cornerSplits(ev.text)) {
    const A = cornerSide(idx, a), B = cornerSide(idx, b);
    if (!A.length || !B.length) continue;
    let best = null;
    for (const sa of A) {
      for (const sb of B) {
        if (sa.name === sb.name) continue;
        for (const [la1, lo1] of sa.pts) {
          for (const [la2, lo2] of sb.pts) {
            const dy = la1 - la2, dx = (lo1 - lo2) * cos;
            const d2 = dy * dy + dx * dx;
            if (!best || d2 < best.d2) best = { d2, sa, sb, lat: (la1 + la2) / 2, lon: (lo1 + lo2) / 2 };
          }
        }
      }
    }
    const meters = best ? Math.sqrt(best.d2) * 111320 : Infinity;
    if (meters <= CORNER_VAGUE_METERS) {
      const vague = meters > CORNER_MAX_METERS;
      // Two exactly named streets (or a family) make a "likely" corner; vague ones stay "low".
      const base = Math.min(best.sa.base, best.sb.base) + 3 - (vague ? 15 : 0);
      const c = lookupCoordinates(idx, best.lat, best.lon);
      // "„Gürtel“ = Lerchenfelder Gürtel": what each side was taken to mean.
      const resolved = [[a, best.sa.name], [b, best.sb.name]]
        .filter(([t, n]) => !searchKeys(t).some(k => searchKeys(n).includes(k))).map(([t, n]) => `„${t}“ = ${n}`);
      out.push(makeResult(idx, 'intersection', `${best.sa.name} / ${best.sb.name}`, best.lat, best.lon, {
        street: best.sa.name, crossStreet: best.sb.name, postcode: c.postcode, district: c.district, source: 'computed',
        resolved: resolved.length ? resolved : undefined,
        base, match: { base, how: 'Kreuzung', similarity: base / SCORE.exactName }, cap: vague ? 'low' : 'likely',
        note: vague ? `Kreuzung ungefähr – nächste Punkte ${Math.round(meters / 10) * 10} m auseinander`
          : `Kreuzung – aus Adresspunkten geschätzt${meters >= 20 ? ` (Abstand ${Math.round(meters)} m)` : ''}`,
      }));
    } else {
      for (const side of [a, b]) {
        for (const [t, m] of textMatches(idx, side)) {
          if (m.base < SCORE.prefix) continue;
          for (const r of expandTerm(idx, idx.terms[t], m, ev)) out.push({ ...r, cap: 'low', note: `Kreuzung „${a}“ / „${b}“ nicht gefunden` });
        }
      }
    }
  }
  return out;
}

// "zwischen Praterstern und Riesenrad": the midpoint of the two places.
function betweenResult(idx, a, b, opts) {
  const ra = locate(idx, a, { ...opts, autoSelect: 'none' }).results[0];
  const rb = locate(idx, b, { ...opts, autoSelect: 'none' }).results[0];
  if (!ra || !rb) return null;
  const d = distanceMeters(ra.lat, ra.lon, rb.lat, rb.lon);
  if (d > BETWEEN_MAX_METERS) return null;
  const lat = (ra.lat + rb.lat) / 2, lon = (ra.lon + rb.lon) / 2;
  const c = lookupCoordinates(idx, lat, lon);
  return {
    ...makeResult(idx, 'between', `zwischen ${ra.label} und ${rb.label}`, lat, lon, {
      postcode: c.postcode, district: c.district, source: 'computed',
      note: `Mitte zwischen zwei Orten, ${Math.round(d / 10) * 10} m auseinander`,
    }),
    score: Math.min(ra.score, rb.score), confidence: 'likely', evidence: {},
    reasons: [`zwischen „${a}“ und „${b}“`],
  };
}

// "Kirche Mauer", "U6 Josefstädter Straße", "Spital Floridsdorf".
function categoryResults(idx, ev, { category, word, rest }) {
  const out = [];
  // 1. The official name uses another category word ("Klinik Floridsdorf").
  for (const syn of new Set([word, ...category.syn])) {
    for (const text of [`${syn} ${rest}`, `${rest} ${syn}`]) {
      for (const k of searchKeys(text)) {
        for (const t of idx.keyTerms.get(k) || []) {
          const match = { base: SCORE.categoryRewrite, how: `„${word}“ → Name`, similarity: 1 };
          for (const r of expandTerm(idx, idx.terms[t], match, ev)) out.push({ ...r, cap: 'high' });
        }
      }
    }
  }
  // 2. The rest names the place itself, and its category fits ("U6" + station).
  const contexts = [];
  const others = [];
  for (const [t, m] of textMatches(idx, rest)) {
    for (const r of expandTerm(idx, idx.terms[t], m, ev)) {
      if (r.type === 'poi' && category.cat.test(r.category)) {
        out.push({ ...r, base: r.base + SCORE.categoryFits, match: { ...m, how: `${m.how}, ${word} passt` } });
      } else {
        others.push(r);
      }
      if (m.base >= SCORE.prefix - 3) contexts.push(r);
    }
  }
  // 3. Places of that category near what the rest names ("Kirche" near "Mauer").
  contexts.sort((a, b) => b.base - a.base);
  const seen = new Set();
  for (const c of contexts.slice(0, 3)) {
    const radius = c.type === 'poi' || c.type === 'street' || c.type === 'address' ? NEAR_CONTEXT_METERS : NEAR_AREA_METERS;
    idx.places.forEach((p, pid) => {
      if (seen.has(pid) || !category.cat.test(p.cat)) return;
      const d = distanceMeters(c.lat, c.lon, p.lat, p.lon);
      if (d > radius) return;
      seen.add(pid);
      const base = SCORE.nearContextMax - Math.round(10 * d / radius);
      const match = { base, how: `${word} bei ${c.label}`, similarity: 1 };
      for (const r of expandTerm(idx, { kind: 'place', id: pid, label: p.name }, match, ev)) {
        out.push({ ...r, cap: 'likely', note: `${Math.round(d / 10) * 10} m von ${c.label}` });
      }
    });
  }
  // Nothing of that category: still offer what the rest names.
  if (!out.length) {
    for (const r of others) out.push({ ...r, base: r.base - 10, cap: 'likely', note: `kein Ort der Art „${word}“ gefunden` });
  }
  return out;
}

// Names that contain every word of the query ("Ottakringer Brauerei" ->
// "Alte Technik - Ottakringer Brauerei"); fewer extra words rank higher.
function wordResults(idx, ev) {
  const variants = [false, true].map(plain => foldName(ev.text, plain).split(' '));
  const n = variants[0].length;
  if (n !== variants[1].length) return [];
  const lists = [];
  for (let i = 0; i < n; i++) {
    const w = variants[0][i];
    if (w.length < 2 || STOP_WORDS.has(w)) continue;
    lists.push(new Set([...(idx.words.get(w) || []), ...(idx.words.get(variants[1][i]) || [])]));
  }
  if (lists.length < 2) return [];
  lists.sort((a, b) => a.size - b.size);
  const out = [];
  for (const t of lists[0]) {
    if (!lists.every(l => l.has(t))) continue;
    const term = idx.terms[t];
    const words = term.forms[0].split(' ').filter(w => w.length >= 2 && !STOP_WORDS.has(w)).length;
    const base = Math.max(70, SCORE.wordsMax - 2 * (words - lists.length));
    const match = { base, how: 'alle Wörter im Namen', similarity: lists.length / Math.max(words, 1) };
    for (const r of expandTerm(idx, term, match, ev)) out.push({ ...r, cap: 'likely' });
    if (out.length > 40) break;
  }
  return out;
}

function applyEvidence(idx, r, ev, lb) {
  const why = [];
  let score = r.base;
  const evidence = { textSimilarity: r.match ? Math.round(r.match.similarity * 100) / 100 : undefined };
  if (r.match) why.push(r.match.how);
  if (ev.relation) why.push(`Lage „${ev.relation}“`);
  // "Hauptstraße", "Bahnhofstraße": only with a PLZ/district/locator for Vienna.
  if ((r.type === 'street' || r.type === 'address') && r.street && !ev.postcode && !ev.district && !lb
      && searchKeys(r.street).some(k => idx.genericStreets.has(k))) {
    r = { ...r, cap: 'likely' };
    why.push('häufiger Straßenname – PLZ oder Bezirk angeben');
  }
  if (r.houseNumberMatch) { score += SCORE.houseExact; evidence.houseNumberMatch = true; why.push('Hausnummer exakt'); }
  if (r.houseNumberNear) { score += SCORE.houseNear; why.push('Hausnummer in der Nähe'); }
  if (ev.postcode && r.type === 'bezirk') {
    const e = idx.areaPlz.get(ev.postcode);
    if (e && e.bezirke.includes(r.bezirk)) { score += SCORE.plzMatch; evidence.postcodeMatch = true; why.push('PLZ liegt im Bezirk'); }
    else { score += SCORE.plzMismatch; evidence.postcodeMatch = false; why.push('PLZ nicht im Bezirk'); }
  } else if (ev.postcode) {
    if (r.postcode === ev.postcode) { score += SCORE.plzMatch; evidence.postcodeMatch = true; why.push('PLZ passt'); }
    else { score += SCORE.plzMismatch; evidence.postcodeMatch = false; why.push(`andere PLZ (${r.postcode})`); }
  }
  if (ev.bezirkHint && (r.type === 'bezirk' || r.type === 'district')) {
    score += SCORE.districtMatch;
    why.push('als Bezirk gesucht');
  }
  if (ev.district && (r.district || !r.areaInfo)) {
    if (r.district === ev.district) { score += SCORE.districtMatch; evidence.districtMatch = true; why.push('Bezirk passt'); }
    else { score += SCORE.districtMismatch; evidence.districtMatch = false; why.push('anderer Bezirk'); }
  }
  if (lb) {
    // Coarse locators are weak evidence, fine ones strong.
    const weight = lb.precision >= 6 ? 1 : lb.precision === 4 ? 0.5 : 0.15;
    const inside = r.lat >= lb.south && r.lat < lb.north && r.lon >= lb.west && r.lon < lb.east;
    if (inside) { score += SCORE.locatorInside * weight; evidence.locatorMatch = true; why.push('im Locator'); }
    else {
      const dist = distanceMeters(r.lat, r.lon, Math.max(lb.south, Math.min(lb.north, r.lat)), Math.max(lb.west, Math.min(lb.east, r.lon)));
      const size = distanceMeters(lb.south, lb.west, lb.north, lb.west);
      if (dist <= size) { score += SCORE.locatorNear * weight; evidence.locatorMatch = false; why.push('nahe am Locator'); }
      else { score += SCORE.locatorOutside * weight; evidence.locatorMatch = false; why.push('außerhalb des Locators'); }
    }
  }
  evidence.exactAddress = !!r.houseNumberMatch && !!r.match?.exact;
  evidence.exactAlias = !!r.match?.exact && !!r.nameType;
  return { ...r, score: Math.round(score), evidence, reasons: why };
}

function confidenceOf(r) {
  const contradicted = r.evidence.postcodeMatch === false || r.evidence.districtMatch === false
    || (r.evidence.locatorMatch === false && r.reasons.includes('außerhalb des Locators'));
  if (!contradicted && r.score >= 120 && (r.evidence.exactAddress || r.type !== 'address')) return 'exact';
  if (r.score >= 110) return 'high';
  if (r.score >= 88) return 'likely';
  return 'low';
}

// One area inside the other (PLZ in its Bezirk, Vienna PLZ in its district):
// not two competing places.
function nestedAreas(a, b) {
  const inside = (p, z) => p.type === 'postcode' && (
    (z.type === 'bezirk' && !!p.areaInfo?.bezirke?.includes(z.bezirk))
    || (z.type === 'district' && p.district === z.district));
  return inside(a, b) || inside(b, a);
}

function finish(results, opts) {
  results.sort((a, b) => b.score - a.score);
  // Drop near-duplicates (same label within 800 m, e.g. a district's
  // suburb node and its station).
  const kept = [];
  for (const r of results) {
    if (!kept.some(k => k.label === r.label && distanceMeters(k.lat, k.lon, r.lat, r.lon) < 800)) kept.push(r);
  }
  const top = kept.slice(0, opts.limit || 8);
  for (const r of top) r.confidence = confidenceOf(r);
  // An exact name/alias with no serious competitor elsewhere is a confident
  // hit even without further evidence ("Stephansplatz", "AKH").
  const t0 = top[0];
  if (t0 && t0.confidence === 'likely' && t0.match && (t0.match.exact || t0.match.base >= SCORE.exactAlias)
      && ![t0.evidence.postcodeMatch, t0.evidence.districtMatch, t0.evidence.locatorMatch].includes(false)
      && !top.slice(1).some(r => r.score >= t0.score - 15 && distanceMeters(t0.lat, t0.lon, r.lat, r.lon) > 500 && !nestedAreas(t0, r))) {
    t0.confidence = 'high';
    t0.reasons.push('eindeutig');
  }
  for (const r of top) {
    delete r.base;
    delete r.match;
  }
  // Two strong candidates far apart: don't pretend to know which one.
  if (top.length > 1 && top[0].confidence !== 'exact'
      && top[1].score >= top[0].score - 8
      && !nestedAreas(top[0], top[1])
      && distanceMeters(top[0].lat, top[0].lon, top[1].lat, top[1].lon) > 500) {
    top[0].confidence = 'ambiguous';
    if (CONFIDENCE_ORDER.indexOf(top[1].confidence) > 1) top[1].confidence = 'ambiguous';
  }
  // Inferred matches (corners, families, category + context, generic street
  // names, other name types) never claim more than their cap, last.
  for (const r of top) {
    if (r.cap && CONFIDENCE_ORDER.indexOf(r.confidence) > CONFIDENCE_ORDER.indexOf(r.cap)) r.confidence = r.cap;
    delete r.cap;
  }
  return top;
}

/* ------------------------------------------------------------------ main entry */

// A UTMREF: like a locator an area (the square), the point is its middle.
// 8 or 10 digits (10 m / 1 m) count as an exact position near an address.
function utmResult(idx, u, ref) {
  const b = mgrsToBounds(u);
  const c = lookupCoordinates(idx, b.centerLat, b.centerLon);
  const area = c.postcode ? null : umlandArea(idx, b.centerLat, b.centerLon);
  const name = mgrsPrecisionName(u.digits);
  const notes = [
    u.zoneGiven ? null : `ohne Zone eingegeben – ${u.zone}${u.band} angenommen${ref?.source ? ` (${ref.source})` : ''}`,
    u.digits < 8 ? `UTMREF ist ein Gebiet (${name}); Punkt = Mitte des Quadrats` : null,
    c.postcode ? null : c.note,
  ].filter(Boolean);
  return {
    type: 'utm', label: `${u.text} (${name})`, lat: b.centerLat, lon: b.centerLon,
    maidenhead: c.maidenhead, postcode: c.postcode || area?.postcode || undefined, city: area?.city, district: c.district,
    utm: u.text, source: 'computed', score: 100,
    confidence: u.digits >= 8 && c.confidence !== 'low' ? 'exact' : 'likely',
    reasons: [c.postcode ? `nächste Adresse ${c.nearestAddressDistanceMeters} m (${c.nearestAddress})` : 'UTMREF'],
    evidence: {}, note: notes.length ? notes.join(' · ') : undefined,
    utmInfo: { text: u.text, digits: u.digits, precisionName: name, zoneGiven: u.zoneGiven,
      bounds: { west: b.west, east: b.east, south: b.south, north: b.north }, center: { lat: b.centerLat, lon: b.centerLon } },
  };
}

// opts.autoSelect: minimum confidence to auto-pick results[0] ('exact' | 'high' | 'likely';
// anything else, e.g. 'none', disables auto-selection). opts.limit: max results.
// opts.utmRef: { zone, band, source? } for a UTMREF typed without zone
// (the own location's zone; default 33U).
export function locate(idx, input, opts = {}) {
  // District names ("Favoriten Quellenstr") are only peeled off when the
  // text as a whole isn't already a known name ("UNO City", "Landstraßer Gürtel").
  const known = t => searchKeys(t).some(k => idx.keyTerms.has(k));
  let ev = parseLocationInput(rewriteOrdinals(input), undefined, idx.postcodeSet, opts.utmRef);
  if (ev.text && !ev.district && !known(ev.text)) {
    ev = parseLocationInput(rewriteOrdinals(input), idx.districtNames, idx.postcodeSet, opts.utmRef);
  }
  // A number that belongs to the name ("Zentralfriedhof Tor 2"), not a house number.
  if (ev.houseNumber && known(`${ev.street} ${ev.houseNumber}`)) {
    ev.text = `${ev.street} ${ev.houseNumber}`;
    delete ev.street;
    delete ev.houseNumber;
  }
  // "Wien Mitte", "Wien Museum": the city name is part of the name here.
  const whole = String(input ?? '').trim();
  if (/(^|\s)(wien|vienna)(\s|$)/i.test(whole) && known(whole)) ev = { raw: whole, text: whole };
  // "beim Schottentor", "Nähe Praterstern" — unless that is the name ("Am Spitz").
  if (ev.text && !known(ev.text)) {
    const rel = splitRelation(ev.text);
    if (rel && (!rel.weak || known(rel.rest))) {
      ev.relation = rel.relation;
      ev.text = rel.rest;
      if (ev.street) ev.street = splitRelation(ev.street)?.rest || ev.street;
    }
  }
  const minConf = opts.autoSelect || 'high';
  const pack = results => ({
    evidence: ev,
    results,
    // An unknown level (e.g. 'none') never auto-selects.
    autoSelect: results[0] && CONFIDENCE_ORDER.includes(minConf)
      && CONFIDENCE_ORDER.indexOf(results[0].confidence) >= CONFIDENCE_ORDER.indexOf(minConf) ? results[0] : null,
  });

  if (ev.utm) return pack([utmResult(idx, ev.utm, opts.utmRef)]);

  if (ev.latitude !== undefined) {
    const c = lookupCoordinates(idx, ev.latitude, ev.longitude);
    return pack([{
      type: 'coordinate', label: `${ev.latitude.toFixed(5)}, ${ev.longitude.toFixed(5)}`,
      lat: ev.latitude, lon: ev.longitude, maidenhead: c.maidenhead, postcode: c.postcode, district: c.district,
      source: 'computed', score: 100, confidence: c.confidence === 'low' ? 'likely' : 'exact',
      reasons: [c.postcode ? `nächste Adresse ${c.nearestAddressDistanceMeters} m (${c.nearestAddress})` : c.note],
      evidence: {}, coordinate: c, note: c.postcode ? undefined : c.note,
    }]);
  }

  // "zwischen A und B": the midpoint, plus A and B themselves.
  const zw = ev.text && /^zwischen\s+(.+?)\s+(?:und|u\.|&|\/)\s+(.+)$/i.exec(ev.text);
  if (zw) {
    const mid = betweenResult(idx, zw[1], zw[2], opts);
    if (mid) {
      const sides = [zw[1], zw[2]].map(t => locate(idx, t, { ...opts, autoSelect: 'none' }).results[0]);
      return pack([mid, ...sides.map(r => ({ ...r, confidence: 'low' }))]);
    }
  }

  const lb = ev.locator ? maidenheadToBounds(ev.locator) : null;
  // A PLZ outside Vienna: there are no streets there, so only area names
  // (Gemeinde, Bezirk) and places around Vienna can match the text.
  const outside = ev.postcode && !idx.viennaPlz.has(ev.postcode);
  let results = [];
  if (ev.text && /^\d{2,3}$/.test(ev.text) && !ev.postcode) {
    // PLZ being typed: "23" -> 2320, 2340, ...
    for (const e of idx.areaPlz.values()) {
      if (e.code.startsWith(ev.text)) results.push({ ...postcodeResult(idx, e), score: 70 + Math.log10(e.n + 1), reasons: ['PLZ beginnt so'], evidence: {} });
    }
    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, opts.limit || 8);
    for (const r of results) { r.score = Math.round(r.score); r.confidence = 'low'; }
    return pack(results);
  }
  if (ev.text) {
    let exact = false;
    for (const [t, match] of textMatches(idx, ev.text)) {
      const term = idx.terms[t];
      if (outside && term.kind !== 'postcode' && term.kind !== 'bezirk'
          && !(term.kind === 'place' && idx.places[term.id].umland)) continue;
      if (match.exact) exact = true;
      for (const r of expandTerm(idx, term, match, ev)) results.push(applyEvidence(idx, r, ev, lb));
    }
    // Not a known name as a whole: a street corner, a category word next to
    // a name or area, or a name containing all the words.
    // "Spital Floridsdorf": the parser took the district, the category word is left.
    const cat = !outside && ev.district && !ev.houseNumber && categoryOfWord(ev.text);
    if (cat) {
      const sc = { category: cat, word: ev.text, rest: idx.districts.get(ev.district).name };
      for (const r of categoryResults(idx, ev, sc)) results.push(applyEvidence(idx, r, ev, lb));
    } else if (!exact && !outside) {
      const more = cornerResults(idx, ev);
      const sc = splitCategory(ev.text);
      if (sc) more.push(...categoryResults(idx, ev, sc));
      more.push(...wordResults(idx, ev));
      for (const r of more) results.push(applyEvidence(idx, r, ev, lb));
    }
  }
  if (!ev.text || !results.length) {
    // Only structured evidence: PLZ, district or locator as an area result.
    if (ev.postcode && idx.areaPlz.has(ev.postcode)) {
      const r = postcodeResult(idx, idx.areaPlz.get(ev.postcode));
      if (ev.text) r.note = outside ? `„${ev.text}“: Straßen gibt es nur für Wien, Orte nur rund um Wien – Mitte des PLZ-Gebiets` : `„${ev.text}“ nicht gefunden – Mitte des PLZ-Gebiets`;
      results.push({ ...r, score: 100, confidence: ev.text ? 'low' : 'likely', reasons: ['PLZ'], evidence: { postcodeMatch: true } });
    } else if (ev.postcode && idx.plzStats.has(ev.postcode)) {
      const st = idx.plzStats.get(ev.postcode);
      results.push({ ...makeResult(idx, 'postcode', `${ev.postcode} Wien`, st.lat, st.lon, {
        postcode: ev.postcode, source: 'computed', note: 'Mitte des PLZ-Gebiets – kein genauer Ort' }),
      score: 100, confidence: ev.text ? 'low' : 'likely', reasons: ['PLZ'], evidence: { postcodeMatch: true } });
    } else if (ev.district && idx.districtStats.has(ev.district)) {
      const st = idx.districtStats.get(ev.district);
      results.push({ ...makeResult(idx, 'district', `${ev.district}. Bezirk, ${idx.districts.get(ev.district).name}`, st.lat, st.lon, {
        postcode: st.mainPlz, district: ev.district, source: 'computed', areaInfo: viennaDistrictArea(idx, ev.district),
        note: 'Bezirksmitte – Gebiet, kein genauer Ort' }),
      score: 100, confidence: ev.text ? 'low' : 'likely', reasons: ['Bezirk'], evidence: { districtMatch: true } });
    } else if (lb && !ev.text) {
      const m = lookupMaidenhead(idx, ev.locator);
      results.push({ ...makeResult(idx, 'maidenhead', `${m.locator} (${m.precisionName})`, m.center.lat, m.center.lon, {
        postcode: m.centerPostcode, city: idx.areaPlz.get(m.centerPostcode)?.name, source: 'computed', note: 'Locator ist ein Gebiet; Punkt = Mitte des Feldes' }),
      maidenhead: m.locator, score: 100, confidence: 'likely', reasons: ['Locator'], evidence: {}, maidenheadInfo: m });
    }
    return pack(results);
  }
  return pack(finish(results, opts));
}
