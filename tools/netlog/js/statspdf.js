// The series statistics sheet as PDF (#83): A4 portrait, white, thin lines, the shared writer and
// the page flow of the roster PDF (netpdf.js). The content comes from statspdfmodel.js; this
// module only lays it out: text wraps inside its cell, long tables continue on further pages
// (their head repeated), the attendance matrix is split into blocks of sessions that fit the page
// width. Nothing is cut off.
//
//   statsPdf(model) -> Uint8Array (the PDF file)

import { t } from './i18n.js';
import { NPDF_W, npdfFlow, npdfNote } from './netpdf.js';

const SPD_STATION_W = 42; // mm: the station column of the matrix
const SPD_CELL_W = 23; // mm: one session in the matrix

// A table from a head and rows. cols: [{ w, bold, size, gray }] for the columns (the widths add up
// to the page width); a cell is a string or an array of lines. The head repeats on a new page.
function spdTable(f, title, cols, head, rows, { note = '' } = {}) {
  let x = 0;
  const at = cols.map(c => { const r = { ...c, x }; x += c.w; return r; });
  const cells = (row, opts = {}) => at.map((c, k) => ({
    x: c.x, w: c.w,
    lines: [].concat(row[k] ?? '').map(txt => npdfNote(txt, { size: c.size || 9, bold: !!c.bold, gray: c.gray || 0, ...opts })),
  }));
  const headCols = cells(head, { bold: true, size: 8, gray: 0.3 });
  const start = (more) => {
    f.bar(title, more ? t('pdf.continued') : note);
    f.row(headCols);
  };
  // the bar, the head and the first row stay together
  f.need(f.heightOf(headCols) + (rows.length ? f.heightOf(cells(rows[0])) : 0) + 10);
  start(false);
  for (const row of rows) {
    const c = cells(row);
    if (!f.fits(f.heightOf(c))) { f.breakPage(); start(true); }
    f.row(c);
  }
  f.skip(3);
}

// the attendance matrix, in blocks of as many sessions as fit the width
function spdMatrix(f, m) {
  const per = Math.max(1, Math.floor((NPDF_W - SPD_STATION_W) / SPD_CELL_W));
  const blocks = Math.ceil(m.sessions.length / per);
  f.need(30);
  f.row([{ x: 0, w: NPDF_W, lines: [npdfNote(m.legend, { size: 8.5, gray: 0.3 })] }], { rule: false });
  for (let b = 0; b < blocks; b++) {
    const from = b * per, to = Math.min(m.sessions.length, from + per);
    const range = blocks > 1 ? t('stats.pdf.part', { from: from + 1, to, total: m.sessions.length }) : '';
    const bar = range ? `${m.title} (${range})` : m.title;
    const column = (k, lines, o = {}) => ({ x: k < 0 ? 0 : SPD_STATION_W + k * SPD_CELL_W, w: k < 0 ? SPD_STATION_W : SPD_CELL_W, lines: lines.map(l => npdfNote(l, o)) });
    const head = [column(-1, [m.stationHead], { bold: true, size: 8, gray: 0.3 }),
      ...m.sessions.slice(from, to).map((s, k) => column(k, [s.date, s.number].filter(Boolean), { bold: true, size: 8, gray: 0.3 }))];
    // the station's call in bold, its name small
    const body = m.rows.map(r => [
      column(-1, [r.call]),
      ...r.cells.slice(from, to).map((c, k) => column(k, c.lines, { size: 8.5, gray: c.attended ? 0 : 0.45 })),
    ]);
    body.forEach((cols, i) => {
      cols[0].lines = [npdfNote(m.rows[i].call, { bold: true, size: 9.5 }), ...(m.rows[i].name ? [npdfNote(m.rows[i].name, { size: 8, gray: 0.35 })] : [])];
    });
    f.need(f.heightOf(head) + (body.length ? f.heightOf(body[0]) : 0) + 10);
    const start = more => { f.bar(bar, more ? t('pdf.continued') : ''); f.row(head); };
    start(false);
    for (const cols of body) {
      if (!f.fits(f.heightOf(cols))) { f.breakPage(); start(true); }
      f.row(cols);
    }
    f.skip(3);
  }
}

export function statsPdf(model) {
  const f = npdfFlow(model.title, model.sub, model.generatedIso, model.generated);
  // the series, and the estimate note first: it applies to every speaking time on the sheet
  f.row([{ x: 0, w: NPDF_W, lines: [npdfNote(model.seriesName || '-', { bold: true, size: 12 })] }], { rule: false });
  f.row([
    { x: 0, w: 22, lines: [npdfNote(model.estimate.title, { bold: true, size: 9 })] },
    { x: 22, w: NPDF_W - 22, lines: [npdfNote(model.estimate.text, { size: 9 })] },
  ], { rule: false });
  f.skip(2);
  f.bar(model.summary.title);
  if (model.empty) {
    f.row([{ x: 0, w: NPDF_W, lines: [npdfNote(model.empty, { gray: 0.35 })] }], { rule: false });
    return f.finish(model.docTitle);
  }
  for (const item of model.summary.items) f.row([{ x: 0, w: 4, lines: [npdfNote('-')] }, { x: 4, w: NPDF_W - 4, lines: [npdfNote(item)] }], { rule: false });
  f.skip(3);
  if (model.leaderboard) {
    spdTable(f, model.leaderboard.title, [{ w: 11, gray: 0.3 }, { w: 47, bold: true }, { w: 22 }, { w: 28 }, { w: 28 }, { w: 24 }, { w: 20 }], model.leaderboard.head, model.leaderboard.rows);
  }
  if (model.matrix) spdMatrix(f, model.matrix);
  spdTable(f, model.sessions.title, [{ w: 22 }, { w: 28 }, { w: 44 }, { w: 44 }, { w: 18 }, { w: 24 }], model.sessions.head, model.sessions.rows, { note: model.sessions.zoneNote });
  spdTable(f, model.rotation.title, [{ w: 22 }, { w: 14 }, { w: NPDF_W - 36 }], model.rotation.head, model.rotation.rows, { note: model.rotation.zoneNote });
  return f.finish(model.docTitle);
}
