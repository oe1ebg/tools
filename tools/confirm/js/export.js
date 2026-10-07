// CSV / ADIF / KML / plain-text summary export. Pure functions over an event and
// its entries — no DOM — so they're unit-tested in oe1ebg/tests/.
//
// Operator comments (kind 'comment', see js/model.js) are no QSOs:
//   ADIF, KML (and the map): never included;
//   CSV: left out unless { comments: true } (then a `typ` column
//        checkin/kommentar plus `kategorie`; QSO fields stay empty);
//   summary: included in time order, plus an "Operators:" line;
//   JSON backup (app.js): always included, it is the raw entries store.
//
// UTMREF (tools/shared/js/utm.js) is computed from the stored lat/lon at
// full precision (1 m; a typed UTMREF as it was). The own position (my_utm,
// APP_OE1EBG_MY_UTM, KML, summary) is resolved like the map does
// (ownPosition): the header QTH via opts.qth(text) -> lookup result | null,
// which the caller resolves beforehand, else the centre of the header
// locator, then only as fine as that locator's square.

import {
  liveSorted, liveCheckins, isComment, checkinNumbers, operatorShifts, lineFrequencies, bandForMHz, modeInfo,
  stats, signallingText, parseMHz,
} from './model.js';
import { normalizeCall, isPlausibleCall } from '../../shared/js/callbook.js';
import { splitUtc, splitTime, zoneLabel } from '../../shared/js/time.js';
import { locOrigin, locOriginText, locNameType, LOC_NAME_TYPES } from '../../shared/js/locmeta.js';
import { templateFor, fieldVisible, fieldDisplay, hasLocationField } from './templates.js';
import { stationsForMap, ownPosition } from './mapdata.js';
import { adifAscii, adifAsciiField } from '../../shared/js/adif.js';
import { isValidLocator, formatLocator } from '../../shared/js/maidenhead.js';
import { formatMHz } from '../../shared/js/repeaters.js';
import { utmFields, mgrsDigitsForSize, latLonToMgrs } from '../../shared/js/utm.js';

export const ADIF_PROGRAM_ID = 'OE1EBG';
// No registered MIME type for ADIF; text/plain makes Safari save ".adi.txt".
export const ADIF_MIME = 'application/octet-stream';

const LOC_CONF_DE = { exact: 'exakt', high: 'hoch', likely: 'wahrscheinlich', ambiguous: 'mehrdeutig', low: 'unsicher' };
const LOC_COLS = ['standort_aufgeloest', 'lat', 'lon', 'locator', 'utm', 'utm_zone', 'utm_easting', 'utm_northing',
  'standort_konfidenz', 'standort_quelle',
  'standort_eingabe', 'standort_herkunft', 'standort_namenstyp', 'standort_gefunden_als'];

// The template's location field (at most one).
function locationField(tpl) {
  return tpl.fields.find(f => f.type === 'location');
}

// `text` is the location field's value (origin "Freitext" when unresolved).
function locColumns(loc, text) {
  const origin = { standort_eingabe: loc?.input || '', standort_herkunft: locOriginText(loc, text) };
  if (!loc) {
    return { standort_aufgeloest: '', lat: '', lon: '', locator: '', standort_konfidenz: '', standort_quelle: '',
      standort_namenstyp: '', standort_gefunden_als: '', ...utmColumns(null, ''), ...origin };
  }
  return {
    ...origin,
    ...utmColumns(utmFields(loc), ''),
    standort_namenstyp: LOC_NAME_TYPES[locNameType(loc)] || '',
    standort_gefunden_als: loc.matched || '',
    standort_aufgeloest: loc.label,
    lat: loc.lat.toFixed(5),
    lon: loc.lon.toFixed(5),
    locator: loc.maidenhead,
    standort_konfidenz: LOC_CONF_DE[loc.confidence] || loc.confidence || '',
    standort_quelle: loc.manual ? 'gewählt' : 'automatisch',
  };
}

// { utm, utm_zone, utm_easting, utm_northing } (prefix 'my_' for the own position).
function utmColumns(u, prefix) {
  return {
    [`${prefix}utm`]: u?.text || '', [`${prefix}utm_zone`]: u?.zone || '',
    [`${prefix}utm_easting`]: u ? String(u.easting) : '', [`${prefix}utm_northing`]: u ? String(u.northing) : '',
  };
}

// The own position of a header (snapshot) as UTM fields, like the map
// places it (see the top of this file); null when there is none.
export function ownUtm(h, qth) {
  const res = h?.myQth && qth ? qth(h.myQth) : null;
  const own = ownPosition({ myGrid: h?.myGrid }, res);
  if (!own) return null;
  if (!own.bounds) return { ...utmFields(own), label: own.label };
  // A locator is an area: no more digits than its square is big.
  const b = own.bounds;
  const size = Math.max((b.north - b.south) * 111320, (b.east - b.west) * 111320 * Math.cos(own.lat * Math.PI / 180));
  const digits = mgrsDigitsForSize(size);
  return { ...utmFields(own), text: latLonToMgrs(own.lat, own.lon, digits), label: own.label, fromLocator: true };
}

// ADIF LAT/LON: "N048 12.498" / "E016 22.386"
export function adifLatLon(v, isLat) {
  const hemi = isLat ? (v < 0 ? 'S' : 'N') : (v < 0 ? 'W' : 'E');
  const a = Math.abs(v);
  let deg = Math.floor(a);
  let min = Math.round((a - deg) * 60 * 1000) / 1000;
  if (min >= 60) { deg += 1; min = 0; }
  return `${hemi}${String(deg).padStart(3, '0')} ${min.toFixed(3).padStart(6, '0')}`;
}

// ISO 8601 with a space instead of "T" and no zone letter
// ("2026-10-04 19:42:07"): Excel (any locale) imports this as a real
// date/time value, which it doesn't for "2026-10-04T19:42:07Z". Always
// UTC — the column is named accordingly.
export function excelUtc(iso) {
  const { date, time } = splitUtc(iso);
  return date ? `${date} ${time}` : '';
}

function csvCell(val, sep) {
  const s = val === undefined || val === null ? '' : String(val);
  return s.includes(sep) || /["\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function fmtMHz(v) {
  return v === null || v === undefined ? '' : String(Math.round(v * 1e6) / 1e6);
}

// One flat row per live check-in (comments excluded); shared by CSV and the summary.
function exportRows(event, entries, opts = {}) {
  const tpl = templateFor(event.template);
  const nums = checkinNumbers(entries);
  return liveCheckins(entries).map(e => {
    const { tx, rx } = lineFrequencies(e);
    const s = e.snap || {};
    // Time always first: one UTC timestamp that Excel recognises.
    const row = {
      zeitstempel_utc: excelUtc(e.ts),
      nr: e.seq,
      checkin_nr: nums.get(e.id),
      rufzeichen: e.call,
      ts: e.ts,
    };
    for (const f of tpl.fields) row[f.key] = fieldVisible(f, e.fields, tpl) ? fieldDisplay(f, e.fields?.[f.key]) : '';
    if (hasLocationField(tpl)) Object.assign(row, locColumns(e.loc, e.fields?.[locationField(tpl).key]));
    Object.assign(row, {
      ueber_relais: e.viaRepeater ? 'ja' : 'nein',
      relais: e.viaRepeater ? s.repeaterCall : '',
      relais_ctcss: e.viaRepeater ? s.repeaterTone || '' : '',
      relais_quelle: e.viaRepeater ? (s.repeaterOverride ? 'Zeile' : 'Header') : '',
      notiz: e.note || '',
      operator: s.operator,
      station: s.station,
      freq_mhz: fmtMHz(tx),
      freq_rx_mhz: fmtMHz(rx),
      band: bandForMHz(tx ?? rx),
      mode: modeInfo(s.mode)?.label || '',
      signalisierung: signallingText(s),
      my_locator: s.myGrid,
      ...utmColumns(ownUtm(s, opts.qth), 'my_'),
      log: event.title,
    });
    return row;
  });
}

// A comment as a CSV row: time, typ, kategorie, the text in `notiz`, and
// who operated (from its snapshot); all QSO fields stay empty.
function commentRow(event, e, opts) {
  const s = e.snap || {};
  return {
    zeitstempel_utc: excelUtc(e.ts), typ: 'kommentar', kategorie: e.category || '', ts: e.ts,
    notiz: e.text || '', operator: s.operator, station: s.station, my_locator: s.myGrid,
    ...utmColumns(ownUtm(s, opts.qth), 'my_'), log: event.title,
  };
}

// opts.comments: include operator comments (default: no, one row per check-in).
// opts.qth(text): the resolved header QTH (see the top of this file).
export function toCSV(event, entries, sep = ';', opts = {}) {
  const withComments = !!opts.comments;
  let rows = exportRows(event, entries, opts);
  if (withComments) {
    const byId = new Map(liveCheckins(entries).map((e, i) => [e.id, rows[i]]));
    rows = liveSorted(entries).map(e => (isComment(e) ? commentRow(event, e, opts) : { ...byId.get(e.id), typ: 'checkin' }));
  }
  const tpl = templateFor(event.template);
  const cols = [
    'zeitstempel_utc', ...(withComments ? ['typ', 'kategorie'] : []), 'nr', 'checkin_nr', 'rufzeichen',
    ...tpl.fields.map(f => f.key),
    ...(hasLocationField(tpl) ? LOC_COLS : []),
    'ueber_relais', 'relais', 'relais_ctcss', 'relais_quelle', 'notiz', 'operator', 'station',
    'freq_mhz', 'freq_rx_mhz', 'band', 'mode', 'signalisierung', 'my_locator',
    'my_utm', 'my_utm_zone', 'my_utm_easting', 'my_utm_northing', 'log',
  ];
  const lines = [cols.join(sep)];
  for (const r of rows) lines.push(cols.map(c => csvCell(r[c], sep)).join(sep));
  // BOM so Excel opens UTF-8 (umlauts) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// Where a template's fields end up in the ADIF export, for the template
// preview: [["QTH / Standort", "QTH, GRIDSQUARE, LAT, LON"], ["PLZ",
// "APP_OE1EBG_PLZ"], ...]. A location field also gives the resolved position.
export function adifFieldTargets(tpl) {
  return tpl.fields.map(f => [f.label, [adifFieldName(f),
    ...(f.type === 'location' ? ['GRIDSQUARE', 'LAT', 'LON', `APP_${ADIF_PROGRAM_ID}_UTM`] : [])].join(', ')]);
}

// ADIF GridSquare: 2, 4, 6 or 8 characters; characters 9-12 of a longer
// locator go into the *_EXT field (ADIF 3.1.7). ADIF has no room for more:
// characters 13-20 (cells well under a metre) are left out; full: the whole
// locator, for an app field. null when it's no locator.
export function adifGrid(raw) {
  const g = String(raw ?? '').trim();
  if (!isValidLocator(g)) return null;
  const f = formatLocator(g);
  return { grid: f.slice(0, 8), ext: f.slice(8, 12), full: f };
}

// A callsign for OPERATOR / STATION_CALLSIGN, or null when the header holds
// something else (a name, a typo): ADIF wants a callsign there.
function adifCall(raw) {
  const c = normalizeCall(raw);
  return c && isPlausibleCall(c) ? c : null;
}

// "+0.6" / "-7.6" (ASCII: the ADIF comment can't carry "−")
function shiftAscii(text) {
  const v = parseMHz(text);
  if (v === null) return '';
  return v === 0 ? 'simplex' : `${v > 0 ? '+' : ''}${Math.round(v * 1e6) / 1e6}`;
}

// Fields toADIF() writes itself: a template field must not map onto one of
// them (ADIF: no field name twice in a record). Checked by the tests.
export const ADIF_FIXED_FIELDS = [
  'CALL', 'QSO_DATE', 'TIME_ON', 'OPERATOR', 'STATION_CALLSIGN', 'FREQ', 'BAND', 'FREQ_RX', 'BAND_RX', 'MODE',
  'SUBMODE', 'MY_GRIDSQUARE', 'MY_GRIDSQUARE_EXT', 'MY_CITY', 'PROP_MODE', 'GRIDSQUARE', 'GRIDSQUARE_EXT', 'LAT',
  'LON', 'COMMENT',
  ...['REPEATER', 'SIGNALLING', 'MY_LOCATOR', 'LOCATOR', 'LOCATION', 'LOC_NAMETYPE', 'LOC_MATCHED', 'LOC_SOURCE', 'LOC_INPUT',
    'UTM', 'MY_UTM', 'CHECKIN', 'LOG']
    .map(n => `APP_${ADIF_PROGRAM_ID}_${n}`),
];

// The ADIF field a template field is exported to.
export function adifFieldName(f) {
  return f.adif || `APP_${ADIF_PROGRAM_ID}_${f.key.toUpperCase()}`;
}

// What logbook programs will stumble over, per line: no band/frequency, no
// mode, header values that aren't a callsign / locator. The export still
// works (those values go into COMMENT); app.js shows the list first.
// [{ nr, call, problems: [text] }]
export function adifIssues(event, entries) {
  const out = [];
  for (const e of liveCheckins(entries)) {
    const s = e.snap || {};
    const { tx, rx } = lineFrequencies(e);
    const problems = [];
    if (tx === null && rx === null) problems.push('keine Frequenz');
    if (!modeInfo(s.mode)) problems.push('keine Betriebsart');
    if (!isPlausibleCall(normalizeCall(e.call))) problems.push(`Rufzeichen „${e.call}“ ungewöhnlich`);
    if (s.operator && !adifCall(s.operator)) problems.push(`Operator „${s.operator}“ ist kein Rufzeichen`);
    if (s.station && !adifCall(s.station)) problems.push(`Station „${s.station}“ ist kein Rufzeichen`);
    if (s.myGrid && !adifGrid(s.myGrid)) problems.push(`eigener Locator „${s.myGrid}“ ungültig`);
    if (problems.length) out.push({ nr: e.seq, call: e.call, problems });
  }
  return out;
}

// opts.programVersion: PROGRAMVERSION header field (the build's commit).
// opts.qth(text): the resolved header QTH (see the top of this file).
export function toADIF(event, entries, createdIso = new Date().toISOString(), opts = {}) {
  const tpl = templateFor(event.template);
  const nums = checkinNumbers(entries);
  const ts = createdIso.replace(/[-:]/g, '').replace('T', ' ').slice(0, 15);
  let out = `Bestaetigungsverkehr-Log: ${adifAscii(event.title)}\n`;
  out += `<ADIF_VER:5>3.1.7 <PROGRAMID:${ADIF_PROGRAM_ID.length}>${ADIF_PROGRAM_ID} `;
  out += adifAsciiField('PROGRAMVERSION', opts.programVersion);
  out += `<CREATED_TIMESTAMP:15>${ts} <EOH>\n\n`;

  for (const e of liveCheckins(entries)) {
    const s = e.snap || {};
    const { date, time } = splitUtc(e.ts);
    const { tx, rx } = lineFrequencies(e);
    const mode = modeInfo(s.mode);
    // Header values that don't fit their ADIF field: kept in the comment.
    const comment = [];
    const operator = adifCall(s.operator);
    const station = adifCall(s.station);
    const myGrid = adifGrid(s.myGrid);
    if (s.operator && !operator) comment.push(`Operator: ${s.operator}`);
    if (s.station && !station) comment.push(`Station: ${s.station}`);
    if (s.myGrid && !myGrid) comment.push(`Eigener Locator: ${s.myGrid}`);
    let rec = '';
    rec += adifAsciiField('CALL', normalizeCall(e.call) || e.call);
    rec += adifAsciiField('QSO_DATE', date.replace(/-/g, ''));
    rec += adifAsciiField('TIME_ON', time.replace(/:/g, ''));
    rec += adifAsciiField('OPERATOR', operator);
    rec += adifAsciiField('STATION_CALLSIGN', station || operator);
    if (tx !== null) {
      rec += adifAsciiField('FREQ', fmtMHz(tx));
      rec += adifAsciiField('BAND', bandForMHz(tx));
    }
    if (rx !== null && rx !== tx) {
      rec += adifAsciiField('FREQ_RX', fmtMHz(rx));
      rec += adifAsciiField('BAND_RX', bandForMHz(rx));
    }
    if (mode) {
      rec += adifAsciiField('MODE', mode.mode);
      if (mode.submode) rec += adifAsciiField('SUBMODE', mode.submode);
    }
    if (myGrid) {
      rec += adifAsciiField('MY_GRIDSQUARE', myGrid.grid);
      rec += adifAsciiField('MY_GRIDSQUARE_EXT', myGrid.ext);
      if (myGrid.full.length > 12) rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_MY_LOCATOR`, myGrid.full);
    }
    rec += adifAsciiField('MY_CITY', s.myQth);
    rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_MY_UTM`, ownUtm(s, opts.qth)?.text);
    // ADIF has no fields for CTCSS, DMR colour code etc.: an app field
    // plus the comment.
    const sig = signallingText(s);
    if (e.viaRepeater) {
      rec += adifAsciiField('PROP_MODE', 'RPT');
      const rptOut = parseMHz(s.repeaterFreq);
      const shift = shiftAscii(s.repeaterShift);
      const rpt = [s.repeaterCall, rptOut !== null && `${formatMHz(rptOut)} MHz`, shift && `Shift ${shift}`, sig]
        .filter(Boolean).join(' ');
      if (rpt) {
        rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_REPEATER`, s.repeaterCall || rpt);
        comment.push(`via Relais ${rpt}`);
      }
    } else if (sig) {
      comment.push(sig);
    }
    rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_SIGNALLING`, sig);
    for (const f of tpl.fields) {
      if (!fieldVisible(f, e.fields, tpl)) continue;
      const raw = e.fields?.[f.key];
      if (raw === undefined || raw === null || raw === '') continue;
      rec += adifAsciiField(adifFieldName(f), raw);
      if (!f.adif) comment.push(`${f.label}: ${fieldDisplay(f, raw)}`);
    }
    if (e.loc) {
      const grid = adifGrid(e.loc.maidenhead);
      if (grid) {
        rec += adifAsciiField('GRIDSQUARE', grid.grid);
        rec += adifAsciiField('GRIDSQUARE_EXT', grid.ext);
        if (grid.full.length > 12) rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_LOCATOR`, grid.full);
      }
      rec += adifAsciiField('LAT', adifLatLon(e.loc.lat, true));
      rec += adifAsciiField('LON', adifLatLon(e.loc.lon, false));
      rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_UTM`, utmFields(e.loc)?.text);
      rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_LOCATION`, e.loc.label);
      rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_LOC_NAMETYPE`, locNameType(e.loc));
      rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_LOC_MATCHED`, e.loc.matched);
      const from = locOriginText(e.loc);
      comment.push(`Standort: ${e.loc.label} (${LOC_CONF_DE[e.loc.confidence] || e.loc.confidence}${from ? `, ${from}` : ''})`);
    }
    const lf = locationField(tpl);
    if (lf) {
      rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_LOC_SOURCE`, locOrigin(e.loc, e.fields?.[lf.key]));
      rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_LOC_INPUT`, e.loc?.input);
    }
    rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_CHECKIN`, String(nums.get(e.id)));
    rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_LOG`, event.title);
    if (e.note) comment.push(e.note);
    rec += adifAsciiField('COMMENT', comment.join('; '));
    out += rec + '<EOR>\n';
  }
  return out;
}

// KML 2.2 for Google Earth / Google My Maps: one placemark per station with
// a resolved location — the same set as the map view (stationsForMap), at
// the station's latest located check-in. Event metadata on <Document>.
export const KML_MIME = 'application/vnd.google-earth.kml+xml';
// XML namespace identifier, not a request (tests/confirm-offline.test.mjs).
const KML_NS = 'http://www.opengis.net/kml/2.2';

// XML text/attribute escaping; drops control characters XML 1.0 forbids.
export function xmlEscape(s) {
  return String(s ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function kmlUtc(iso) {
  const { date, time } = splitUtc(iso);
  return date ? `${date} ${time} UTC` : '';
}

// Repeater(s) a station came in on, from the per-line snapshots.
function kmlRepeaters(checkins) {
  const set = new Set(checkins.map(e => (e.viaRepeater ? e.snap?.repeaterCall || 'Relais (unbekannt)' : 'direkt')));
  return [...set].join(', ');
}

// [label, value] pairs for a station: the placemark's description (HTML in
// Google Earth) and its <ExtendedData> (columns in Google My Maps).
function kmlStationFields(s) {
  const loc = s.loc;
  const where = `${loc.label}${loc.postcode && !String(loc.label).includes(loc.postcode) ? ', ' + loc.postcode : ''}`;
  return [
    ['Rufzeichen', s.call],
    ['Check-ins', String(s.checkins.length)],
    ['Zeit (UTC)', s.checkins.map(e => kmlUtc(e.ts)).join(', ')],
    ['Relais', kmlRepeaters(s.checkins)],
    ['Standort', where],
    ['Eingabe', loc.input && loc.input !== loc.label ? loc.input : ''],
    ['Gefunden als', loc.matched ? `„${loc.matched}“ (${LOC_NAME_TYPES[loc.nameType] || 'anderer Name'})` : ''],
    ['Art', ['intersection', 'between'].includes(loc.type) ? LOC_NAME_TYPES[loc.type] : loc.umland ? 'außerhalb Wiens' : ''],
    ['Locator', [loc.maidenhead, ...(loc.areaLocators || []).filter(l => l !== loc.maidenhead)].filter(Boolean).join(' ')],
    ['UTMREF', utmFields(loc)?.text || ''],
    ['Konfidenz', LOC_CONF_DE[loc.confidence] || loc.confidence || ''],
    ['Zuordnung', loc.manual ? 'gewählt' : 'automatisch'],
    ['Herkunft', locOriginText(loc)],
    ['Koordinaten', `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`],
  ].filter(([, v]) => v !== '' && v !== undefined && v !== null);
}

// The HTML is escaped once more as XML text content.
function kmlDescription(fields) {
  return xmlEscape(fields.map(([k, v]) => `<b>${xmlEscape(k)}:</b> ${xmlEscape(v)}`).join('<br>'));
}

// opts.qth(text): the resolved header QTH (see the top of this file).
export function toKML(event, entries, opts = {}) {
  const { placed } = stationsForMap(entries);
  const h = event.header || {};
  const live = liveCheckins(entries);
  const own = ownUtm(h, opts.qth);
  const docFields = [
    ['Datum (UTC)', splitUtc(live[0]?.ts || event.created).date],
    ['Operator', h.operator],
    ['Station', h.station],
    ['Eigener Standort (UTMREF)', own ? `${own.text} (${own.label}${own.fromLocator ? ', Locator-Mitte' : ''})` : ''],
    ['Stationen mit Standort', `${placed.length} von ${new Set(live.map(e => e.call)).size}`],
  ].filter(([, v]) => v);
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<kml xmlns="${KML_NS}">`,
    '<Document>',
    `  <name>${xmlEscape(event.title)}</name>`,
    `  <description>${kmlDescription(docFields)}</description>`,
  ];
  for (const s of placed) {
    const fields = kmlStationFields(s);
    out.push(
      '  <Placemark>',
      `    <name>${xmlEscape(s.call)}</name>`,
      `    <description>${kmlDescription(fields)}</description>`,
      '    <ExtendedData>',
      ...fields.map(([k, v]) => `      <Data name="${xmlEscape(k)}"><value>${xmlEscape(v)}</value></Data>`),
      '    </ExtendedData>',
      // KML order is lon,lat
      `    <Point><coordinates>${s.loc.lon.toFixed(5)},${s.loc.lat.toFixed(5)}</coordinates></Point>`,
      '  </Placemark>');
  }
  out.push('</Document>', '</kml>');
  return out.join('\n') + '\n';
}

// Average (German decimal comma), count and distribution of 1-5 grades.
export function gradeStats(rows, key) {
  const vals = rows.map(r => parseInt(r[key], 10)).filter(n => n >= 1 && n <= 5);
  if (!vals.length) return null;
  const avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1).replace('.', ',');
  const dist = [1, 2, 3, 4, 5].map(g => [g, vals.filter(v => v === g).length]).filter(([, c]) => c).map(([g, c]) => `${c}× ${g}`).join(', ');
  return { avg, n: vals.length, dist };
}

// key: row property name or a function row -> value.
function countBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const v = (typeof key === 'function' ? key(r) : r[key]) || '—';
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// Plain text for pasting into a net report / mail; times in `timeMode`.
// opts.qth(text): the resolved header QTH (see the top of this file).
export function toSummary(event, entries, timeMode = 'utc', opts = {}) {
  const rows = exportRows(event, entries, opts);
  const st = stats(entries);
  const h = event.header || {};
  const lines = [];
  lines.push(`${event.title}`);
  const who = [h.operator && `Operator ${h.operator}`, h.station && `für ${h.station}`].filter(Boolean).join(' ');
  if (who) lines.push(who);
  // The time span covers all lines, operator comments included.
  const all = liveSorted(entries);
  const first = all[0], last = all[all.length - 1];
  const day0 = first ? splitTime(first.ts, timeMode).date : '';
  // "19:30", or "2026-10-05 00:10" on a later day than the first line.
  const hm = iso => {
    const t = splitTime(iso, timeMode);
    return `${t.date !== day0 ? t.date + ' ' : ''}${t.time.slice(0, 5)}`;
  };
  if (first) {
    const a = splitTime(first.ts, timeMode);
    lines.push(`${a.date} ${a.time.slice(0, 5)}–${hm(last.ts)} ${zoneLabel(first.ts, timeMode)}`);
  }
  // Who operated when (only worth a line once the operator changed).
  const shifts = operatorShifts(entries);
  if (shifts.length > 1) {
    lines.push(`Operators: ${shifts.map((s, i) => `${s.operator} ${hm(s.from)}–${i === shifts.length - 1 && s.to === s.from ? '…' : hm(s.to)}`).join(', ')} ${zoneLabel(first.ts, timeMode)}`);
  }
  lines.push(`${st.unique} Stationen, ${st.total} Check-ins`);
  lines.push('');
  const seen = new Set();
  const calls = [];
  for (const r of rows) if (!seen.has(r.rufzeichen)) { seen.add(r.rufzeichen); calls.push(r.rufzeichen); }
  lines.push(calls.join(', '));

  // Operator comments / markers in time order.
  const comments = all.filter(isComment);
  if (comments.length) {
    lines.push('', `Operator-Kommentare (${zoneLabel(comments[0].ts, timeMode)}):`);
    for (const c of comments) {
      const op = c.snap?.operator ? ` (Op ${c.snap.operator})` : '';
      lines.push(`  ${hm(c.ts)} ${c.category ? `[${c.category}] ` : ''}${c.text || ''}${op}`.trimEnd());
    }
  }

  // Where the stations were (latest located check-in, like the map and KML).
  const { placed } = stationsForMap(entries);
  const own = ownUtm(h, opts.qth);
  if (placed.length || own) {
    lines.push('', 'Standorte (UTMREF):');
    if (own) lines.push(`  Eigener Standort: ${own.label} – ${own.text}${own.fromLocator ? ' (Locator-Mitte)' : ''}`);
    for (const s of placed) {
      const loc = s.loc;
      const where = `${loc.label}${loc.postcode && !String(loc.label).includes(loc.postcode) ? ', ' + loc.postcode : ''}`;
      lines.push(`  ${s.call}: ${where} – ${utmFields(loc)?.text || ''}`);
    }
  }

  // Which repeater the stations came in on (e.g. linked-network exercises).
  if (rows.some(r => r.ueber_relais === 'ja')) {
    const by = new Map();
    for (const r of rows) {
      const k = r.ueber_relais === 'ja' ? (r.relais || 'Relais (unbekannt)') : 'direkt';
      if (!by.has(k)) by.set(k, new Set());
      by.get(k).add(r.rufzeichen);
    }
    lines.push('', 'Nach Relais:');
    for (const [k, set] of [...by.entries()].sort((a, b) => b[1].size - a[1].size)) {
      lines.push(`  ${k}: ${set.size} (${[...set].join(', ')})`);
    }
  }

  if (event.template === 'zivilschutz') {
    // Only the latest check-in per station counts for the statistics.
    const latest = new Map();
    for (const r of rows) latest.set(r.rufzeichen, r);
    const per = [...latest.values()];
    const tpl = templateFor(event.template);
    const grades = tpl.fields.filter(f => f.grade);
    const short = f => f.label.replace(/^Sirene /, '');
    lines.push('', 'Sirene (Schulnote 1 = sehr gut hörbar … 5 = nicht hörbar):');
    for (const f of grades) {
      const g = gradeStats(per, f.key);
      lines.push(`  ${short(f)}: ${g ? `Ø ${g.avg} (n=${g.n}; ${g.dist})` : 'keine Angaben'}`);
    }
    lines.push('AT-Alert:');
    for (const [k, n] of countBy(per, 'atalert')) lines.push(`  ${k}: ${n}`);
    const noAlert = per.filter(r => r.atalert === 'nicht erhalten');
    if (noAlert.length) {
      lines.push('Nicht erhalten nach Plattform/Version:');
      for (const [k, n] of countBy(noAlert, r => (r.os_version && r.os_version !== 'weiß nicht' ? r.os_version : [r.platform, r.os_version].filter(Boolean).join(' – ')))) {
        lines.push(`  ${k}: ${n}`);
      }
    }
    lines.push('Nach PLZ:');
    const byPlz = new Map();
    for (const r of per) {
      const k = r.plz || '—';
      if (!byPlz.has(k)) byPlz.set(k, []);
      byPlz.get(k).push(r);
    }
    for (const [plz, rs] of [...byPlz.entries()].sort()) {
      const alert = rs.filter(r => r.atalert === 'erhalten').length;
      const sirens = grades.map(f => `${short(f)} ${gradeStats(rs, f.key)?.avg ?? '–'}`).join(' / ');
      lines.push(`  ${plz}: ${rs.length} Stn., AT-Alert ${alert}/${rs.length}; Sirene Ø ${sirens}`);
    }
  }
  return lines.join('\n') + '\n';
}
