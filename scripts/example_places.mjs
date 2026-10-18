// Places for the example backups (examples/backups/), so the map views of
// Confirm and Notfunk show something realistic: public places, streets and
// crossings in Vienna, resolved with the tools' own offline lookup and
// stored as the location field stores them (snapshotLocation()). A few
// stay fictional text that the lookup doesn't know ("nicht zugeordnet").
// No private addresses: streets, squares, stations, parks and public
// buildings only. Each synthetic station keeps one QTH in all three tools
// (Netlog's profiles too; tests/demo-backups.test.mjs).
//
// Needs the built location data (`just build-location build-areas`).
// Run: node scripts/example_places.mjs (rewrites the six example files).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLocationIndex, locate } from '../tools/shared/js/location/index.js';
import { snapshotLocation, locationFieldText, previousLocation } from '../tools/shared/js/locfield.js';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const read = p => JSON.parse(readFileSync(here(p), 'utf8'));
const idx = buildLocationIndex(read('../tools/shared/data/vienna-locations.json'), read('../tools/shared/data/austria-areas.json'));

// The QTH of each synthetic station: text as typed. `pick` = the operator
// chose the first suggestion (no automatic match), so the field shows the
// suggestion's full name.
export const STATION_QTH = {
  OE0QXA: { text: 'Franz-Jonas-Platz' },
  OE0QXB: { text: 'Hietzinger Hauptstraße' },
  OE0QXC: { text: 'Leopoldauer Platz' },
  OE0QXD: { text: 'Meidlinger Hauptstraße' },
  OE0QXE: { text: '1100', pick: true },
  OE0QXF: { text: 'Simmeringer Hauptstraße / Enkplatz', pick: true },
  OE0QXG: { text: 'Kagraner Platz' },
  OE0QXH: { text: 'Grinzinger Allee' },
  OE0QXI: { text: 'Liesinger Platz' },
  OE0QXJ: { text: 'Landstraßer Hauptstraße' },
  OE0QXK: { text: 'Wolkenfeld (fiktiv)' },
  OE0QXL: { text: 'Praterstraße' },
  OE0QXM: { text: 'Farnwinkel (fiktiv)' },
  OE0QXN: { text: 'Josefstädter Straße' },
};

// Notfunk: where the exercise's events are (the Ort of the incoming
// messages and their follow-ups; the answers from the Leitstelle have none).
const NOTFUNK_STATION = 'Am Spitz 1'; // Amtshaus Floridsdorf
const NOTFUNK_FULL = {
  'D1-001': { text: 'Donauturm' }, 'D1-003': { text: 'Donauturm' },
  'D1-004': { text: 'Praterstern' }, 'D1-006': { text: 'Praterstern' },
  'D1-007': { text: 'Modellbrücke beim Teich (fiktiv)' }, 'D1-009': { text: 'Modellbrücke beim Teich (fiktiv)' },
  'D1-010': { text: 'Schwedenplatz' }, 'D1-012': { text: 'Schwedenplatz' },
  'D1-013': { text: 'Mariahilfer Straße / Neubaugasse', pick: true }, 'D1-015': { text: 'Mariahilfer Straße / Neubaugasse', pick: true },
  'D1-016': { text: 'Hauptbahnhof' }, 'D1-018': { text: 'Hauptbahnhof' },
  'D1-019': { text: 'Ernst-Happel-Stadion' }, 'D1-021': { text: 'Ernst-Happel-Stadion' },
  'D1-025': { text: 'Gasometer' }, 'D1-027': { text: 'Gasometer' },
  'D1-028': { text: 'Seestadt' }, 'D1-030': { text: 'Sammelplatz Nord (fiktiv)' },
};
const NOTFUNK_SMALL = {
  'D1-001': { text: 'Karlsplatz' }, 'D1-003': { text: 'Karlsplatz' },
  'D1-004': { text: 'Volksgarten' }, 'D1-006': { text: 'Lagerzelt (fiktiv)' },
};

// -> { text (the field), loc (snapshot or null) }, as the location field
// leaves them: an automatic match keeps the typed text, a chosen
// suggestion puts its name into the field, unknown text stays text.
function resolvePlace({ text, pick }) {
  const r = locate(idx, text, { autoSelect: 'high' });
  if (r.autoSelect) return { text, loc: snapshotLocation(r.autoSelect, text, false) };
  if (pick && r.results?.[0]) {
    const best = r.results[0];
    return { text: locationFieldText(best), loc: snapshotLocation(best, text, true) };
  }
  if (/\(fiktiv\)$/.test(text) && !r.autoSelect) return { text, loc: null };
  throw new Error(`"${text}" doesn't resolve; pick another place or mark it (fiktiv)`);
}

const stations = Object.fromEntries(Object.entries(STATION_QTH).map(([call, p]) => [call, resolvePlace(p)]));

function write(name, data, indent) {
  writeFileSync(here(`../examples/backups/${name}.json`), JSON.stringify(data, null, indent) + '\n');
}

// Netlog: the stations' QTH text (no map there).
for (const name of ['netlog-full', 'netlog-example']) {
  const d = read(`../examples/backups/${name}.json`);
  for (const p of [...d.stores.profiles, ...d.stores.participants]) p.qth = stations[p.call].text;
  write(name, d, 1);
}

// Confirm: the check-in's QTH (address in the warning-system survey) and
// its location; a station's later check-ins take it over from its first
// one, as the form suggests it ("früheres Log").
for (const name of ['confirm-full', 'confirm-example']) {
  const d = read(`../examples/backups/${name}.json`);
  const first = new Map();
  for (const { event, entries } of d.events) {
    const own = stations[event.header.operator].text;
    event.header.myQth = own;
    for (const e of entries) {
      if (e.snap) e.snap.myQth = own;
      if (!e.call) continue;
      const s = stations[e.call];
      const key = event.template === 'zivilschutz' ? 'address' : 'qth';
      e.fields[key] = s.text;
      if (key === 'address') e.fields.plz = s.loc?.postcode || '';
      const seen = first.get(e.call);
      e.loc = !s.loc ? null : seen ? previousLocation(seen.loc, seen.ts) : s.loc;
      if (!seen && s.loc) first.set(e.call, { loc: s.loc, ts: e.ts });
    }
  }
  write(name, d, 2);
}

// Notfunk: the operation's station and the messages' Ort.
for (const [name, places] of [['notfunk-full', NOTFUNK_FULL], ['notfunk-example', NOTFUNK_SMALL]]) {
  const d = read(`../examples/backups/${name}.json`);
  d.operation.station = NOTFUNK_STATION;
  for (const m of d.messages) {
    const p = places[m.number] ? resolvePlace(places[m.number]) : null;
    m.location = p?.loc || null;
    m.locationText = p && !p.loc ? p.text : '';
  }
  write(name, d, 1);
}

const placed = Object.values(stations).filter(s => s.loc).length;
console.log(`stations: ${placed} of ${Object.keys(stations).length} placed; Notfunk station ${NOTFUNK_STATION}; wrote examples/backups/*.json`);
