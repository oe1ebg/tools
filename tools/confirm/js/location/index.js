// Offline location lookup: operator input -> ranked candidates with PLZ,
// coordinates and Maidenhead locator. Streets/addresses/landmarks: Vienna
// only (data/vienna-locations.json, scripts/build_location_data.py). PLZ and
// political Bezirke: all of Austria, with the locator squares they cover
// (data/austria-areas.json, scripts/build_austria_areas.py; optional).
// Design: oe1ebg/confirm-README.md.
//
//   const idx = buildLocationIndex(data, areas);
//   locate(idx, 'Waehringerstr 42 1180')   -> { evidence, results, autoSelect }
//   lookupCoordinates(idx, 48.21, 16.37)    -> { postcode, district, ... }
//   lookupMaidenhead(idx, 'JN88ee')         -> { bounds, postalCodes, ... }

import { latLonToMaidenhead, maidenheadToBounds, isValidLocator, locatorPrecisionName, formatLocator } from './maidenhead.js';
import { foldName, searchKeys, normalizeHouseNumber, leadingNumber } from './normalize.js';
import { parseLocationInput } from './parse.js';
import { buildTrigramIndex, trigramCandidates, nameSimilarity } from './fuzzy.js';
import { distanceMeters, buildGrid, nearestPoints, pointsInBox } from './spatial.js';

// Ranking (see the brief): text match base + structured-evidence bonuses.
export const SCORE = {
  exactAddress: 100, exactName: 95, exactAlias: 90, prefix: 85, fuzzyMax: 80,
  plzMatch: 30, plzMismatch: -25, districtMatch: 20, districtMismatch: -15,
  locatorInside: 30, locatorNear: 10, locatorOutside: -20,
  houseExact: 20, houseNear: 5, landmark: 3,
};
const FUZZY_MIN_SIMILARITY = 0.6;
const CONFIDENCE_ORDER = ['low', 'ambiguous', 'likely', 'high', 'exact'];

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
  const places = data.places.map(([name, cat, la, lo, alts]) => ({
    name, cat, alts, lat: data.latBase + la / S, lon: data.lonBase + lo / S,
    landmark: /^(place|natural=(peak|hill|island)|tourism=(attraction|viewpoint)|railway=station|landmark)/.test(cat),
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
  const terms = []; // { kind: street|place|district|bezirk|postcode, id, label, alias, bonus }
  const keyTerms = new Map(); // compact key -> [term ids]
  const addTerm = (kind, id, text, alias, bonus = 0) => {
    const t = terms.push({ kind, id, label: text, alias, bonus }) - 1;
    for (const k of searchKeys(text)) {
      let list = keyTerms.get(k);
      if (!list) keyTerms.set(k, (list = []));
      list.push(t);
    }
  };
  streets.forEach((s, i) => addTerm('street', i, s.name, false));
  places.forEach((p, i) => {
    addTerm('place', i, p.name, false);
    for (const a of p.alts) addTerm('place', i, a, true);
  });
  for (const d of districts.values()) for (const nm of d.names) addTerm('district', d.nr, nm, d.names[0] !== nm);
  for (const [alias, kind, id] of data.aliases) addTerm(kind, id, alias, true);
  addAreaTerms(addTerm, areaPlz, bezirke);

  const keys = [...keyTerms.keys()];
  const idx = {
    data, lat, lon, num, hnNorm, streets, places, districts, districtNames,
    areaPlz, bezirke, states,
    viennaPlz: new Set(data.plz),
    postcodeSet: new Set([...data.plz, ...areaPlz.keys()]),
    terms, keyTerms, keys,
    trigrams: buildTrigramIndex(keys),
    grid: buildGrid(lat, lon),
    meta: data.meta,
    areasMeta: areas?.meta || null,
    counts: { addresses: n, streets: streets.length, places: places.length, postcodes: areaPlz.size, bezirke: bezirke.size },
  };
  // District/PLZ centroids from their addresses.
  idx.districtStats = groupStats(idx, i => data.ad[i]);
  idx.plzStats = groupStats(idx, i => data.plz[data.ap[i]]);
  return idx;
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
    addTerm('bezirk', b.code, b.name, false);
    for (const a of b.aliases) addTerm('bezirk', b.code, a, true);
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
    codes.forEach((code, i) => addTerm('postcode', code, nm, false, i ? -2 - i : 1));
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

/* ------------------------------------------------------------------ text candidates */

function addressLabel(idx, i) {
  const s = idx.streets.find(st => i >= st.start && i < st.start + st.count);
  const hn = idx.data.hn[i];
  return `${s ? s.name : '?'}${hn ? ' ' + hn : ''}, ${idx.data.plz[idx.data.ap[i]]} Wien`;
}

// Text -> { termId: { base, kind, how, similarity } }
function textMatches(idx, text) {
  const out = new Map();
  const put = (t, base, how, similarity) => {
    const prev = out.get(t);
    if (!prev || prev.base < base) out.set(t, { base, how, similarity });
  };
  const qkeys = searchKeys(text);
  if (!qkeys.length) return out;
  // exact
  for (const k of qkeys) {
    for (const t of idx.keyTerms.get(k) || []) {
      const term = idx.terms[t];
      put(t, term.alias ? SCORE.exactAlias : SCORE.exactName, term.alias ? 'Alias exakt' : 'Name exakt', 1);
    }
  }
  // prefix (abbreviated input: "Quellen", "Donaust")
  const longest = qkeys.reduce((a, b) => (b.length > a.length ? b : a));
  if (longest.length >= 4) {
    let found = 0;
    for (const k of idx.keys) {
      if (k.length > longest.length && qkeys.some(q => k.startsWith(q))) {
        for (const t of idx.keyTerms.get(k)) put(t, SCORE.prefix - Math.min(15, (k.length - longest.length) / 2), 'Anfang passt', longest.length / k.length);
        if (++found > 60) break;
      }
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
    const c = lookupCoordinates(idx, p.lat, p.lon);
    out.push(makeResult(idx, 'poi', p.name, p.lat, p.lon, {
      postcode: c.postcode, district: c.district, source: p.cat === 'landmark' ? 'alias' : 'osm', category: p.cat,
      base: match.base + (p.landmark ? SCORE.landmark : 0), match,
      note: term.alias ? `„${term.label}“` : undefined,
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
  } else if (term.kind === 'bezirk') {
    out.push(bezirkResult(idx, idx.bezirke.get(term.id), { base: match.base, match }));
  } else if (term.kind === 'postcode') {
    const e = idx.areaPlz.get(term.id);
    const extra = { base: match.base + term.bonus, match };
    if (term.label !== e.name) extra.note = `Gemeinde ${term.label} – Mitte des PLZ-Gebiets`;
    out.push(postcodeResult(idx, e, extra));
  }
  return out;
}

function applyEvidence(idx, r, ev, lb) {
  const why = [];
  let score = r.base;
  const evidence = { textSimilarity: r.match ? Math.round(r.match.similarity * 100) / 100 : undefined };
  if (r.match) why.push(r.match.how);
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
  evidence.exactAddress = !!r.houseNumberMatch && r.match?.base >= SCORE.exactAlias;
  evidence.exactAlias = r.match?.how === 'Alias exakt';
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
  if (t0 && t0.confidence === 'likely' && t0.match && t0.match.base >= SCORE.exactAlias
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
  return top;
}

/* ------------------------------------------------------------------ main entry */

// opts.autoSelect: minimum confidence to auto-pick results[0] ('exact' | 'high' | 'likely';
// anything else, e.g. 'none', disables auto-selection). opts.limit: max results.
export function locate(idx, input, opts = {}) {
  // District names ("Favoriten Quellenstr") are only peeled off when the
  // text as a whole isn't already a known name ("UNO City", "Landstraßer Gürtel").
  let ev = parseLocationInput(input, undefined, idx.postcodeSet);
  if (ev.text && !ev.district && !searchKeys(ev.text).some(k => idx.keyTerms.has(k))) {
    ev = parseLocationInput(input, idx.districtNames, idx.postcodeSet);
  }
  const minConf = opts.autoSelect || 'high';
  const pack = results => ({
    evidence: ev,
    results,
    // An unknown level (e.g. 'none') never auto-selects.
    autoSelect: results[0] && CONFIDENCE_ORDER.includes(minConf)
      && CONFIDENCE_ORDER.indexOf(results[0].confidence) >= CONFIDENCE_ORDER.indexOf(minConf) ? results[0] : null,
  });

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

  const lb = ev.locator ? maidenheadToBounds(ev.locator) : null;
  // A PLZ outside Vienna: there are no street/landmark data there, so only
  // area names (Gemeinde, Bezirk) can match the text.
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
    for (const [t, match] of textMatches(idx, ev.text)) {
      const term = idx.terms[t];
      if (outside && term.kind !== 'postcode' && term.kind !== 'bezirk') continue;
      for (const r of expandTerm(idx, term, match, ev)) results.push(applyEvidence(idx, r, ev, lb));
    }
  }
  if (!ev.text || !results.length) {
    // Only structured evidence: PLZ, district or locator as an area result.
    if (ev.postcode && idx.areaPlz.has(ev.postcode)) {
      const r = postcodeResult(idx, idx.areaPlz.get(ev.postcode));
      if (ev.text) r.note = outside ? `„${ev.text}“: Straßen und Orte gibt es nur für Wien – Mitte des PLZ-Gebiets` : `„${ev.text}“ nicht gefunden – Mitte des PLZ-Gebiets`;
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
