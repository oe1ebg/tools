// Maidenhead locator <-> WGS84, any even length up to 20 characters:
// a field (2 letters A-R), then pairs alternating between digits 0-9 and
// letters A-X: square (4), subsquare (6), extended square (8), extended
// subsquare (10), and on in the same rhythm, e.g. "JN88EE05UO43UF06QD23".
// A locator is an AREA: maidenheadToBounds() returns its box; the center is
// only the geometric middle of that box, not "the" location.

export const MAX_LOCATOR_LENGTH = 20;

// Base of pair p: 18 for the field, then 10 (digits) and 24 (letters) in turn.
function pairBase(p) {
  return p === 0 ? 18 : p % 2 === 1 ? 10 : 24;
}

// Whether character c can stand at position i of a locator.
function locatorCharOk(c, i) {
  const p = Math.floor(i / 2);
  if (p === 0) return /^[A-R]$/i.test(c);
  return pairBase(p) === 10 ? /^\d$/.test(c) : /^[A-X]$/i.test(c);
}

function locatorCharsOk(loc) {
  for (let i = 0; i < loc.length; i++) if (!locatorCharOk(loc[i], i)) return false;
  return true;
}

export function isValidLocator(loc) {
  return typeof loc === 'string' && loc.length >= 2 && loc.length <= MAX_LOCATOR_LENGTH && loc.length % 2 === 0 && locatorCharsOk(loc);
}

// A prefix of a valid locator, e.g. while typing ("JN88e").
export function isLocatorPrefix(loc) {
  return typeof loc === 'string' && loc.length >= 2 && loc.length <= MAX_LOCATOR_LENGTH && locatorCharsOk(loc);
}

// Canonical spelling: field upper case, letter pairs after it lower case
// ("JN88ee05uo43uf06qd23").
export function formatLocator(loc) {
  return String(loc).split('').map((c, i) => (Math.floor(i / 2) > 0 ? c.toLowerCase() : c.toUpperCase())).join('');
}

// Beyond 10 characters there are no names; the cell height says how fine
// it is ("12 Zeichen, ≈ 2 m" … "20 Zeichen, < 1 mm"): finer than any GPS.
export function locatorPrecisionName(len) {
  const named = { 2: 'Feld', 4: 'Großfeld', 6: 'Kleinfeld', 8: 'erweitertes Feld', 10: 'erweitertes Kleinfeld' }[len];
  if (named) return named;
  let cells = 1;
  for (let p = 0; p < len / 2; p++) cells *= pairBase(p);
  const metres = 180 / cells * 111320;
  const size = metres >= 1 ? `≈ ${Math.round(metres)} m` : metres >= 0.01 ? `≈ ${Math.round(metres * 100)} cm` : metres >= 0.001 ? `≈ ${Math.round(metres * 1000)} mm` : '< 1 mm';
  return `${len} Zeichen, ${size}`;
}

export function latLonToMaidenhead(lat, lon, precision = 6) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return '';
  const pairs = Math.max(1, Math.min(MAX_LOCATOR_LENGTH / 2, Math.floor(precision / 2)));
  // Work in units of the smallest cell, as integers: repeated float
  // subtraction would drift at 20 characters (cells of ~6e-10°).
  let lonUnits = 1, latUnits = 1;
  for (let p = 0; p < pairs; p++) { lonUnits *= pairBase(p); latUnits *= pairBase(p); }
  let x = Math.min(Math.floor((lon + 180) / 360 * lonUnits), lonUnits - 1);
  let y = Math.min(Math.floor((lat + 90) / 180 * latUnits), latUnits - 1);
  const digitsX = [], digitsY = [];
  for (let p = pairs - 1; p >= 0; p--) {
    const b = pairBase(p);
    digitsX[p] = x % b; x = Math.floor(x / b);
    digitsY[p] = y % b; y = Math.floor(y / b);
  }
  let out = '';
  for (let p = 0; p < pairs; p++) {
    if (pairBase(p) === 10) out += String(digitsX[p]) + String(digitsY[p]);
    else out += String.fromCharCode((p === 0 ? 65 : 97) + digitsX[p]) + String.fromCharCode((p === 0 ? 65 : 97) + digitsY[p]);
  }
  return out;
}

export function maidenheadToBounds(loc) {
  if (!isValidLocator(loc)) return null;
  const s = loc.toUpperCase();
  let west = -180, south = -90, w = 360, h = 180;
  for (let p = 0; p < s.length / 2; p++) {
    const b = pairBase(p);
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
