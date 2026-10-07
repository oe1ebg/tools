// UTM and UTMREF (MGRS) <-> WGS84, dependency-free and offline.
//
// Projection: transverse Mercator with Krüger's series to 6th order in n
// (Karney 2011, "Transverse Mercator with an accuracy of a few
// nanometers"), accurate to well under a millimetre within a UTM zone.
// Grid: MGRS/UTMREF as used in Austria (Bundesheer, Feuerwehr, SKKM),
// written with spaces: "33U XP 02013 40385" = zone + latitude band, 100 km
// square, easting and northing digits (truncated, not rounded).
// Austria lies in zones 32 (west of 12° E) and 33, bands T and U.
// Polar regions (UPS, beyond 84° N / 80° S) are not supported.
//
// A UTMREF is an AREA like a Maidenhead locator: mgrsToBounds() returns its
// box; the point is the middle of the square.
//   latLonToMgrs(48.208493, 16.373118)        -> "33U XP 02013 40385"
//   latLonToMgrs(48.208493, 16.373118, 6)     -> "33U XP 020 403"
//   parseMgrs('XP 0201 4038', { zone: 33, band: 'U' }) -> { zone: 33, band: 'U', ... }

const UTM_A = 6378137;               // WGS84 semi-major axis
const UTM_F = 1 / 298.257223563;     // WGS84 flattening
const UTM_K0 = 0.9996;
const UTM_FALSE_EASTING = 500000;
const UTM_FALSE_NORTHING_S = 10000000;
const UTM_E = Math.sqrt(UTM_F * (2 - UTM_F));
const UTM_N = UTM_F / (2 - UTM_F);

function utmSeries() {
  const n = UTM_N, n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  return {
    A: UTM_A / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256),
    alpha: [
      n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
      13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
      61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
      49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
      34729 * n5 / 80640 - 3418889 * n6 / 1995840,
      212378941 * n6 / 319334400,
    ],
    beta: [
      n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
      n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
      17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
      4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
      4583 * n5 / 161280 - 108847 * n6 / 3991680,
      20648693 * n6 / 638668800,
    ],
  };
}
const UTM_SERIES = utmSeries();

const UTM_BANDS = 'CDEFGHJKLMNPQRSTUVWX';        // 8° each from 80° S; X is 12° (72-84° N)
const UTM_COL_SETS = ['STUVWXYZ', 'ABCDEFGH', 'JKLMNPQR']; // by zone % 3
const UTM_ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';   // 20 letters, no I/O; even zones start at F

const utmRad = d => d * Math.PI / 180;
const utmDeg = r => r * 180 / Math.PI;

// Latitude band letter, or '' outside 80° S ... 84° N.
export function utmBand(lat) {
  if (!(lat >= -80 && lat <= 84)) return '';
  return UTM_BANDS[Math.min(19, Math.floor((lat + 80) / 8))];
}

// UTM zone of a point, with the Norway (32V) and Svalbard (31X-37X) exceptions.
export function utmZoneOf(lat, lon) {
  const l = ((lon + 180) % 360 + 360) % 360 - 180;
  let zone = Math.min(60, Math.floor((l + 180) / 6) + 1);
  if (lat >= 56 && lat < 64 && l >= 3 && l < 12) zone = 32;
  if (lat >= 72 && lat <= 84 && l >= 0 && l < 42) zone = l < 9 ? 31 : l < 21 ? 33 : l < 33 ? 35 : 37;
  return zone;
}

function utmCentralMeridian(zone) {
  return (zone - 1) * 6 - 180 + 3;
}

// { zone, band, hemisphere: 'N'|'S', easting, northing } in metres, or
// null outside the UTM area. `zone` forces a neighbouring zone (grid lines
// across a zone boundary); the band is still the point's own.
export function latLonToUtm(lat, lon, zone) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -80 || lat > 84 || lon < -180 || lon > 180) return null;
  const z = zone || utmZoneOf(lat, lon);
  let dl = utmRad(lon - utmCentralMeridian(z));
  dl = Math.atan2(Math.sin(dl), Math.cos(dl)); // -pi..pi
  const phi = utmRad(lat);
  const tau = Math.tan(phi);
  const sigma = Math.sinh(UTM_E * Math.atanh(UTM_E * tau / Math.sqrt(1 + tau * tau)));
  const tauP = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
  const xiP = Math.atan2(tauP, Math.cos(dl));
  const etaP = Math.asinh(Math.sin(dl) / Math.sqrt(tauP * tauP + Math.cos(dl) ** 2));
  let xi = xiP, eta = etaP;
  UTM_SERIES.alpha.forEach((a, i) => {
    const j = 2 * (i + 1);
    xi += a * Math.sin(j * xiP) * Math.cosh(j * etaP);
    eta += a * Math.cos(j * xiP) * Math.sinh(j * etaP);
  });
  const easting = UTM_FALSE_EASTING + UTM_K0 * UTM_SERIES.A * eta;
  let northing = UTM_K0 * UTM_SERIES.A * xi;
  const hemisphere = lat < 0 ? 'S' : 'N';
  if (hemisphere === 'S') northing += UTM_FALSE_NORTHING_S;
  return { zone: z, band: utmBand(lat), hemisphere, easting, northing };
}

// hemisphere 'N' | 'S' -> { lat, lon }, or null for invalid input.
export function utmToLatLon(zone, hemisphere, easting, northing) {
  if (!(zone >= 1 && zone <= 60) || !Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  const x = easting - UTM_FALSE_EASTING;
  const y = String(hemisphere).toUpperCase() === 'S' ? northing - UTM_FALSE_NORTHING_S : northing;
  const xi = y / (UTM_K0 * UTM_SERIES.A);
  const eta = x / (UTM_K0 * UTM_SERIES.A);
  let xiP = xi, etaP = eta;
  UTM_SERIES.beta.forEach((b, i) => {
    const j = 2 * (i + 1);
    xiP -= b * Math.sin(j * xi) * Math.cosh(j * eta);
    etaP -= b * Math.cos(j * xi) * Math.sinh(j * eta);
  });
  const tauP = Math.sin(xiP) / Math.sqrt(Math.sinh(etaP) ** 2 + Math.cos(xiP) ** 2);
  const dl = Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  // tau' -> tau by Newton's method (converges in 2-3 steps).
  const e2 = UTM_E * UTM_E;
  let tau = tauP;
  for (let k = 0; k < 8; k++) {
    const s = Math.sinh(UTM_E * Math.atanh(UTM_E * tau / Math.sqrt(1 + tau * tau)));
    const ti = tau * Math.sqrt(1 + s * s) - s * Math.sqrt(1 + tau * tau);
    const d = (tauP - ti) / Math.sqrt(1 + ti * ti) * (1 + (1 - e2) * tau * tau) / ((1 - e2) * Math.sqrt(1 + tau * tau));
    tau += d;
    if (Math.abs(d) < 1e-12) break;
  }
  let lon = utmCentralMeridian(zone) + utmDeg(dl);
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lat: utmDeg(Math.atan(tau)), lon };
}

// The 100 km square letters of a UTM position.
function utmSquare(zone, easting, northing) {
  const col = UTM_COL_SETS[zone % 3][Math.floor(easting / 100000) - 1];
  const row = UTM_ROW_LETTERS[(Math.floor(northing / 100000) + (zone % 2 === 0 ? 5 : 0)) % 20];
  return col && row ? col + row : '';
}

// UTMREF digits: 10 = 1 m, 8 = 10 m, 6 = 100 m, 4 = 1 km, 2 = 10 km, 0 = 100 km square.
export const UTM_DIGITS = [10, 8, 6, 4, 2, 0];

function utmDigitsOk(digits) {
  return UTM_DIGITS.includes(digits);
}

// Side of the square a UTMREF with `digits` digits stands for, in metres.
export function mgrsCellSize(digits) {
  return 10 ** (5 - digits / 2);
}

// "1 m", "10 m", "100 m", "1 km", "10 km", "100 km"
export function mgrsPrecisionName(digits) {
  const m = mgrsCellSize(digits);
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

// The most digits whose square is not smaller than `metres` (an area of
// that size shouldn't claim more): 4600 m -> 2 (10 km), 15 m -> 6 (100 m).
export function mgrsDigitsForSize(metres) {
  for (const d of UTM_DIGITS) if (mgrsCellSize(d) >= metres) return d;
  return 0;
}

// Parts of a position's UTMREF: { zone, band, square, east, north, digits }
// with east/north as digit strings (truncated). null outside the UTM area.
export function latLonToMgrsParts(lat, lon, digits = 10) {
  if (!utmDigitsOk(digits)) return null;
  const u = latLonToUtm(lat, lon);
  if (!u) return null;
  const square = utmSquare(u.zone, u.easting, u.northing);
  if (!square) return null;
  const half = digits / 2;
  const cut = v => (half ? String(Math.floor((v % 100000) / mgrsCellSize(digits))).padStart(half, '0') : '');
  return { zone: u.zone, band: u.band, square, east: cut(u.easting), north: cut(u.northing), digits };
}

// "33U XP 02013 40385" (Austrian spaced form); '' when out of range.
export function formatMgrs(p) {
  if (!p) return '';
  return [`${p.zone}${p.band}`, p.square, p.east, p.north].filter(Boolean).join(' ');
}

export function latLonToMgrs(lat, lon, digits = 10) {
  return formatMgrs(latLonToMgrsParts(lat, lon, digits));
}

// Zone/band to read a UTMREF without zone in: the one of a reference point
// (the own location), else 33U (eastern Austria).
export const UTM_DEFAULT_REF = { zone: 33, band: 'U' };

export function utmReference(lat, lon) {
  const u = Number.isFinite(lat) && Number.isFinite(lon) ? latLonToUtm(lat, lon) : null;
  return u ? { zone: u.zone, band: u.band } : { ...UTM_DEFAULT_REF };
}

const MGRS_FULL_RE = /^(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*(\d*)\s*(\d*)$/i;
const MGRS_SHORT_RE = /^([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*(\d+)(?:\s+(\d+))?$/i;

// Digits written together ("02013140385") or as two groups of equal length.
function utmSplitDigits(a, b) {
  if (b) return a.length === b.length && a.length <= 5 ? [a, b] : null;
  return a.length % 2 === 0 && a.length <= 10 ? [a.slice(0, a.length / 2), a.slice(a.length / 2)] : null;
}

// "33U XP 02013 40385", "33UXP0201340385", "xp 0201 4038" ->
// { zone, band, square, east, north, digits, zoneGiven, text } or null.
// Without zone, `ref` ({ zone, band }) supplies it; such a short form needs
// at least 4 digits (1 km), so a locator like "JN88" is never read as one.
// The square's column letter must exist in that zone.
export function parseMgrs(raw, ref = UTM_DEFAULT_REF) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  let zone, band, col, row, digits, zoneGiven;
  let m = MGRS_FULL_RE.exec(s);
  if (m) {
    zone = +m[1];
    band = m[2].toUpperCase();
    [col, row] = [m[3].toUpperCase(), m[4].toUpperCase()];
    digits = utmSplitDigits(m[5], m[6]);
    zoneGiven = true;
  } else if ((m = MGRS_SHORT_RE.exec(s))) {
    zone = ref?.zone || UTM_DEFAULT_REF.zone;
    band = (ref?.band || UTM_DEFAULT_REF.band).toUpperCase();
    [col, row] = [m[1].toUpperCase(), m[2].toUpperCase()];
    digits = utmSplitDigits(m[3], m[4]);
    if (digits && digits[0].length < 2) return null;
    zoneGiven = false;
  } else {
    return null;
  }
  if (!digits || !(zone >= 1 && zone <= 60) || !UTM_COL_SETS[zone % 3].includes(col)) return null;
  const p = { zone, band, square: col + row, east: digits[0], north: digits[1], digits: digits[0].length * 2, zoneGiven };
  const o = mgrsOrigin(p, !zoneGiven);
  if (!o) return null;
  // Without zone the reference band only picks the 2000 km cycle; the
  // square's own band goes into the text.
  if (!zoneGiven) p.band = utmBand(o.centerLat) || p.band;
  p.text = formatMgrs(p);
  return p;
}

// South-west corner of the square in UTM metres: { zone, hemisphere,
// easting, northing, size }, or null if the square doesn't exist in that
// band. The northing repeats every 2000 km; the band picks the right one.
// loose: the band is only a hint (zone-less input), take the nearest cycle.
function mgrsOrigin(p, loose = false) {
  const bi = UTM_BANDS.indexOf(p.band);
  if (bi < 0) return null;
  const south = -80 + bi * 8, north = p.band === 'X' ? 84 : south + 8;
  const hemisphere = p.band < 'N' ? 'S' : 'N';
  const size = mgrsCellSize(p.digits);
  const colIdx = UTM_COL_SETS[p.zone % 3].indexOf(p.square[0]);
  const rowIdx = (UTM_ROW_LETTERS.indexOf(p.square[1]) - (p.zone % 2 === 0 ? 5 : 0) + 20) % 20;
  const easting = (colIdx + 1) * 100000 + (p.digits ? +p.east * size : 0);
  const within = (p.digits ? +p.north * size : 0);
  const mid = (south + north) / 2;
  let best = null;
  for (let k = 0; k < 5; k++) {
    const northing = k * 2000000 + rowIdx * 100000 + within;
    const ll = utmToLatLon(p.zone, hemisphere, easting + size / 2, northing + size / 2);
    if (!ll) continue;
    const d = Math.abs(ll.lat - mid);
    if (!best || d < best.d) best = { d, northing, lat: ll.lat };
  }
  // Allow a little slack: squares overlap the band edges.
  if (!best || (!loose && (best.lat < south - 1 || best.lat > north + 1))) return null;
  return { zone: p.zone, hemisphere, easting, northing: best.northing, size, centerLat: best.lat };
}

// Box of a UTMREF (string or parts) like maidenheadToBounds():
// { west, east, south, north, centerLat, centerLon, precision, zone, band, text }.
export function mgrsToBounds(mgrs, ref) {
  const p = typeof mgrs === 'string' ? parseMgrs(mgrs, ref) : mgrs;
  const o = p && mgrsOrigin(p);
  if (!o) return null;
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]
    .map(([fx, fy]) => utmToLatLon(o.zone, o.hemisphere, o.easting + fx * o.size, o.northing + fy * o.size));
  const c = utmToLatLon(o.zone, o.hemisphere, o.easting + o.size / 2, o.northing + o.size / 2);
  const lats = corners.map(q => q.lat), lons = corners.map(q => q.lon);
  return {
    west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats),
    centerLat: c.lat, centerLon: c.lon,
    precision: p.digits, zone: p.zone, band: p.band, text: formatMgrs(p),
  };
}
