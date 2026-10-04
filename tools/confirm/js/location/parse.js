// Turns free operator input into structured location evidence. The parts
// it recognizes (coordinates, locator, PLZ, district, house number) are
// removed from the text; what remains is searched as a street/place name.
//   "Donauinsel 1220 JN88ge" -> { text: "Donauinsel", postcode: "1220", locator: "JN88ge" }

import { isValidLocator, isLocatorPrefix, formatLocator } from './maidenhead.js';
import { foldName } from './normalize.js';

const COORD_DOT_RE = /(-?\d{1,2}\.\d+)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*°?\s*([EOW])?/i;
const COORD_COMMA_RE = /(-?\d{1,2},\d+)\s*°?\s*([NS])?\s*[;\s]\s*(-?\d{1,3},\d+)\s*°?\s*([EOW])?/i;
const PLZ_RE = /^(?:A-)?(1(?:0[1-9]|1\d|2[0-3])0)$/i;           // Vienna: 1010 ... 1230
const DISTRICT_RES = [
  /(?:^|\s)(\d{1,2})\s*\.?\s*(?:wiener\s+)?(?:gemeinde)?bezirk(?=\s|$|[,;])/i,
  /(?:^|\s)(\d{1,2})\s*\.?\s*(?:bez|bzk)\.?(?=\s|$|[,;])/i,
  /(?:^|\s)(?:gemeinde)?bezirk\s*(\d{1,2})(?=\s|$|[,;])/i,
  /(?:^|\s)wien\s*[-,]?\s*(\d{1,2})(?=\s|$|[,;])/i,
];
const CITY_RE = /(?:^|[\s,])(?:wien|vienna)(?=[\s,]|$)/gi;
const HN_RE = /^(.*?[^\d\s].*?)[\s,]+(?:nr\.?\s*)?(\d{1,4}(?:\s?[a-z](?![a-z]))?(?:\s*[-–/]\s*\d{1,4}[a-z]?)*)$/i;

function toNumber(s) {
  return parseFloat(String(s).replace(',', '.'));
}

function takeCoordinates(text, ev) {
  for (const re of [COORD_DOT_RE, COORD_COMMA_RE]) {
    const m = re.exec(text);
    if (!m) continue;
    let lat = toNumber(m[1]), lon = toNumber(m[3]);
    if (m[2] && m[2].toUpperCase() === 'S') lat = -Math.abs(lat);
    if (m[4] && m[4].toUpperCase() === 'W') lon = -Math.abs(lon);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      ev.latitude = lat;
      ev.longitude = lon;
      return (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).trim();
    }
  }
  return text;
}

// districtNames: Map folded name -> district number (optional)
export function parseLocationInput(raw, districtNames) {
  const ev = { raw: String(raw ?? '').trim() };
  let text = takeCoordinates(ev.raw, ev);

  // Locator and PLZ tokens, anywhere in the text.
  const keep = [];
  const tokens = text.split(/\s+/).filter(Boolean);
  tokens.forEach((tok, i) => {
    const t = tok.replace(/[,;]+$/, '');
    if (!ev.locator && t.length >= 4 && isValidLocator(t) && /\d/.test(t)) {
      ev.locator = formatLocator(t);
    } else if (!ev.locator && !ev.partialLocator && i === tokens.length - 1 && t.length >= 3 && /^[A-R]{2}\d/i.test(t) && isLocatorPrefix(t)) {
      ev.partialLocator = formatLocator(t);
    } else if (!ev.postcode && PLZ_RE.test(t)) {
      ev.postcode = PLZ_RE.exec(t)[1];
    } else {
      keep.push(tok);
    }
  });
  text = keep.join(' ');

  for (const re of DISTRICT_RES) {
    const m = re.exec(text);
    if (m && +m[1] >= 1 && +m[1] <= 23) {
      ev.district = +m[1];
      text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).trim();
      break;
    }
  }
  text = text.replace(CITY_RE, ' ').replace(/\s+/g, ' ').replace(/^[\s,;-]+|[\s,;-]+$/g, '');

  // District name at the start or end ("Favoriten Quellenstr"). If the
  // name is the whole text, it stays as the text too (search finds the district).
  if (districtNames && !ev.district && text) {
    const folded = foldName(text);
    for (const [name, nr] of districtNames) {
      if (folded === name) {
        ev.district = nr;
        break;
      }
      const words = text.split(' ');
      for (let n = 1; n < words.length; n++) {
        const head = foldName(words.slice(0, n).join(' '));
        const tail = foldName(words.slice(words.length - n).join(' '));
        if (head === name) { ev.district = nr; text = words.slice(n).join(' '); break; }
        if (tail === name) { ev.district = nr; text = words.slice(0, words.length - n).join(' '); break; }
      }
      if (ev.district) break;
    }
  }

  const hm = HN_RE.exec(text);
  if (hm) {
    ev.street = hm[1].replace(/[\s,]+$/, '');
    ev.houseNumber = hm[2].replace(/\s+/g, ' ');
    text = ev.street;
  }
  if (text) ev.text = text;
  return ev;
}
