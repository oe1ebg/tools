// The series statistics (#83) as CSV: one row per station and session, from seriesStatistics().
// Pure (no DOM, no storage), unit-tested in tests/netlog-statsexport.test.mjs. The CSV follows
// the other Netlog CSVs (export.js): ';' as separator, quoted cells, a BOM, CR LF line ends,
// cells that a spreadsheet would read as a formula get a leading ' (csvSafeRows), the column
// titles and the words in the cells (yes / no, exact / estimated / unknown) in the interface
// language.
//
// Rows: sessions oldest first, in a session the stations in roster order. Every live participant
// with a resolved callsign has a row, also one that did not attend (attended = no). Participants
// with an incomplete callsign ("OE1?", "*") are not in the file (the PDF and the page count them).
//
// Columns (titles: export.col.s*):
//   series, session date (ISO), session number, session start (UTC, ISO 8601 with Z; empty when
//   unknown), callsign, name, attended (yes/no),
//   time present (hh:mm:ss), its quality, intervals without time,
//   check-in (UTC, ISO 8601 with Z), check-in offset to the session start (hh:mm:ss), its quality,
//   net control (yes/no), net control time (hh:mm:ss), its quality, turns, notes,
//   speaking time ESTIMATE (hh:mm:ss, an upper bound, see below), its quality, turns without time
//
// Durations are hh:mm:ss (hours not limited, seconds floored). An unknown value is an EMPTY cell,
// never 0. The quality is exact, estimated (built from an estimated time, or a lower bound
// because intervals or turns without a time are missing: see the "without time" columns) or
// unknown (empty value). The speaking time is always an estimate and an upper bound: a turn lasts
// until the next one starts, pauses are included; turns without exact times are counted in the
// last column, not in the sum.

import { csvSafeRows } from '../../shared/js/csv.js';
import { exportSlug } from './export.js';

const STX_COLS = ['series', 'date', 'number', 'start', 'call', 'name', 'attended',
  'present', 'presentQ', 'presentLeft', 'checkin', 'offset', 'offsetQ',
  'ncs', 'ncsTime', 'ncsQ', 'turns', 'notes', 'speaking', 'speakingQ', 'speakingLeft'];

const stxPad = n => String(n).padStart(2, '0');

// hh:mm:ss of a duration in ms ('' for none)
export function stxDuration(ms) {
  if (ms == null || !(ms >= 0)) return '';
  const s = Math.floor(ms / 1000);
  return `${stxPad(Math.floor(s / 3600))}:${stxPad(Math.floor(s / 60) % 60)}:${stxPad(s % 60)}`;
}

// an instant as ISO 8601 UTC with Z ('' for none): "2026-09-02T18:00:00Z"
export function stxInstant(iso) {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString().replace('.000Z', 'Z');
}

// 'exact' | 'estimated' | 'unknown' of a Qty
export const stxQuality = q => (!q || q.ms == null ? 'unknown' : q.leftOut > 0 || q.quality === 'estimated' ? 'estimated' : 'exact');

// t: the translation function (titles and words in the current language)
export function seriesStatsCsv(stats, seriesName, t, sep = ';') {
  const yes = v => t(v ? 'export.yes' : 'export.no');
  const qual = q => t(`export.quality.${stxQuality(q)}`);
  const left = q => (q && (q.ms != null || q.leftOut > 0) ? q.leftOut : '');
  const rows = [STX_COLS.map(k => t(`export.col.s${k}`))];
  for (const s of stats.sessions) {
    for (const r of s.stations) {
      rows.push([
        seriesName, s.date, s.number ?? '', stxInstant(s.start.iso), r.call, r.name, yes(r.attended),
        stxDuration(r.timePresent.ms), qual(r.timePresent), left(r.timePresent),
        stxInstant(r.firstCheckin.iso), stxDuration(r.checkinOffset.ms), qual(r.checkinOffset),
        yes(r.ncs), stxDuration(r.ncsTime.ms), qual(r.ncsTime), r.turns, r.notes,
        stxDuration(r.speaking.ms), qual(r.speaking), left(r.speaking),
      ]);
    }
  }
  return '﻿' + csvSafeRows(rows, sep) + '\r\n';
}

// "2026-10-31_abendrunde": the file name base of the statistics files (date: ISO, UTC)
export function seriesStatsBase(seriesName, dateIso) {
  return `${dateIso}_${exportSlug(seriesName)}`;
}
