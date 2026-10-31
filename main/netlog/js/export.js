// Exports of one session: stations and notes as CSV, the check-ins as
// ADIF, the parts of the printed report. Pure functions over the session's
// records (no DOM, no storage), unit-tested in oe1ebg/tests/.
//
// What goes where:
//   stations CSV  one row per station of the session (not the deleted ones)
//   notes CSV     one row per live note, in recorded order, with its
//                 response (prepared reply) and after-net task
//   ADIF          one record per checked-in station: the first check-in is
//                 the QSO time; my own station, partial callsigns ("OE0QX?")
//                 and stations without a check-in time are left out (listed
//                 by netAdifIssues() before the export). Notes never go into
//                 ADIF.
// Times are UTC (ISO dates, 24-hour times); an estimated time is marked
// in the CSVs and in the ADIF COMMENT, never made more precise.

import { adifAscii, adifAsciiField } from '../../shared/js/adif.js';
import { ADIF_SPEC_ENUMS } from '../../shared/js/adif-spec-data.js';
import { isValidLocator, formatLocator } from '../../shared/js/maidenhead.js';
import { csvSafeRows } from '../../shared/js/csv.js';
import { splitUtc } from '../../shared/js/time.js';
import { liveOf, rosterSorted, roundsSorted, bySeq, sessionLabel, isUnresolved, ncsFirst } from './model.js';

export const NETLOG_ADIF_PROGRAM = 'OE1EBG';
// No registered MIME type for ADIF; text/plain makes Safari save ".adi.txt".
export const NETLOG_ADIF_MIME = 'application/octet-stream';
export const NETLOG_CSV_MIME = 'text/csv;charset=utf-8';

// The modes a session can name, as ADIF MODE / SUBMODE (ADIF 3.1.7).
export const NET_MODES = {
  FM: ['FM', ''], SSB: ['SSB', ''], AM: ['AM', ''], CW: ['CW', ''],
  DMR: ['DIGITALVOICE', 'DMR'], DSTAR: ['DIGITALVOICE', 'DSTAR'], C4FM: ['DIGITALVOICE', 'C4FM'],
  M17: ['DIGITALVOICE', 'M17'], FREEDV: ['DIGITALVOICE', 'FREEDV'],
};

const EXPORT_CALL_RE = /\b([A-Z]{1,2}\d{1,4}[A-Z]{1,4})\b/i;
const EXPORT_MHZ_RE = /(?:^|[\s(])(\d{1,6}(?:[.,]\d{1,6})?)(?=\s*(?:mhz)?(?:$|[\s)]))/i;

// "OE1XUU 438.950", "3.650 MHz", "OE3XWU": the repeater call and the
// frequency (MHz) typed in the session's repeater/frequency field.
export function parseRadioText(text) {
  const s = String(text || '').trim();
  const call = (EXPORT_CALL_RE.exec(s) || [])[1];
  const rest = call ? s.replace(call, ' ') : s;
  const m = EXPORT_MHZ_RE.exec(rest);
  const mhz = m ? Number(m[1].replace(',', '.')) : null;
  return { call: call ? call.toUpperCase() : null, mhz: mhz && mhz >= 0.1 ? mhz : null };
}

// The frequency field: "145.500" / "3,650 MHz" (MHz) or a band ("2m",
// "70cm": an ADIF band name). { mhz, band }
export function parseFreqText(text) {
  const s = String(text || '').trim();
  const band = Object.keys(ADIF_SPEC_ENUMS.Band.ranges).find(b => b.toLowerCase() === s.toLowerCase());
  if (band) return { mhz: null, band };
  const { mhz } = parseRadioText(s.replace(EXPORT_CALL_RE, ' '));
  return { mhz, band: adifBand(mhz) };
}

// The radio facts of a session for ADIF: the repeater (optional), the
// frequency or band, the mode. Sessions from before the separate frequency
// field may have both in the repeater field ("OE1XUU 438.950", "3.650"):
// still read. repeaters: the offline repeater list (tools/shared/data/
// repeaters-at.json `repeaters`, optional): a repeater found there by its
// call (and output frequency, if typed) gives the input/output frequencies
// and its modes; via a repeater I transmit on its input.
// { repeater: call|null, txMHz, rxMHz, band, modes: [], fromList, mode: [MODE, SUBMODE]|null, modeFromList }
export function radioInfo(session, repeaters = null) {
  const radio = (session && session.radio) || {};
  const rpt = parseRadioText(radio.repeater);
  const call = rpt.call;
  const f = parseFreqText(radio.freq);
  const mhz = f.mhz ?? rpt.mhz;
  let hit = null;
  if (call && Array.isArray(repeaters)) {
    const same = repeaters.filter(r => r.call === call);
    hit = (mhz && same.find(r => Math.abs(r.out - mhz) < 0.0005)) || (same.length === 1 ? same[0] : null);
  }
  const info = {
    repeater: call, fromList: !!hit, modes: hit ? hit.modes || [] : [],
    // via a repeater I transmit on its input and listen on its output
    txMHz: hit ? hit.in : mhz, rxMHz: hit ? hit.out : mhz,
    band: hit ? adifBand(hit.in) : (f.band || adifBand(mhz)),
    mode: null, modeFromList: false,
  };
  if (NET_MODES[radio.mode]) info.mode = NET_MODES[radio.mode];
  else {
    const usable = info.modes.filter(m => NET_MODES[m]);
    if (usable.length === 1) { info.mode = NET_MODES[usable[0]]; info.modeFromList = true; }
  }
  return info;
}

// The ADIF band of a frequency (MHz), or ''.
export function adifBand(mhz) {
  if (mhz === null || mhz === undefined || !Number.isFinite(mhz)) return '';
  for (const [band, [lo, hi]] of Object.entries(ADIF_SPEC_ENUMS.Band.ranges)) if (mhz >= lo && mhz <= hi) return band;
  return '';
}

function exportMHz(v) {
  return String(Math.round(v * 1e6) / 1e6);
}

// GridSquare (2-8 characters) and GridSquareExt (9-12) of a locator, or null.
function exportGrid(raw) {
  const g = String(raw || '').trim();
  if (!isValidLocator(g)) return null;
  const f = formatLocator(g);
  return { grid: f.slice(0, 8), ext: f.slice(8, 12) };
}

const EXPORT_ADIF_CALL_RE = /^(?:[A-Z0-9]{1,4}\/)?[A-Z0-9]{1,3}\d[A-Z0-9]*[A-Z](?:\/[A-Z0-9]{1,4})?$/;
const exportIsOwn = (session, p) => !!(session.own && session.own.base && p.base === session.own.base);

// The first check-in of a station: its first presence interval.
function exportFirstCheckin(p) {
  const iv = (p.presence || []).find(x => x && x.from && x.from.iso);
  return iv ? iv.from : null;
}

// What keeps a station out of the ADIF file or makes the file less useful,
// for the dialog before the export. { skipped: [{ call, why }], problems: [key] }
// why/problem: translation keys (export.why.* / export.problem.*).
export function netAdifIssues({ session, participants }, repeaters = null) {
  const skipped = [];
  for (const p of rosterSorted(liveOf(participants))) {
    if (exportIsOwn(session, p)) continue;
    if (isUnresolved(p.call)) skipped.push({ call: p.call, why: 'partial' });
    else if (!exportFirstCheckin(p)) skipped.push({ call: p.call, why: 'noTime' });
    else if (!EXPORT_ADIF_CALL_RE.test(p.call)) skipped.push({ call: p.call, why: 'notCall' });
  }
  const info = radioInfo(session, repeaters);
  const problems = [];
  if (!info.mode) problems.push('noMode');
  if (!info.band && !adifBand(info.rxMHz)) problems.push('noBand');
  if (!(session.own && session.own.call && EXPORT_ADIF_CALL_RE.test(session.own.call))) problems.push('noOwn');
  return { skipped, problems, info };
}

// opts: { createdIso, programVersion, repeaters, series }
export function netAdif({ session, participants }, opts = {}) {
  const createdIso = opts.createdIso || new Date().toISOString();
  const info = radioInfo(session, opts.repeaters);
  const label = sessionLabel(session, opts.series || null) || 'Netlog';
  const ts = createdIso.replace(/[-:]/g, '').replace('T', ' ').slice(0, 15);
  let out = `Netlog: ${adifAscii(label)} ${session.date || ''}`.trim() + '\n';
  out += `<ADIF_VER:5>3.1.7 <PROGRAMID:${NETLOG_ADIF_PROGRAM.length}>${NETLOG_ADIF_PROGRAM} `;
  out += adifAsciiField('PROGRAMVERSION', opts.programVersion);
  out += `<CREATED_TIMESTAMP:15>${ts} <EOH>\n\n`;
  const own = session.own && EXPORT_ADIF_CALL_RE.test(session.own.call || '') ? session.own.call : '';
  const txBand = adifBand(info.txMHz);
  const rxBand = adifBand(info.rxMHz);
  for (const p of ncsFirst(rosterSorted(liveOf(participants)), session.ncsId)) {
    if (exportIsOwn(session, p) || isUnresolved(p.call) || !EXPORT_ADIF_CALL_RE.test(p.call)) continue;
    const at = exportFirstCheckin(p);
    if (!at) continue;
    const { date, time } = splitUtc(at.iso);
    const comment = [`Net ${label}`];
    if (session.ncsId === p.id) comment.push('NCS');
    if (at.quality === 'estimated') comment.push('check-in time estimated');
    let rec = '';
    rec += adifAsciiField('CALL', p.call);
    rec += adifAsciiField('QSO_DATE', date.replace(/-/g, ''));
    rec += adifAsciiField('TIME_ON', time.replace(/:/g, ''));
    rec += adifAsciiField('STATION_CALLSIGN', own);
    rec += adifAsciiField('OPERATOR', own);
    if (txBand) {
      rec += adifAsciiField('FREQ', exportMHz(info.txMHz));
      rec += adifAsciiField('BAND', txBand);
    } else if (info.band) {
      rec += adifAsciiField('BAND', info.band); // a band without a frequency ("2m")
    }
    if (rxBand && info.rxMHz !== info.txMHz) {
      rec += adifAsciiField('FREQ_RX', exportMHz(info.rxMHz));
      rec += adifAsciiField('BAND_RX', rxBand);
    }
    if (info.mode) {
      rec += adifAsciiField('MODE', info.mode[0]);
      rec += adifAsciiField('SUBMODE', info.mode[1]);
    }
    if (info.repeater) {
      rec += adifAsciiField('PROP_MODE', 'RPT');
      rec += adifAsciiField(`APP_${NETLOG_ADIF_PROGRAM}_REPEATER`, info.repeater);
    }
    rec += adifAsciiField('NAME', p.name);
    rec += adifAsciiField('QTH', p.qth);
    const grid = exportGrid(p.locator);
    if (grid) {
      rec += adifAsciiField('GRIDSQUARE', grid.grid);
      rec += adifAsciiField('GRIDSQUARE_EXT', grid.ext);
    } else if (p.locator) comment.push(`locator ${p.locator}`);
    rec += adifAsciiField(`APP_${NETLOG_ADIF_PROGRAM}_NET`, label);
    rec += adifAsciiField('COMMENT', comment.join('; '));
    out += rec + '<EOR>\n';
  }
  return out;
}

// ---------- CSV ----------

function exportUtcCells(time) {
  if (!time || !time.iso) return ['', '', ''];
  const { date, time: hms } = splitUtc(time.iso);
  return [date, hms, time.quality === 'estimated' ? 'estimated' : 'exact'];
}

// One row per station. t: the translation function (column titles and
// values in the current language).
export function stationsCsv({ session, participants, contributions, notes }, t, sep = ';') {
  const turns = new Map();
  for (const c of liveOf(contributions)) turns.set(c.participantId, (turns.get(c.participantId) || 0) + 1);
  const noteN = new Map();
  for (const n of liveOf(notes)) noteN.set(n.participantId, (noteN.get(n.participantId) || 0) + 1);
  const head = ['call', 'name', 'qth', 'locator', 'status', 'role', 'checkinDate', 'checkinTime', 'checkinQuality', 'checkoutDate', 'checkoutTime', 'turns', 'notes']
    .map(k => t(`export.col.${k}`));
  const rows = ncsFirst(rosterSorted(liveOf(participants)), session.ncsId).map(p => {
    const first = exportFirstCheckin(p);
    const ivs = p.presence || [];
    const last = ivs.length ? ivs[ivs.length - 1].to : null;
    const role = [session.ncsId === p.id ? t('export.role.ncs') : '', exportIsOwn(session, p) ? t('export.role.me') : ''].filter(Boolean).join(', ');
    const [od, ot] = exportUtcCells(last);
    return [p.call, p.name, p.qth, p.locator, t(`status.${p.status}`), role, ...exportUtcCells(first).map((v, i) => (i === 2 && v ? t(`export.quality.${v}`) : v)), od, ot, turns.get(p.id) || 0, noteN.get(p.id) || 0];
  });
  return '﻿' + csvSafeRows([head, ...rows], sep) + '\r\n';
}

// One row per live note, in recorded order, with its round, station,
// response and task.
export function notesCsv({ participants, rounds, notes, items }, t, sep = ';') {
  const pById = new Map(participants.map(p => [p.id, p]));
  const rById = new Map(rounds.map(r => [r.id, r]));
  const byNote = new Map();
  for (const i of liveOf(items)) {
    if (!i.noteId || i.active === false) continue;
    const e = byNote.get(i.noteId) || {};
    e[i.kind] = i;
    byNote.set(i.noteId, e);
  }
  const state = i => (i ? t(i.state === 'done' ? 'export.state.done' : 'export.state.open') : '');
  const head = ['date', 'time', 'timeQuality', 'round', 'call', 'name', 'note', 'response', 'reply', 'task']
    .map(k => t(`export.col.${k}`));
  const rows = [...liveOf(notes)].sort(bySeq).map(n => {
    const p = pById.get(n.participantId) || {};
    const r = rById.get(n.roundId);
    const it = byNote.get(n.id) || {};
    const [d, tm, q] = exportUtcCells(n.time);
    return [d, tm, q ? t(`export.quality.${q}`) : '', r ? r.number : '', p.call || '', p.name || '', n.text,
      state(it.response), it.response ? it.response.text || '' : '', state(it.task)];
  });
  return '﻿' + csvSafeRows([head, ...rows], sep) + '\r\n';
}

// ---------- the printed report ----------

// The report's content: rounds (oldest first), each with its notes grouped
// by station in recorded order. { stations, rounds: [{ number, topic, groups: [{ p, notes }] }] }
export function reportData({ session, participants, rounds, notes }) {
  const live = liveOf(notes).sort(bySeq);
  const pById = new Map(participants.map(p => [p.id, p]));
  const out = [];
  for (const r of roundsSorted(rounds)) {
    const groups = new Map();
    for (const n of live) {
      if (n.roundId !== r.id) continue;
      if (!groups.has(n.participantId)) groups.set(n.participantId, { p: pById.get(n.participantId) || null, notes: [] });
      groups.get(n.participantId).notes.push(n);
    }
    out.push({ number: r.number, topic: r.topic || '', groups: [...groups.values()] });
  }
  return { stations: ncsFirst(rosterSorted(liveOf(participants)), session.ncsId), rounds: out };
}

// "wiener-runde-12": a label as a file name part (ASCII, lower case, at most 60 characters).
export function exportSlug(label) {
  return String(label || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'netlog';
}

// "2026-10-16_wiener-runde-12": the file name base of a session's exports.
export function exportBase(session, series) {
  return `${session.date || 'session'}_${exportSlug(sessionLabel(session, series) || 'netlog')}`;
}
