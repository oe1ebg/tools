// CSV / ADIF / plain-text summary export. Pure functions over an event and
// its entries — no DOM — so they're unit-tested in oe1ebg/tests/.

import { liveSorted, checkinNumbers, splitUtc, lineFrequencies, bandForMHz, modeInfo, stats } from './model.js';
import { templateFor, fieldVisible, fieldDisplay } from './templates.js';

export const ADIF_PROGRAM_ID = 'OE1EBG';

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
    const { date, time } = splitUtc(e.ts);
    const { tx, rx } = lineFrequencies(e);
    const s = e.snap || {};
    const row = {
      nr: e.seq,
      checkin_nr: nums.get(e.id),
      datum_utc: date,
      zeit_utc: time,
      rufzeichen: e.call,
    };
    for (const f of tpl.fields) row[f.key] = fieldVisible(f, e.fields) ? fieldDisplay(f, e.fields?.[f.key]) : '';
    Object.assign(row, {
      ueber_relais: e.viaRepeater ? 'ja' : 'nein',
      relais: e.viaRepeater ? s.repeaterCall : '',
      notiz: e.note || '',
      operator: s.operator,
      station: s.station,
      freq_mhz: fmtMHz(tx),
      freq_rx_mhz: fmtMHz(rx),
      band: bandForMHz(tx ?? rx),
      mode: modeInfo(s.mode)?.label || '',
      my_locator: s.myGrid,
      ereignis: event.title,
    });
    return row;
  });
}

export function toCSV(event, entries, sep = ';') {
  const rows = exportRows(event, entries);
  const tpl = templateFor(event.template);
  const cols = [
    'nr', 'checkin_nr', 'datum_utc', 'zeit_utc', 'rufzeichen',
    ...tpl.fields.map(f => f.key),
    'ueber_relais', 'relais', 'notiz', 'operator', 'station',
    'freq_mhz', 'freq_rx_mhz', 'band', 'mode', 'my_locator', 'ereignis',
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
      const rpt = [s.repeaterCall, s.repeaterFreq && `${s.repeaterFreq} MHz`, s.repeaterShift && `Shift ${s.repeaterShift}`]
        .filter(Boolean).join(' ');
      if (rpt) {
        rec += adifField(`APP_${ADIF_PROGRAM_ID}_REPEATER`, s.repeaterCall || rpt);
        comment.push(`via Relais ${rpt}`);
      }
    }
    for (const f of tpl.fields) {
      if (!fieldVisible(f, e.fields)) continue;
      const raw = e.fields?.[f.key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (f.adif) {
        rec += adifField(f.adif, raw);
      } else {
        rec += adifField(`APP_${ADIF_PROGRAM_ID}_${f.key.toUpperCase()}`, raw);
        comment.push(`${f.label}: ${fieldDisplay(f, raw)}`);
      }
    }
    rec += adifField(`APP_${ADIF_PROGRAM_ID}_CHECKIN`, String(nums.get(e.id)));
    rec += adifField(`APP_${ADIF_PROGRAM_ID}_EVENT`, event.title);
    if (e.note) comment.push(e.note);
    rec += adifField('COMMENT', comment.join('; '));
    out += rec + '<EOR>\n';
  }
  return out;
}

function countBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const v = r[key] || '—';
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// Plain text for pasting into a net report / mail.
export function toSummary(event, entries) {
  const rows = exportRows(event, entries);
  const st = stats(entries);
  const h = event.header || {};
  const lines = [];
  lines.push(`${event.title}`);
  const who = [h.operator && `Operator ${h.operator}`, h.station && `für ${h.station}`].filter(Boolean).join(' ');
  if (who) lines.push(who);
  const first = rows[0], last = rows[rows.length - 1];
  if (first) lines.push(`${first.datum_utc} ${first.zeit_utc.slice(0, 5)}–${last.zeit_utc.slice(0, 5)} UTC`);
  lines.push(`${st.unique} Stationen, ${st.total} Check-ins`);
  lines.push('');
  const seen = new Set();
  const calls = [];
  for (const r of rows) if (!seen.has(r.rufzeichen)) { seen.add(r.rufzeichen); calls.push(r.rufzeichen); }
  lines.push(calls.join(', '));

  if (event.template === 'zivilschutz') {
    // Only the latest check-in per station counts for the statistics.
    const latest = new Map();
    for (const r of rows) latest.set(r.rufzeichen, r);
    const per = [...latest.values()];
    lines.push('', 'Sirene:');
    for (const [k, n] of countBy(per, 'siren')) lines.push(`  ${k}: ${n}`);
    lines.push('AT-Alert:');
    for (const [k, n] of countBy(per, 'atalert')) lines.push(`  ${k}: ${n}`);
    const noAlert = per.filter(r => r.atalert === 'nicht erhalten');
    if (noAlert.length) {
      lines.push('Nicht erhalten nach Plattform:');
      for (const [k, n] of countBy(noAlert, 'platform')) lines.push(`  ${k}: ${n}`);
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
      const sirens = countBy(rs, 'siren').map(([k, n]) => `${k} ${n}`).join(', ');
      lines.push(`  ${plz}: ${rs.length} Stn., AT-Alert ${alert}/${rs.length}; Sirene: ${sirens}`);
    }
  }
  return lines.join('\n') + '\n';
}
