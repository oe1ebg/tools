// The content of the series statistics sheet (PDF, #83) as plain data, without drawing: texts in
// the interface language, the numbers from seriesStatistics() through statsmodel.js. Pure and
// unit-tested (tests/netlog-statspdf.test.mjs); statspdf.js lays it out on A4 pages.
//
// The PDF's font is WinAnsi: the screen's marks are written as ASCII (≈ -> "~", ≥ -> ">=",
// ✓ -> "+"), and the legends are converted the same way, so the texts agree with the marks.
// No personal data beyond what the roster PDF shows (callsign, name).
//
// statsPdfModel(stats, { seriesName, generatedIso }) ->
//   { title, sub, generated, generatedIso, seriesName, docTitle, empty: string|null, estimate: { title, text },
//     summary: { title, items: [string] },
//     leaderboard: null | { title, head: [string], rows: [[cell]] },
//     matrix: null | { title, legend, stationHead, sessions: [{ date, number }],
//                      rows: [{ call, name, cells: [{ attended, lines: [string] }] }] },
//     sessions: { title, zoneNote, head, rows }, rotation: { title, zoneNote, head, rows } }
//   cell: a string, or an array of lines (a table cell is wrapped by the drawing)
//   empty: the text for a series without sessions (all other blocks are then null / empty)

import { t } from './i18n.js';
import { zone } from './clock.js';
import { smSummary, smLeaderboard, smMatrix, smSessions, smRotation } from './statsmodel.js';

export const spmAscii = s => String(s ?? '').replace(/≈/g, '~').replace(/≥/g, '>=').replace(/✓/g, '+').replace(/[ \t]+/g, ' ').trim();

// "2026-10-31 12:00 UTC": the instant the sheet was made, always UTC
export function spmStamp(iso) {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

const spmQty = q => spmAscii(q.note ? `${q.text} ${q.note}` : q.text);

export function statsPdfModel(stats, { seriesName, generatedIso }) {
  const name = String(seriesName || '');
  const generated = t('stats.pdf.generated', { stamp: spmStamp(generatedIso) });
  const head = {
    title: `Netlog · ${t('stats.title')}`,
    sub: `${t('stats.sessions', { n: stats.sessionCount })} · ${generated}`,
    generated, generatedIso, seriesName: name,
    docTitle: `Netlog - ${t('stats.title')} - ${name}`,
    estimate: { title: t('stats.estimateTitle'), text: spmAscii(t('stats.estimateNote')) },
  };
  if (!stats.sessionCount) {
    return { ...head, empty: t('stats.empty'), summary: { title: t('stats.pdf.summary'), items: [] }, leaderboard: null, matrix: null, sessions: null, rotation: null };
  }
  const sm = smSummary(stats);
  const sum = key => stats.sessions.reduce((n, s) => n + (s.totals[key].leftOut || 0), 0);
  const leftPresent = sum('timePresent'), leftSpeaking = sum('speaking');
  const items = [
    t('stats.sessions', { n: sm.sessions }),
    t('stats.stations', { n: sm.stations }),
    t('stats.unknownTimes', { n: sm.unknownTimes }),
    t('stats.excluded', { n: sm.excluded }),
    sm.withoutStart ? t('stats.pdf.withoutStart', { n: sm.withoutStart }) : '',
    sm.withoutEnd ? t('stats.pdf.withoutEnd', { n: sm.withoutEnd }) : '',
    leftPresent ? t('stats.pdf.leftPresent', { n: leftPresent }) : '',
    leftSpeaking ? t('stats.pdf.leftSpeaking', { n: leftSpeaking }) : '',
  ].filter(Boolean);

  const lb = smLeaderboard(stats);
  const m = smMatrix(stats);
  const zoneNote = t('pdf.times', { zone: zone() });
  return {
    ...head, empty: null,
    summary: { title: t('stats.pdf.summary'), items },
    leaderboard: lb.length ? {
      title: t('stats.lbTitle'),
      head: [t('stats.rank'), t('stats.station'), t('stats.attended'), t('stats.timePresent'), t('stats.speaking'), t('stats.ncsSessions'), t('stats.lastSeen')],
      rows: lb.map(r => [String(r.rank), [r.call, r.name].filter(Boolean), r.attendedText, spmQty(r.timePresent), spmQty(r.speaking), String(r.ncsSessions), r.lastSeen]),
    } : null,
    matrix: lb.length ? {
      title: t('stats.matrixTitle'),
      legend: spmAscii(t('stats.matrixLegend')),
      stationHead: t('stats.station'),
      sessions: m.sessions.map(s => ({ date: s.date, number: s.number })),
      rows: m.rows.map(r => ({
        call: r.call, name: r.name,
        cells: r.cells.map(c => ({
          attended: c.attended,
          // a mark in text (+ present, - absent), the time, "NCS" for net control, the left-out count
          lines: [spmAscii(c.text), c.ncs ? 'NCS' : '', spmAscii(c.note)].filter(Boolean),
        })),
      })),
    } : null,
    sessions: {
      title: t('stats.sessionsTitle'), zoneNote,
      head: [t('stats.date'), t('stats.session'), t('stats.length'), t('stats.rounds'), t('stats.present'), t('stats.ncs')],
      rows: smSessions(stats).map(r => [
        r.date, [r.number, r.name].filter(Boolean).join(' ') || '-',
        [r.span, spmQty(r.length)].filter(Boolean).map(spmAscii),
        r.rounds.length ? r.rounds.map(x => `${t('stats.roundN', { n: x.number ?? '?' })}: ${spmQty(x.duration)}`) : [t('stats.noRounds')],
        String(r.present), r.ncs.length ? r.ncs : ['-'],
      ]),
    },
    rotation: {
      title: t('stats.rotationTitle'), zoneNote,
      head: [t('stats.date'), t('stats.session'), t('stats.ncs')],
      rows: smRotation(stats).map(r => [
        r.date, r.number || '-',
        r.holders.length
          ? r.holders.map(h => spmAscii(`${h.call}${h.name ? ` ${h.name}` : ''} ${h.from || h.to ? `${h.from || '?'}-${h.to || '?'} ${h.zone} ·` : ''} ${spmQty(h.duration)}`))
          : ['-'],
      ]),
    },
  };
}
