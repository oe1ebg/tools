// The shape of what people say about a place, beyond the name itself:
// position words ("beim Schottentor", "Nähe Praterstern"), street corners
// ("Gürtel Ecke Thaliastraße", "Thaliastraße/Gürtel") and a category word
// next to a name or area ("Kirche Mauer", "U6 Josefstädter Straße",
// "Spital Floridsdorf"). Pure string work: index.js decides what the parts
// mean against the data.

import { foldName } from './normalize.js';

// Leading position words, optionally followed by an article/preposition.
// "am/an/im/in/auf" are also the start of real names ("Am Spitz",
// "An der Hülben"), so the caller only strips when the whole text is not a
// known name.
const RELATION_RE = /^(in\s+der\s+n(?:ä|ae)he|n(?:ä|ae)he|nahe|unweit|beim|bei|vorm|vor|hinterm|hinter|gegen(?:ü|ue)ber|neben|auf\s+(?:der\s+)?h(?:ö|oe)he|h(?:ö|oe)he|richtung|am|an|im|in|auf|zum|zur)(?:\s+(?:von|vom|zum|zur|der|dem|des|den|die|das))?\s+(?=\S)/i;

// Words that also start real names; only stripped when the rest is a known name.
const WEAK_RELATION_RE = /^(?:am|an|im|in|auf|zum|zur)(?:\s+(?:der|dem|des|den|die|das))?$/i;

// "beim Schottentor" -> { relation: 'beim', rest: 'Schottentor', weak: false };
// null if none. weak: only "am/an/im/in/auf/zum/zur" ("am Praterstern").
export function splitRelation(text) {
  let rest = String(text ?? '').trim();
  const words = [];
  for (let n = 0; n < 2; n++) {
    const m = RELATION_RE.exec(rest);
    if (!m) break;
    words.push(m[0].trim());
    rest = rest.slice(m[0].length).trim();
  }
  return words.length && rest
    ? { relation: words.join(' '), rest, weak: words.every(w => WEAK_RELATION_RE.test(w)) }
    : null;
}

const CORNER_PREFIX_RE = /^(?:ecke|eck|kreuzung(?:sbereich)?)\s+/i;
const CORNER_SEP_RE = /\s*(?:\/|\\|\s(?:ecke|eck|kreuzung|x|und|u\.|&|\+)\s|\s[-–]\s)\s*/i;

// Possible two-street readings of a corner: [[a, b], ...]. With a separator
// ("A / B", "A Ecke B", "A und B") that one split; after a leading "Ecke" or
// "Kreuzung" without separator every word boundary ("Ecke Thaliastraße Gürtel").
export function cornerSplits(text) {
  let t = String(text ?? '').trim();
  const prefixed = CORNER_PREFIX_RE.test(t);
  if (prefixed) t = t.replace(CORNER_PREFIX_RE, '');
  const m = CORNER_SEP_RE.exec(t);
  if (m) {
    const a = t.slice(0, m.index).trim(), b = t.slice(m.index + m[0].length).trim();
    return a && b ? [[a, b]] : [];
  }
  if (!prefixed) return [];
  const words = t.split(/\s+/).filter(Boolean);
  const out = [];
  for (let n = 1; n < words.length; n++) out.push([words.slice(0, n).join(' '), words.slice(n).join(' ')]);
  return out;
}

// Category words people put next to a name. `cat` is tested against a
// place's category (OSM "key=value", GIP "gip:<Kategorie>"); `syn` are the
// words official names use instead ("Spital Floridsdorf" -> "Klinik
// Floridsdorf"). Matched as whole words at the start or end of the text only.
export const CATEGORY_WORDS = [
  { key: 'church', words: ['kirche', 'pfarrkirche', 'pfarre', 'dom'], cat: /place_of_worship|historic=church|gip:kirche/i, syn: ['kirche', 'pfarrkirche'] },
  { key: 'hospital', words: ['spital', 'krankenhaus', 'kh', 'klinik', 'klinikum', 'landesklinikum', 'lkh', 'spitol'], cat: /hospital|gip:spital/i, syn: ['klinik', 'krankenhaus', 'spital', 'landesklinikum'] },
  { key: 'station', words: ['bahnhof', 'bhf', 'station', 'haltestelle', 'hst', 'ubahn', 'sbahn', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'schnellbahn'], cat: /railway=(station|halt)|public_transport=station|gip:(u-bahnstation|bahnhof|schnellbahn)|^stop/i, syn: ['bahnhof', 'wien', 'u-bahn station'] },
  { key: 'cemetery', words: ['friedhof'], cat: /cemetery|gip:friedhof/i, syn: ['friedhof'] },
  { key: 'park', words: ['park', 'parkanlage'], cat: /leisure=park|gip:park/i, syn: ['park', 'parkanlage'] },
  { key: 'school', words: ['schule', 'volksschule', 'gymnasium'], cat: /school|gip:schule/i, syn: [] },
  { key: 'fire', words: ['feuerwehr', 'feuerwache'], cat: /fire_station|feuerwehr/i, syn: ['feuerwache', 'feuerwehr', 'berufsfeuerwehr wien gruppenwache'] },
  { key: 'police', words: ['polizei', 'polizeiinspektion', 'wachzimmer', 'kommissariat'], cat: /police/i, syn: ['polizeiinspektion'] },
  { key: 'market', words: ['markt'], cat: /marketplace|gip:markt/i, syn: ['markt'] },
  { key: 'bridge', words: ['brücke', 'bruecke'], cat: /bridge|gip:br(ü|ue)cke/i, syn: ['brücke'] },
  { key: 'bath', words: ['bad', 'freibad', 'hallenbad', 'strandbad'], cat: /swimming|water_park|gip:bad/i, syn: ['bad', 'strandbad'] },
  { key: 'monastery', words: ['stift', 'kloster'], cat: /monastery|historic=church|place_of_worship/i, syn: ['stift'] },
  { key: 'airport', words: ['flughafen', 'airport'], cat: /aerodrome/i, syn: ['flughafen'] },
  { key: 'castle', words: ['schloss', 'burg', 'palais'], cat: /castle|palace/i, syn: ['schloss'] },
];
const CATEGORY_BY_WORD = new Map();
for (const c of CATEGORY_WORDS) for (const w of c.words) CATEGORY_BY_WORD.set(foldName(w), c);

// The category a single word names ("Spital" -> hospital), or undefined.
export function categoryOfWord(word) {
  return CATEGORY_BY_WORD.get(foldName(word));
}

// "Kirche Mauer" -> { category, word: 'Kirche', rest: 'Mauer' }; null if
// the first/last word isn't a category word or nothing else is left.
export function splitCategory(text) {
  const t = String(text ?? '').trim().replace(/\b([us])-bahn\b/gi, '$1bahn');
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  for (const [i, restWords] of [[0, words.slice(1)], [words.length - 1, words.slice(0, -1)]]) {
    const category = CATEGORY_BY_WORD.get(foldName(words[i]));
    if (category) return { category, word: words[i], rest: restWords.join(' ') };
  }
  return null;
}

// Words that carry no place information on their own ("Haus des Meeres").
export const STOP_WORDS = new Set(['der', 'die', 'das', 'des', 'dem', 'den', 'und', 'von', 'vom', 'zum', 'zur', 'am', 'an', 'im', 'in', 'bei', 'beim', 'auf']);

// "2. Tor" -> "Tor 2" (how gates and entrances are named).
export function rewriteOrdinals(text) {
  return String(text ?? '').replace(/\b(\d{1,2})\.\s*(tor|eingang|stiege)\b/gi, (_, n, w) => `${w} ${n}`);
}
