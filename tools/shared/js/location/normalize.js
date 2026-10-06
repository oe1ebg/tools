// Text normalization for matching street and place names. Official
// spellings are never changed — these are only search keys.
// "Währinger Straße", "Waehringerstr.", "Wahringer Strasse" and
// "WAEHRINGER STRASSE" all produce the same keys.

const UMLAUT_AE = { ä: 'ae', ö: 'oe', ü: 'ue' };
const UMLAUT_PLAIN = { ä: 'a', ö: 'o', ü: 'u' };
const TOKEN_ABBREV = { str: 'strasse', g: 'gasse', gs: 'gasse', pl: 'platz', pr: 'promenade', st: 'sankt' };

// plain=false: ä -> ae (the standard transliteration);
// plain=true:  ä -> a  (what people type without umlauts).
export function foldName(s, plain = false) {
  let t = String(s ?? '').normalize('NFC').toLowerCase().replace(/ß/g, 'ss');
  // Abbreviations glued to the word: "Quelleng." "Waehringerstr." "Hauptpl."
  t = t.replace(/(\p{L})str\.(?=[\s\d,;]|$)/gu, '$1strasse')
    .replace(/(\p{L})g\.(?=[\s\d,;]|$)/gu, '$1gasse')
    .replace(/(\p{L})pl\.(?=[\s\d,;]|$)/gu, '$1platz');
  const map = plain ? UMLAUT_PLAIN : UMLAUT_AE;
  t = t.replace(/[äöü]/g, c => map[c]);
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!t) return '';
  return t.split(' ')
    .map(tok => TOKEN_ABBREV[tok] || (/^[a-z]{3,}str$/.test(tok) ? tok + 'asse' : tok))
    .join(' ');
}

export function compactKey(folded) {
  return folded.replace(/ /g, '');
}

// The (deduplicated) compact search keys of a name or query.
export function searchKeys(s) {
  const a = compactKey(foldName(s, false));
  const b = compactKey(foldName(s, true));
  return a === b ? (a ? [a] : []) : [a, b].filter(Boolean);
}

// House numbers: "42 A" -> "42a", "42–44" -> "42-44", "42/3" -> "42/3".
export function normalizeHouseNumber(hn) {
  return String(hn ?? '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, '');
}

export function leadingNumber(hn) {
  const m = /\d+/.exec(String(hn ?? ''));
  return m ? parseInt(m[0], 10) : -1;
}
