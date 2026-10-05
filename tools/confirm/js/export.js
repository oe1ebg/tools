// CSV / ADIF / KML / plain-text summary export. Pure functions over an event and
// its entries — no DOM — so they're unit-tested in oe1ebg/tests/.
//
// Operator comments (kind 'comment', see js/model.js) are no QSOs:
//   ADIF, KML (and the map): never included;
//   CSV: left out unless { comments: true } (then a `typ` column
//        checkin/kommentar plus `kategorie`; QSO fields stay empty);
//   summary: included in time order, plus an "Operators:" line;
//   JSON backup (app.js): always included, it is the raw entries store.

import {
  liveSorted, liveCheckins, isComment, checkinNumbers, operatorShifts, splitUtc, splitTime, zoneLabel, lineFrequencies,
  bandForMHz, modeInfo, stats,
} from './model.js';
import { templateFor, fieldVisible, fieldDisplay, hasLocationField } from './templates.js';
import { stationsForMap } from './mapdata.js';
import { adifAscii, adifAsciiField } from '../../shared/js/adif.js';

export const ADIF_PROGRAM_ID = 'OE1EBG';

const LOC_CONF_DE = { exact: 'exakt', high: 'hoch', likely: 'wahrscheinlich', ambiguous: 'mehrdeutig', low: 'unsicher' };
const LOC_COLS = ['standort_aufgeloest', 'lat', 'lon', 'locator', 'standort_konfidenz', 'standort_quelle'];

function locColumns(loc) {
  if (!loc) return { standort_aufgeloest: '', lat: '', lon: '', locator: '', standort_konfidenz: '', standort_quelle: '' };
  return {
    standort_aufgeloest: loc.label,
    lat: loc.lat.toFixed(5),
    lon: loc.lon.toFixed(5),
    locator: loc.maidenhead,
    standort_konfidenz: LOC_CONF_DE[loc.confidence] || loc.confidence || '',
    standort_quelle: loc.manual ? 'gewählt' : 'automatisch',
  };
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
function exportRows(event, entries) {
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
    if (hasLocationField(tpl)) Object.assign(row, locColumns(e.loc));
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
      my_locator: s.myGrid,
      log: event.title,
    });
    return row;
  });
}

// A comment as a CSV row: time, typ, kategorie, the text in `notiz`, and
// who operated (from its snapshot); all QSO fields stay empty.
function commentRow(event, e) {
  const s = e.snap || {};
  return {
    zeitstempel_utc: excelUtc(e.ts), typ: 'kommentar', kategorie: e.category || '', ts: e.ts,
    notiz: e.text || '', operator: s.operator, station: s.station, my_locator: s.myGrid, log: event.title,
  };
}

// opts.comments: include operator comments (default: no, one row per check-in).
export function toCSV(event, entries, sep = ';', opts = {}) {
  const withComments = !!opts.comments;
  let rows = exportRows(event, entries);
  if (withComments) {
    const byId = new Map(liveCheckins(entries).map((e, i) => [e.id, rows[i]]));
    rows = liveSorted(entries).map(e => (isComment(e) ? commentRow(event, e) : { ...byId.get(e.id), typ: 'checkin' }));
  }
  const tpl = templateFor(event.template);
  const cols = [
    'zeitstempel_utc', ...(withComments ? ['typ', 'kategorie'] : []), 'nr', 'checkin_nr', 'rufzeichen',
    ...tpl.fields.map(f => f.key),
    ...(hasLocationField(tpl) ? LOC_COLS : []),
    'ueber_relais', 'relais', 'relais_ctcss', 'relais_quelle', 'notiz', 'operator', 'station',
    'freq_mhz', 'freq_rx_mhz', 'band', 'mode', 'my_locator', 'log',
  ];
  const lines = [cols.join(sep)];
  for (const r of rows) lines.push(cols.map(c => csvCell(r[c], sep)).join(sep));
  // BOM so Excel opens UTF-8 (umlauts) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function toADIF(event, entries, createdIso = new Date().toISOString()) {
  const tpl = templateFor(event.template);
  const nums = checkinNumbers(entries);
  const ts = createdIso.replace(/[-:]/g, '').replace('T', ' ').slice(0, 15);
  let out = `Bestaetigungsverkehr-Log: ${adifAscii(event.title)}\n`;
  out += `<ADIF_VER:5>3.1.7 <PROGRAMID:${ADIF_PROGRAM_ID.length}>${ADIF_PROGRAM_ID} `;
  out += `<CREATED_TIMESTAMP:15>${ts} <EOH>\n\n`;

  for (const e of liveCheckins(entries)) {
    const s = e.snap || {};
    const { date, time } = splitUtc(e.ts);
    const { tx, rx } = lineFrequencies(e);
    const mode = modeInfo(s.mode);
    const comment = [];
    let rec = '';
    rec += adifAsciiField('CALL', e.call);
    rec += adifAsciiField('QSO_DATE', date.replace(/-/g, ''));
    rec += adifAsciiField('TIME_ON', time.replace(/:/g, ''));
    rec += adifAsciiField('OPERATOR', s.operator);
    rec += adifAsciiField('STATION_CALLSIGN', s.station || s.operator);
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
    rec += adifAsciiField('MY_GRIDSQUARE', s.myGrid);
    rec += adifAsciiField('MY_CITY', s.myQth);
    if (e.viaRepeater) {
      rec += adifAsciiField('PROP_MODE', 'RPT');
      const rpt = [s.repeaterCall, s.repeaterFreq && `${s.repeaterFreq} MHz`, s.repeaterShift && `Shift ${s.repeaterShift}`,
        s.repeaterTone && `CTCSS ${s.repeaterTone}`].filter(Boolean).join(' ');
      if (rpt) {
        rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_REPEATER`, s.repeaterCall || rpt);
        comment.push(`via Relais ${rpt}`);
      }
    }
    for (const f of tpl.fields) {
      if (!fieldVisible(f, e.fields, tpl)) continue;
      const raw = e.fields?.[f.key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (f.adif) {
        rec += adifAsciiField(f.adif, raw);
      } else {
        rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_${f.key.toUpperCase()}`, raw);
        comment.push(`${f.label}: ${fieldDisplay(f, raw)}`);
      }
    }
    if (e.loc) {
      rec += adifAsciiField('GRIDSQUARE', e.loc.maidenhead);
      rec += adifAsciiField('LAT', adifLatLon(e.loc.lat, true));
      rec += adifAsciiField('LON', adifLatLon(e.loc.lon, false));
      rec += adifAsciiField(`APP_${ADIF_PROGRAM_ID}_LOCATION`, e.loc.label);
      comment.push(`Standort: ${e.loc.label} (${LOC_CONF_DE[e.loc.confidence] || e.loc.confidence})`);
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
    ['Locator', [loc.maidenhead, ...(loc.areaLocators || []).filter(l => l !== loc.maidenhead)].filter(Boolean).join(' ')],
    ['Konfidenz', LOC_CONF_DE[loc.confidence] || loc.confidence || ''],
    ['Zuordnung', loc.manual ? 'gewählt' : 'automatisch'],
    ['Koordinaten', `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`],
  ].filter(([, v]) => v !== '' && v !== undefined && v !== null);
}

// The HTML is escaped once more as XML text content.
function kmlDescription(fields) {
  return xmlEscape(fields.map(([k, v]) => `<b>${xmlEscape(k)}:</b> ${xmlEscape(v)}`).join('<br>'));
}

export function toKML(event, entries) {
  const { placed } = stationsForMap(entries);
  const h = event.header || {};
  const live = liveCheckins(entries);
  const docFields = [
    ['Datum (UTC)', splitUtc(live[0]?.ts || event.created).date],
    ['Operator', h.operator],
    ['Station', h.station],
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
export function toSummary(event, entries, timeMode = 'utc') {
  const rows = exportRows(event, entries);
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
