// How a resolved location was obtained and named, for the location field
// (shared/js/locfield.js) and the exports of the tools using it. Pure.

// Where a line's location came from (`loc.origin`, set by the location
// field, js/locfield.js): label = the short label in the log's "Herk."
// column ('' = no label for that source), text = CSV/ADIF/KML wording.
// Lines from before this existed have no origin: no label (unknown).
export const LOC_ORIGINS = {
  search: { label: 'Suche', text: 'Suche', title: 'aus der Standortsuche (Adressen, Orte, PLZ)' },
  callbook: { label: 'Call', text: 'Rufzeichenliste, Lizenzadresse', title: 'Wohnort laut Rufzeichenliste (Lizenzadresse), nicht von der Station bestätigt' },
  previous: { label: 'früher', text: 'früheres Log', title: 'von einem früheren Check-in übernommen' },
  text: { label: 'Text', text: 'Freitext', title: 'Freitext, keinem Ort zugeordnet' },
};

// Origin key of a line's location field value: the resolved location's
// origin, 'text' for unresolved text, '' when empty or unknown (old data).
export function locOrigin(loc, text) {
  if (loc) return LOC_ORIGINS[loc.origin] ? loc.origin : '';
  return String(text ?? '').trim() ? 'text' : '';
}

// "früheres Log 27.09.2026" / "Suche" / ...
export function locOriginText(loc, text) {
  const k = locOrigin(loc, text);
  if (!k) return '';
  const day = k === 'previous' && /^(\d{4})-(\d{2})-(\d{2})/.exec(loc.originAt || '');
  return `${LOC_ORIGINS[k].text}${day ? ` ${day[3]}.${day[2]}.${day[1]}` : ''}`;
}

// How a resolved location was named (`loc.nameType`, from the lookup; lines
// from before this existed have none): code -> CSV/KML wording. Corners and
// "zwischen A und B" count as their own kind; coordinates, locators and UTMREFs have none.
export const LOC_NAME_TYPES = {
  name: 'Name', alias: 'anderer Name', colloquial: 'umgangssprachlich', historical: 'früherer Name',
  generated: 'Kurzform', intersection: 'Kreuzung', between: 'Bereich',
};

export function locNameType(loc) {
  if (!loc) return '';
  if (loc.nameType) return loc.nameType;
  if (loc.type === 'intersection' || loc.type === 'between') return loc.type;
  return ['coordinate', 'maidenhead', 'utm'].includes(loc.type) ? '' : 'name';
}

// Short hints for the log's location line: "früher „Rudolfstiftung“",
// "Kreuzung", "außerhalb Wiens".
export function locHints(loc) {
  if (!loc) return [];
  const out = [];
  if (loc.matched) {
    out.push(loc.nameType === 'historical' ? `früher „${loc.matched}“`
      : loc.nameType === 'colloquial' ? `„${loc.matched}“ (umgangssprachlich)` : `„${loc.matched}“`);
  }
  if (loc.type === 'intersection') out.push('Kreuzung');
  if (loc.type === 'between') out.push('Bereich');
  if (loc.umland) out.push('außerhalb Wiens');
  return out;
}
