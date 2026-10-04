// CSV / ADIF / plain-text summary export. Pure functions over an event and
// its entries — no DOM — so they're unit-tested in oe1ebg/tests/.

import { liveSorted, checkinNumbers, splitUtc, splitTime, zoneLabel, lineFrequencies, bandForMHz, modeInfo, stats } from './model.js';
import { templateFor, fieldVisible, fieldDisplay, hasLocationField } from './templates.js';

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

// One flat row per live entry; shared by CSV and the summary.
function exportRows(event, entries) {
  const tpl = templateFor(event.template);
  const nums = checkinNumbers(entries);
  return liveSorted(entries).map(e => {
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

export function toCSV(event, entries, sep = ';') {
  const rows = exportRows(event, entries);
  const tpl = templateFor(event.template);
  const cols = [
    'zeitstempel_utc', 'nr', 'checkin_nr', 'rufzeichen',
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

// ADIF .adi is an ASCII format: transliterate German characters, replace
// anything else non-ASCII, and drop the "<" ">" that would break parsing.
export function adifAscii(s) {
  return String(s ?? '')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/[^\x20-\x7e]/g, '?')
    .trim();
}

function adifField(name, value) {
  const v = adifAscii(value);
  return v === '' ? '' : `<${name}:${v.length}>${v} `;
}

export function toADIF(event, entries, createdIso = new Date().toISOString()) {
  const tpl = templateFor(event.template);
  const nums = checkinNumbers(entries);
  const ts = createdIso.replace(/[-:]/g, '').replace('T', ' ').slice(0, 15);
  let out = `Bestaetigungsverkehr-Log: ${adifAscii(event.title)}\n`;
  out += `<ADIF_VER:5>3.1.7 <PROGRAMID:${ADIF_PROGRAM_ID.length}>${ADIF_PROGRAM_ID} `;
  out += `<CREATED_TIMESTAMP:15>${ts} <EOH>\n\n`;

  for (const e of liveSorted(entries)) {
    const s = e.snap || {};
    const { date, time } = splitUtc(e.ts);
    const { tx, rx } = lineFrequencies(e);
    const mode = modeInfo(s.mode);
    const comment = [];
    let rec = '';
    rec += adifField('CALL', e.call);
    rec += adifField('QSO_DATE', date.replace(/-/g, ''));
    rec += adifField('TIME_ON', time.replace(/:/g, ''));
    rec += adifField('OPERATOR', s.operator);
    rec += adifField('STATION_CALLSIGN', s.station || s.operator);
    if (tx !== null) {
      rec += adifField('FREQ', fmtMHz(tx));
      rec += adifField('BAND', bandForMHz(tx));
    }
    if (rx !== null && rx !== tx) {
      rec += adifField('FREQ_RX', fmtMHz(rx));
      rec += adifField('BAND_RX', bandForMHz(rx));
    }
    if (mode) {
      rec += adifField('MODE', mode.mode);
      if (mode.submode) rec += adifField('SUBMODE', mode.submode);
    }
    rec += adifField('MY_GRIDSQUARE', s.myGrid);
    rec += adifField('MY_CITY', s.myQth);
    if (e.viaRepeater) {
      rec += adifField('PROP_MODE', 'RPT');
      const rpt = [s.repeaterCall, s.repeaterFreq && `${s.repeaterFreq} MHz`, s.repeaterShift && `Shift ${s.repeaterShift}`,
        s.repeaterTone && `CTCSS ${s.repeaterTone}`].filter(Boolean).join(' ');
      if (rpt) {
        rec += adifField(`APP_${ADIF_PROGRAM_ID}_REPEATER`, s.repeaterCall || rpt);
        comment.push(`via Relais ${rpt}`);
      }
    }
    for (const f of tpl.fields) {
      if (!fieldVisible(f, e.fields, tpl)) continue;
      const raw = e.fields?.[f.key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (f.adif) {
        rec += adifField(f.adif, raw);
      } else {
        rec += adifField(`APP_${ADIF_PROGRAM_ID}_${f.key.toUpperCase()}`, raw);
        comment.push(`${f.label}: ${fieldDisplay(f, raw)}`);
      }
    }
    if (e.loc) {
      rec += adifField('GRIDSQUARE', e.loc.maidenhead);
      rec += adifField('LAT', adifLatLon(e.loc.lat, true));
      rec += adifField('LON', adifLatLon(e.loc.lon, false));
      rec += adifField(`APP_${ADIF_PROGRAM_ID}_LOCATION`, e.loc.label);
      comment.push(`Standort: ${e.loc.label} (${LOC_CONF_DE[e.loc.confidence] || e.loc.confidence})`);
    }
    rec += adifField(`APP_${ADIF_PROGRAM_ID}_CHECKIN`, String(nums.get(e.id)));
    rec += adifField(`APP_${ADIF_PROGRAM_ID}_LOG`, event.title);
    if (e.note) comment.push(e.note);
    rec += adifField('COMMENT', comment.join('; '));
    out += rec + '<EOR>\n';
  }
  return out;
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
  const first = rows[0], last = rows[rows.length - 1];
  if (first) {
    const a = splitTime(first.ts, timeMode), b = splitTime(last.ts, timeMode);
    lines.push(`${a.date} ${a.time.slice(0, 5)}–${b.date !== a.date ? b.date + ' ' : ''}${b.time.slice(0, 5)} ${zoneLabel(first.ts, timeMode)}`);
  }
  lines.push(`${st.unique} Stationen, ${st.total} Check-ins`);
  lines.push('');
  const seen = new Set();
  const calls = [];
  for (const r of rows) if (!seen.has(r.rufzeichen)) { seen.add(r.rufzeichen); calls.push(r.rufzeichen); }
  lines.push(calls.join(', '));

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
