// The Meldebuch of a time range as a PDF: the rows of bookSheet() (print.js)
// as an A4 landscape table, in the columns of the book on screen: Nr. · Zeit
// (with the Meldesammelstelle's reference and the message a reply answers),
// Gegenstelle (with the direction), Betreff · Inhalt (with the type and
// urgency; the FULL text, wrapped, never truncated) and Status. A row that
// does not fit the rest of a page continues on the next one (its number is
// repeated there); every page has the header (title, Einsatz, station, time
// range, print time), the column heads and "Seite n von N". Black thin lines
// on white, 9-10 pt: readable at arm's length. Written with the shared PDF
// writer; the arrows of the direction are drawn as shapes (not in WinAnsi).

import { bookSheet } from './print.js';
import { PDF_A4_LANDSCAPE, pdfCanvas, pdfDocument, pdfWrap, pdfTextWidth, pdfFooterUrl } from '../../shared/js/pdf.js';

export const NBP_PAGE = PDF_A4_LANDSCAPE;
const NBP_MARGIN = 10;
const NBP_PITCH = 4.6; // mm per text line
const NBP_PAD = 1.4; // mm above and below a row's text
const NBP_PADX = 1.8; // mm inside a column
const NBP_COLS = [
  { w: 34, head: 'Nr. · Zeit' },
  { w: 52, head: 'Gegenstelle' },
  { w: 141, head: 'Betreff · Inhalt' },
  { w: 50, head: 'Status' },
];
const NBP_HEAD_Y = 35; // mm: top of the column heads
const NBP_BODY_TOP = NBP_HEAD_Y + 7;
const NBP_BODY_BOTTOM = NBP_PAGE.height - NBP_MARGIN - 6;
const NBP_SHORT_ROW = 10; // lines: a shorter row moves to the next page rather than splitting
// Dringlichkeit in the colours of the screen: Notfall red with white text
// (and the row tinted), Dringend amber; the word says it in black and white too.
const NBP_EMERGENCY = 'Notfall';
const NBP_PRIO = {
  Notfall: { fill: [0.776, 0.157, 0.157], text: [1, 1, 1] },
  Dringend: { fill: [0.996, 0.925, 0.8], text: [0.561, 0.373, 0], frame: [0.561, 0.373, 0] },
};
const NBP_ROW_TINT = [0.988, 0.918, 0.918];
const NBP_FRAME = { Notfall: 2.4, Dringend: 1.2 }; // pt

// A line of a cell: { t, bold, size, gray, arrow: 'in' | 'out' (drawn before the text) }
const nbpLine = (t, o = {}) => ({ t, ...o });
const nbpWrap = (text, col, size, o = {}) => pdfWrap(text, NBP_COLS[col].w - 2 * NBP_PADX, size, !!o.bold).map(t => nbpLine(t, { size, ...o }));

// The cells of a row: an array of lines per column.
function nbpCells(r) {
  const nr = [nbpLine(r.number, { bold: true, size: 10 }), nbpLine(r.date, { size: 8.5 }), nbpLine(r.time, { size: 8.5 })];
  if (r.staffRef) nr.push(...nbpWrap(r.staffRef, 0, 8.5));
  if (r.reply) nr.push(...nbpWrap(`Bezug ${r.reply}`, 0, 8.5));
  const peer = [nbpLine(r.inbound ? 'Eingang von' : 'Ausgang an', { size: 7.5, gray: 0.2, arrow: r.inbound ? 'in' : 'out' }),
    ...nbpWrap(r.party || '–', 1, 9.5, { bold: true })];
  if (r.own) peer.push(...nbpWrap(`${r.inbound ? 'an' : 'von'} ${r.own}`, 1, 8.5, { gray: 0.2 }));
  // the type; Dringend / Notfall as a coloured label after it (as on screen)
  const content = [nbpLine((r.type || '').toUpperCase(), { size: 7.5, bold: true, gray: 0.2, prio: r.priority || '' })];
  if (r.subject) content.push(...nbpWrap(r.subject, 2, 10, { bold: true }));
  if (r.text) content.push(...nbpWrap(r.text, 2, 9.5));
  const status = [...nbpWrap(r.status, 3, 9.5, { bold: true })];
  if (r.statusAt) status.push(nbpLine(r.statusAt, { size: 8.5 }));
  if (r.statusBy) status.push(...nbpWrap(r.statusBy, 3, 8.5));
  return [nr, peer, content, status];
}

// Rows onto pages: [[{ cells, cont }]], splitting rows that do not fit.
function nbpLayout(rows) {
  const pages = [[]];
  let used = 0; // mm of the current page
  const height = lines => lines * NBP_PITCH + 2 * NBP_PAD;
  const room = () => Math.floor((NBP_BODY_BOTTOM - NBP_BODY_TOP - used - 2 * NBP_PAD) / NBP_PITCH);
  const next = () => { pages.push([]); used = 0; };
  for (const r of rows) {
    let cells = nbpCells(r);
    let cont = false;
    const urgent = r.priority === NBP_EMERGENCY;
    const prio = r.priority || '';
    for (;;) {
      const lines = Math.max(...cells.map(c => c.length));
      const fit = room();
      if (lines <= fit) {
        pages.at(-1).push({ cells, cont, urgent, prio });
        used += height(lines);
        break;
      }
      // not here: a short row moves on, a long one is split (never fewer than 3 lines)
      if (pages.at(-1).length && (lines <= NBP_SHORT_ROW || fit < 3)) { next(); continue; }
      const head = cells.map(c => c.slice(0, fit));
      pages.at(-1).push({ cells: head, cont, urgent, prio });
      used += height(fit);
      const rest = cells.map(c => c.slice(fit));
      cells = [[nbpLine(r.number, { bold: true, size: 10 }), nbpLine('Fortsetzung', { size: 8.5, gray: 0.2 }), ...rest[0]], rest[1], rest[2], rest[3]];
      cont = true;
      next();
    }
  }
  return pages;
}

function nbpArrow(cv, x, y, inbound) {
  // an arrow of 3.2 mm: Eingang down, Ausgang up
  const top = y - 3, bot = y + 0.2, tip = inbound ? bot : top, back = inbound ? bot - 1.4 : top + 1.4;
  cv.line(x, top, x, bot, { width: 0.9 });
  cv.line(x, tip, x - 1.2, back, { width: 0.9 });
  cv.line(x, tip, x + 1.2, back, { width: 0.9 });
}

// "Label value · Label value …": the labels gray, the values black.
function nbpFields(cv, fields, x, base, width) {
  const size = 9;
  let at = x;
  fields.forEach(([label, value], i) => {
    const sep = i ? ' · ' : '';
    const lab = `${sep}${label} `;
    const need = pdfTextWidth(lab, size) + pdfTextWidth(value, size, true);
    if (at + need > x + width) return; // (never on an A4 landscape page with real values)
    cv.text(lab, at, base, { size, gray: 0.35 });
    at += pdfTextWidth(lab, size);
    cv.text(value, at, base, { size, bold: true });
    at += pdfTextWidth(value, size, true);
  });
}

// A Dringlichkeit label at the baseline: a filled box with the word.
function nbpPrio(cv, prio, x, base) {
  const c = NBP_PRIO[prio];
  if (!c) return;
  const word = prio.toUpperCase(), size = 7.5;
  const w = pdfTextWidth(word, size, true) + 2.4, h = 3.6;
  cv.fill(x, base - 2.85, w, h, c.fill);
  if (c.frame) cv.rect(x, base - 2.85, w, h, { width: 0.4, gray: 0.35 });
  cv.text(word, x + 1.2, base, { size, bold: true, color: c.text });
}

function nbpPage(b, rows, n, total) {
  const cv = pdfCanvas(NBP_PAGE);
  const x0 = NBP_MARGIN, x1 = NBP_PAGE.width - NBP_MARGIN;
  cv.text('Notfunk-Meldebuch', x0, NBP_MARGIN + 5, { size: 15, bold: true });
  cv.text(`gedruckt ${b.printed}`, x1, NBP_MARGIN + 5, { size: 9, align: 'right' });
  cv.text(b.title || 'Einsatz', x0, NBP_MARGIN + 11, { size: 10.5, bold: true });
  // every field of the Einsatz header, labelled (one line; shortened only
  // if the page cannot hold it)
  nbpFields(cv, b.einsatz || [], x0, NBP_MARGIN + 16.5, x1 - x0);
  cv.text(`Zeitraum: ${b.range}`, x0, NBP_MARGIN + 21.5, { size: 9.5 });
  cv.text('Zeiten in Ortszeit Wien', x1, NBP_MARGIN + 21.5, { size: 9, align: 'right' });
  cv.line(x0, NBP_MARGIN + 24.5, x1, NBP_MARGIN + 24.5, { width: 1.5 });
  // column heads (repeated on every page)
  let x = x0;
  const xs = NBP_COLS.map(c => { const at = x; x += c.w; return at; });
  NBP_COLS.forEach((c, i) => cv.text(c.head.toUpperCase(), xs[i] + NBP_PADX, NBP_HEAD_Y + 4.6, { size: 7.5, bold: true }));
  cv.line(x0, NBP_BODY_TOP - 0.6, x1, NBP_BODY_TOP - 0.6, { width: 1 });
  let y = NBP_BODY_TOP;
  if (!rows.length) cv.text('Keine Meldungen in diesem Zeitraum.', x0 + NBP_PADX, y + 7, { size: 10.5 });
  for (const row of rows) {
    const lines = Math.max(...row.cells.map(c => c.length));
    if (row.urgent) cv.fill(x0, y, x1 - x0, lines * NBP_PITCH + 2 * NBP_PAD, NBP_ROW_TINT);
    row.cells.forEach((lns, i) => lns.forEach((l, k) => {
      const base = y + NBP_PAD + NBP_PITCH * (k + 0.78);
      let tx = xs[i] + NBP_PADX;
      if (l.arrow) { nbpArrow(cv, tx + 1.2, base, l.arrow === 'in'); tx += 4; }
      cv.text(l.t, tx, base, { size: l.size || 9.5, bold: !!l.bold, gray: l.gray || 0 });
      if (l.prio) nbpPrio(cv, l.prio, tx + pdfTextWidth(l.t, l.size || 9.5, !!l.bold) + (l.t ? 2 : 0), base);
    }));
    // a priority row framed, so it shows without colour too (black and
    // white printers): Notfall thick, Dringend medium
    const frame = NBP_FRAME[row.prio];
    if (frame) cv.rect(x0 + frame / 2 / 2.835, y + frame / 2 / 2.835, x1 - x0 - frame / 2.835, lines * NBP_PITCH + 2 * NBP_PAD - frame / 2.835, { width: frame });
    y += lines * NBP_PITCH + 2 * NBP_PAD;
    cv.line(x0, y, x1, y, { width: 0.4 });
  }
  cv.text(`Notfunk-Meldebuch${b.title ? ` · ${b.title}` : ''}`, x0, NBP_PAGE.height - NBP_MARGIN + 0.5, { size: 8, gray: 0.2 });
  cv.text(`Seite ${n} von ${total}`, x1, NBP_PAGE.height - NBP_MARGIN + 0.5, { size: 9, align: 'right' });
  pdfFooterUrl(cv, x0, NBP_PAGE.height - NBP_MARGIN + 4);
  return cv.ops.join('\n');
}

// -> the book as PDF bytes (Uint8Array). Arguments as bookSheet().
export function bookPdf(msgs, op, opts) {
  const b = bookSheet(msgs, op, opts);
  const pages = nbpLayout(b.rows);
  return pdfDocument(NBP_PAGE, pages.map((rows, i) => nbpPage(b, rows, i + 1, pages.length)),
    `Notfunk-Meldebuch${b.title ? ` – ${b.title}` : ''}`);
}
