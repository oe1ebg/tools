// Maidenhead locator <-> WGS84, any even length (2 = field, 4 = square,
// 6 = subsquare, 8 = extended square, 10 = extended subsquare).
// A locator is an AREA: maidenheadToBounds() returns its box; the center is
// only the geometric middle of that box, not "the" location.

const MH_BASES = [18, 10, 24, 10, 24]; // field, square, subsquare, ext. square, ext. subsquare
const MH_RE = /^[A-R]{2}(?:\d{2}(?:[A-X]{2}(?:\d{2}(?:[A-X]{2})?)?)?)?$/i;
const MH_PARTIAL_RE = /^[A-R]{2}(?:\d{1,2}|\d{2}[A-X]{1,2}|\d{2}[A-X]{2}\d{1,2})?$/i;

export function isValidLocator(loc) {
  return typeof loc === 'string' && loc.length % 2 === 0 && MH_RE.test(loc);
}

// A prefix of a valid locator, e.g. while typing ("JN88e").
export function isLocatorPrefix(loc) {
  return typeof loc === 'string' && loc.length >= 2 && MH_PARTIAL_RE.test(loc);
}

// Canonical spelling: field upper, square digits, subsquare lower ("JN88ee12ab").
export function formatLocator(loc) {
  return String(loc).split('').map((c, i) => (Math.floor(i / 2) % 2 === 0 && Math.floor(i / 2) > 0 ? c.toLowerCase() : c.toUpperCase())).join('');
}

export function locatorPrecisionName(len) {
  return { 2: 'Feld', 4: 'Großfeld', 6: 'Kleinfeld', 8: 'erweitertes Feld', 10: 'erweitertes Kleinfeld' }[len] || `${len} Zeichen`;
}

export function latLonToMaidenhead(lat, lon, precision = 6) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return '';
  const pairs = Math.max(1, Math.min(5, Math.floor(precision / 2)));
  let x = Math.min(lon + 180, 360 - 1e-9);
  let y = Math.min(lat + 90, 180 - 1e-9);
  let w = 360, h = 180;
  let out = '';
  for (let p = 0; p < pairs; p++) {
    const b = MH_BASES[p];
    w /= b;
    h /= b;
    const xi = Math.floor(x / w), yi = Math.floor(y / h);
    x -= xi * w;
    y -= yi * h;
    if (b === 10) out += String(xi) + String(yi);
    else out += String.fromCharCode((p === 0 ? 65 : 97) + xi) + String.fromCharCode((p === 0 ? 65 : 97) + yi);
  }
  return out;
}

export function maidenheadToBounds(loc) {
  if (!isValidLocator(loc)) return null;
  const s = loc.toUpperCase();
  let west = -180, south = -90, w = 360, h = 180;
  for (let p = 0; p < s.length / 2; p++) {
    const b = MH_BASES[p];
    w /= b;
    h /= b;
    const cx = s[2 * p], cy = s[2 * p + 1];
    const xi = b === 10 ? +cx : cx.charCodeAt(0) - 65;
    const yi = b === 10 ? +cy : cy.charCodeAt(0) - 65;
    west += xi * w;
    south += yi * h;
  }
  return {
    west, east: west + w, south, north: south + h,
    centerLat: south + h / 2, centerLon: west + w / 2,
    precision: s.length,
  };
}
