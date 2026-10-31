// The Meldeaufnahmeformular as PDFs: the empty one ("Vordruck", to print a
// stack of for working without a device: nothing is filled in but the
// Einsatz's name in the title line, the rest is written by hand) and the
// filled one of a message (the printout), both from ONE drawing function
// that takes the sheet data of print.js (blankFormSheet() / formSheet()).
// One portrait A4 page of the ÖBFV E-31 form's fields; a text that does not
// fit the Inhalt area continues on further pages (header: Notfunk-Nr.,
// Betreff, "Fortsetzung, Seite n von N"), and values too long for their
// single-line cell are shortened with "…" there and given in full on the
// last page. Text never leaves its cell.
//
// A PDF and not the page printed by the browser: every browser's print
// engine scales and pads differently (WebKit prints 1 CSS px as 0.8 pt);
// a PDF prints the same at its own size everywhere. Written with the
// shared PDF writer (../../shared/js/pdf.js). White paper, black thin
// lines, no filled areas. Writing lines are 9 mm and more apart, tick
// boxes and circles 4.4 mm and more: made for a pen on a clipboard.
// A circle = choose exactly one (Übermittlung, Dringlichkeit,
// Meldungsart), a square = an extra mark (Eingang / Ausgang, Rücklesen).
//
// The words (options, headings of the handover row, the footer) come from
// the sheet and model.js; only the captions of the fields are written here
// (NFP_CAPTIONS).

import { blankFormSheet, formSheet } from './print.js';
import { PDF_A4_PORTRAIT, pdfCanvas, pdfDocument, pdfTextWidth, pdfWrap, pdfFooterUrl } from '../../shared/js/pdf.js';

export const NFP_PAGE = PDF_A4_PORTRAIT;
const NFP_MARGIN = 10;
const NFP_LINE = 0.8; // pt: frames
const NFP_WRITE = 0.5; // pt: lines to write on
const NFP_PITCH = 10; // mm: the least distance between the ruled lines of the empty form's text
const NFP_TICK = 4.8; // mm: square to tick
const NFP_CIRCLE_R = 2.3; // mm: radius of the choice circles (4.6 mm across)

const NFP_CAPTIONS = {
  org: 'ÖVSV Notfunk',
  title: 'Meldeaufnahmeformular',
  number: 'Notfunk-Nr.',
  staff: 'Nur von der Meldesammelstelle auszufüllen',
  staffFields: ['Referenz / Geschäftsbuch-Nr.', 'Federführend', 'Mitwirkend', 'Zur Kenntnis'],
  date: 'Datum', time: 'Uhrzeit',
  channel: 'Übermittlung', priority: 'Dringlichkeit', type: 'Meldungsart',
  from: 'Von (Absender)', to: 'An (Adressat)', peer: 'Funkstelle', distribution: 'Verteiler',
  subject: 'Betreff', place: 'Ort', ref: 'Bezug',
  text: 'Inhalt – wörtlich, wie übermittelt',
  operator: 'Aufgenommen von (Name / Unterschrift)', station: 'an Station',
  remarks: 'Anmerkungen / weitere Veranlassung',
};

// Tiles of a choice, wrapped to `width` mm: [{ option, x, y, w }] (x, y
// relative to the top left) and the height used. The chosen option is bold.
const NFP_TILE_H = 6.4;
const NFP_OPTION_GAP = 5.5; // mm between the options of a line
const NFP_BOX_H = 7.5; // mm: an option's field on the empty form
const NFP_TILE_GAP = 1.6;
function nfpTiles(options, width) {
  const tiles = [];
  let x = 0, y = 0;
  for (const option of options) {
    // a circle and the word, no frame (calm); wide gaps between options
    const w = NFP_CIRCLE_R * 2 + 1.8 + pdfTextWidth(option.label, 9.5, !!option.checked);
    if (x && x + w > width) { x = 0; y += NFP_TILE_H + NFP_TILE_GAP; }
    tiles.push({ option, x, y, w });
    x += w + NFP_OPTION_GAP;
  }
  return { tiles, height: y + NFP_TILE_H };
}

// A single-line value for a cell `width` mm wide: the largest of `sizes`
// (pt) it fits at, else shortened with "…" at the smallest. -> { text, size, cut }
function nfpFit(text, width, sizes, bold = false) {
  const str = String(text ?? '').replace(/\s+/g, ' ').trim();
  for (const size of sizes) if (pdfTextWidth(str, size, bold) <= width) return { text: str, size, cut: false };
  const size = sizes[sizes.length - 1];
  let n = str.length;
  while (n > 0 && pdfTextWidth(`${str.slice(0, n).trimEnd()}…`, size, bold) > width) n--;
  return { text: `${str.slice(0, n).trimEnd()}…`, size, cut: true };
}

const NFP_LEAD = 0.494; // mm of line height per pt of the Inhalt text
const NFP_TEXT_SIZES = [12, 11, 10.5, 10]; // pt, the largest that fits one page
const NFP_VALUE_SIZES = [10.5, 9.5, 8.5, 7.5];
const NFP_FOOT_Y = NFP_PAGE.height - NFP_MARGIN + 0.5;
const NFP_CONT_TOP = 43; // mm: where the text of a continuation page starts

// The footer of a page: the status, the print time and the version of a
// filled form (of the empty one: what it is and when printed), "Seite n von N" of a
// several-page form.
function nfpFooter(cv, s, n, total) {
  const x0 = NFP_MARGIN, x1 = NFP_PAGE.width - NFP_MARGIN;
  pdfFooterUrl(cv, x0, NFP_FOOT_Y + 3.4);
  if (s.blank) {
    cv.text(`Notfunk-Meldebuch · Vordruck, gedruckt ${s.printed}`, x0, NFP_FOOT_Y, { size: 7, gray: 0.2 });
    return;
  }
  cv.text(`Notfunk-Meldebuch · Status ${s.status} · gedruckt ${s.printed} · Zeiten in Ortszeit Wien`, x0, NFP_FOOT_Y, { size: 7, gray: 0.2 });
  const right = [total > 1 ? `Seite ${n} von ${total}` : '', s.version ? `Fassung ${s.version}` : ''].filter(Boolean).join(' · ');
  cv.text(right, x1, NFP_FOOT_Y, { size: 7, gray: 0.2, align: 'right' });
}

// The form page. plan = null measures only (what the Inhalt area holds, which
// values were cut); otherwise plan = { size, lines, notice, total }: the text
// of the first page, the notice in its last line and the page count.
// -> { content, area: { capacity (lines of the text), width }, cuts }
function nfpFirstPage(s, plan) {
  const cv = pdfCanvas(NFP_PAGE);
  const cuts = [];
  const x0 = NFP_MARGIN, x1 = NFP_PAGE.width - NFP_MARGIN, width = x1 - x0;
  const caption = (text, x, y, opts = {}) => cv.text(text.toUpperCase(), x, y, { size: 6.8, gray: 0.15, ...opts });
  const writeLine = (xa, xb, y) => cv.line(xa, y, xb, y, { width: NFP_WRITE });
  // the value of a cell, on its writing line (baseline just above it)
  const put = (text, xa, xb, lineY, label, { bold = false, sizes = NFP_VALUE_SIZES } = {}) => {
    if (!text) return;
    const f = nfpFit(text, xb - xa - 1, sizes, bold);
    if (f.cut) cuts.push({ label, text: String(text) });
    cv.text(f.text, xa + 0.5, lineY - 1, { size: f.size, bold });
  };
  // "Funkstelle ______" : a small caption and the line after it
  const labelled = (text, xa, xb, y, value = '') => {
    cv.text(text, xa, y, { size: 8, gray: 0.15 });
    const la = xa + pdfTextWidth(text, 8) + 1.5;
    writeLine(la, xb, y);
    put(value, la, xb, y, text);
  };
  const tick = (x, y, size = NFP_TICK, on = false, gray = 0) => {
    cv.rect(x, y, size, size, { width: NFP_LINE, gray });
    if (on) {
      const m = size * 0.2;
      cv.line(x + m, y + m, x + size - m, y + size - m, { width: 1.3 });
      cv.line(x + size - m, y + m, x + m, y + size - m, { width: 1.3 });
    }
  };
  const frame = (x, y, w, h) => cv.rect(x, y, w, h, { width: NFP_LINE });
  // cells of a row side by side: widths in shares, borders between
  const cellsOf = (shares, total = width) => {
    const sum = shares.reduce((a, b) => a + b, 0);
    let x = x0;
    return shares.map(sh => { const c = { x, w: total * sh / sum }; x += c.w; return c; });
  };
  const row = (y, h, shares) => {
    const cells = cellsOf(shares);
    frame(x0, y, width, h);
    for (const c of cells.slice(1)) cv.line(c.x, y, c.x, y + h, { width: NFP_LINE });
    return cells;
  };
  const choice = (label, options, c, y) => {
    caption(label, c.x + 2.5, y + 3.6);
    // the empty form: each option a field of its own with the word, side by
    // side (as the siren grades on Confirm's Leerformular), to cross or
    // circle by hand; dotted lines between them, the cell's frame around
    if (s.blank) {
      const bx = c.x + 2.5, bw = c.w - 5, by = y + 4.6, n = options.length, w = bw / n;
      options.forEach((o, i) => {
        if (i) cv.line(bx + i * w, by, bx + i * w, by + NFP_BOX_H, { width: 0.4, gray: 0.45, dash: [0.8, 1.6] });
        cv.text(nfpFit(o.label, w - 2, [9.5, 8.5, 7.5]).text, bx + i * w + w / 2, by + NFP_BOX_H / 2 + 1.3, { size: nfpFit(o.label, w - 2, [9.5, 8.5, 7.5]).size, gray: 0.15, align: 'center' });
      });
      return;
    }
    const layout = nfpTiles(options, c.w - 5);
    for (const t of layout.tiles) {
      const on = !!t.option.checked;
      const tx = c.x + 2.5 + t.x, ty = y + 5.4 + t.y;
      // chosen: the circle filled, the word bold (no colour needed)
      cv.circle(tx + NFP_CIRCLE_R, ty + NFP_TILE_H / 2, NFP_CIRCLE_R, { width: on ? 1.2 : NFP_LINE, solid: on });
      cv.text(t.option.label, tx + NFP_CIRCLE_R * 2 + 1.8, ty + NFP_TILE_H / 2 + 1.25, { size: 9.5, bold: on });
    }
  };
  const choiceHeight = (options, c) => (s.blank ? 4.6 + NFP_BOX_H + 0.6 : 5.4 + nfpTiles(options, c.w - 5).height + 2.4);
  // "anders: Fax" where the channel is none of the printed ones
  const channels = s.channels.map(c => (c.key === 'anders' && s.channelOther ? { ...c, label: nfpFit(`anders: ${s.channelOther}`, 40, [9.5]).text } : c));

  // ---- header: title, Eingang / Ausgang, the number's box
  let y = NFP_MARGIN;
  const numW = 50, numX = x1 - numW, headH = 24.5;
  caption(nfpFit([NFP_CAPTIONS.org, s.title].filter(Boolean).join(' · ').toUpperCase(), numX - x0 - 4, [7, 6.2, 5.5]).text, x0, y + 3.2, { size: 7 });
  cv.text(NFP_CAPTIONS.title, x0, y + 11.5, { size: 19, bold: true });
  const dirW = (numX - 5 - x0 - 3) / 2;
  const chosen = s.directions.some(d => d.checked);
  s.directions.forEach((d, i) => {
    const bx = x0 + i * (dirW + 3), by = y + 14.5;
    const pale = chosen && !d.checked, gray = pale ? 0.55 : 0;
    cv.rect(bx, by, dirW, 10, { width: d.checked ? 1.8 : pale ? 0.7 : 1.1, gray });
    tick(bx + 3, by + 2.6, 4.8, d.checked, gray);
    // an arrow: Eingang down, Ausgang up
    const ax = bx + 13, top = by + 2.4, bot = by + 7.6, up = d.key === 'out';
    cv.line(ax, top, ax, bot, { width: 1.1, gray });
    const tip = up ? top : bot, back = up ? top + 2.2 : bot - 2.2;
    cv.line(ax, tip, ax - 1.8, back, { width: 1.1, gray });
    cv.line(ax, tip, ax + 1.8, back, { width: 1.1, gray });
    cv.text(d.label.toUpperCase(), bx + 18, by + 6.9, { size: 11, bold: !pale, gray });
  });
  frame(numX, y, numW, headH);
  caption(NFP_CAPTIONS.number, numX + 2.5, y + 3.8);
  if (s.number) {
    const f = nfpFit(s.number, numW - 5, [22, 18, 14], true);
    cv.text(f.text, numX + 2.5, y + 15, { size: f.size, bold: true });
    if (s.deleted) caption('gelöscht', numX + 2.5, y + 21);
  }
  y += headH + 2.5;
  cv.line(x0, y, x1, y, { width: 1.5 });
  y += 3.5;
  // ---- the Einsatz: every field of its header, labelled (labels gray,
  // values bold), wrapped over as many lines as it needs
  if (s.einsatz?.length) {
    const size = 8.5, pitch = 4.2;
    const lines = [[]];
    let used = 0;
    const room = width;
    for (const [label, value] of s.einsatz) {
      const sep = lines.at(-1).length ? ' · ' : '';
      const w = pdfTextWidth(`${sep}${label} `, size) + pdfTextWidth(value, size, true);
      if (used && used + w > room) { lines.push([]); used = 0; }
      const lead = lines.at(-1).length ? ' · ' : '';
      lines.at(-1).push({ lab: `${lead}${label} `, value });
      used += pdfTextWidth(`${lead}${label} `, size) + pdfTextWidth(value, size, true);
    }
    lines.forEach((parts, i) => {
      let at = x0;
      const base = y + 3 + i * pitch;
      for (const p of parts) {
        cv.text(p.lab, at, base, { size, gray: 0.35 });
        at += pdfTextWidth(p.lab, size);
        cv.text(p.value, at, base, { size, bold: true });
        at += pdfTextWidth(p.value, size, true);
      }
    });
    y += lines.length * pitch + 2.2;
  }

  // ---- the Meldesammelstelle's block (dashed)
  const staffH = 16;
  cv.rect(x0, y, width, staffH, { width: NFP_LINE, dash: [2, 1.5] });
  cv.text(NFP_CAPTIONS.staff.toUpperCase(), x0 + 2.5, y + 3.7, { size: 6.8, bold: true });
  const inner = width - 5, gap = 4;
  const shares = [1.3, 1, 1, 1], unit = (inner - gap * 3) / 4.3;
  let sx = x0 + 2.5;
  NFP_CAPTIONS.staffFields.forEach((f, i) => {
    const w = unit * shares[i];
    caption(f, sx, y + 8);
    writeLine(sx, sx + w, y + 13.2);
    if (i === 0) put(s.staffRef, sx, sx + w, y + 13.2, f, { sizes: [10.5, 9, 8] });
    sx += w + gap;
  });
  y += staffH + 2.5;

  // ---- rows of boxes. Every choice on one line of its own (calm, nothing
  // wraps): Datum and Uhrzeit side by side | Dringlichkeit; Übermittlung;
  // Meldungsart.
  const aShares = [58, 42];
  const aCells = cellsOf(aShares);
  let h = Math.max(choiceHeight(s.priorities, aCells[1]), 17);
  let cells = row(y, h, aShares);
  caption(s.timeLabel, cells[0].x + 2.5, y + 3.6);
  const dx = cells[0].x + 2.5, dxb = cells[0].x + cells[0].w - 3, mid = cells[0].x + cells[0].w * 0.55;
  labelled(NFP_CAPTIONS.date, dx, mid - 3, y + 11.6, s.date);
  labelled(NFP_CAPTIONS.time, mid + 1, dxb, y + 11.6, s.time);
  if (s.created) cv.text(`erfasst ${s.created}`, dxb, y + 15.2, { size: 7, gray: 0.2, align: 'right' });
  choice(NFP_CAPTIONS.priority, s.priorities, cells[1], y);
  y += h;
  const full = cellsOf([1])[0];
  h = choiceHeight(channels, full);
  row(y, h, [1]);
  choice(NFP_CAPTIONS.channel, channels, full, y);
  y += h;
  h = choiceHeight(s.types, full);
  row(y, h, [1]);
  choice(NFP_CAPTIONS.type, s.types, full, y);
  y += h;
  // Von | An (each with the radio station; An also the distribution list)
  h = 31;
  cells = row(y, h, [1, 1]);
  const peerSide = s.direction === 'out' ? 1 : 0; // the other party's side
  cells.forEach((c, i) => {
    const xa = c.x + 2.5, xb = c.x + c.w - 2.5;
    const label = i ? NFP_CAPTIONS.to : NFP_CAPTIONS.from;
    caption(label, xa, y + 3.6);
    writeLine(xa, xb, y + 12);
    put(i ? s.to : s.from, xa, xb, y + 12, label, { bold: true });
    labelled(NFP_CAPTIONS.peer, xa, xb, y + 20.4, s.direction && i === peerSide ? s.peer : '');
    if (i) labelled(NFP_CAPTIONS.distribution, xa, xb, y + 28, s.distribution);
  });
  y += h;
  // Betreff | Ort | Bezug
  h = 15.5;
  // Betreff the left half, as Von above; Ort and Bezug share the right half, as An
  cells = row(y, h, [2, 1.36, 0.64]);
  [[NFP_CAPTIONS.subject, s.subject, true], [NFP_CAPTIONS.place, s.location, false], [NFP_CAPTIONS.ref, s.ref, false]].forEach(([t, v, bold], i) => {
    caption(t, cells[i].x + 2.5, y + 3.6);
    writeLine(cells[i].x + 2.5, cells[i].x + cells[i].w - 2.5, y + 12.4);
    put(v, cells[i].x + 2.5, cells[i].x + cells[i].w - 2.5, y + 12.4, t, { bold });
  });
  y += h;

  // ---- below the text: Aufgenommen von | Anmerkungen, the handover, footer
  const takeH = 23, handH = 17;
  const textBottom = NFP_FOOT_Y - 4 - handH - takeH;
  // ---- the text: the Inhalt (filled) or ruled lines (empty), then the Rücklesen mark
  const textH = textBottom - y, readH = 9;
  frame(x0, y, width, textH);
  caption(NFP_CAPTIONS.text, x0 + 2.5, y + 3.6);
  const textTop = y + 5, textW = width - 5;
  const room = textH - 5 - readH - 1;
  if (!s.blank) {
    if (plan) {
      const pitch = plan.size * NFP_LEAD;
      plan.lines.forEach((l, i) => cv.text(l, x0 + 2.5, textTop + pitch * (i + 0.8), { size: plan.size }));
      if (plan.notice) cv.text(plan.notice, x1 - 2.5, textTop + room - 1.2, { size: 9, bold: true, align: 'right' });
    }
  } else {
    const lines = Math.floor((textH - 5 - readH) / NFP_PITCH);
    const pitch = (textH - 5 - readH) / lines;
    for (let i = 1; i <= lines; i++) writeLine(x0 + 2.5, x1 - 2.5, y + 5 + i * pitch - 0.3);
  }
  const readY = y + textH - readH + 2.3;
  if (plan?.note) cv.text(plan.note, x1 - 2.5, readY + 3.4, { size: 8, bold: true, align: 'right' });
  tick(x0 + 2.5, readY, 4.4, s.readBack);
  cv.text(s.readBackLabel, x0 + 9, readY + 3.4, { size: 8.5, gray: 0.1 });
  if (s.extra) {
    const ex = x0 + 9 + pdfTextWidth(s.readBackLabel, 8.5) + 3;
    const f = nfpFit(s.extra, x1 - 2.5 - ex - (plan?.note ? 62 : 0), [8, 7.2, 6.5]);
    if (f.cut) cuts.push({ label: 'Zusatz', text: s.extra });
    cv.text(f.text, ex, readY + 3.4, { size: f.size, gray: 0.1 });
  }
  y = textBottom;

  cells = row(y, takeH, [1, 1]);
  caption(NFP_CAPTIONS.operator, cells[0].x + 2.5, y + 3.6);
  writeLine(cells[0].x + 2.5, cells[0].x + cells[0].w - 2.5, y + 13);
  put(s.operator, cells[0].x + 2.5, cells[0].x + cells[0].w - 2.5, y + 13, NFP_CAPTIONS.operator, { bold: true });
  labelled(NFP_CAPTIONS.station, cells[0].x + 2.5, cells[0].x + cells[0].w - 2.5, y + 20, s.stationCall);
  caption(NFP_CAPTIONS.remarks, cells[1].x + 2.5, y + 3.6);
  const rxa = cells[1].x + 2.5, rxb = cells[1].x + cells[1].w - 2.5;
  writeLine(rxa, rxb, y + 13);
  writeLine(rxa, rxb, y + 20);
  if (s.remarks) {
    const wrapped = pdfWrap(s.remarks, rxb - rxa - 1, 9.5);
    const second = wrapped.length > 2 ? nfpFit(wrapped.slice(1).join(' '), rxb - rxa - 1, [9.5]) : null;
    if (second?.cut) cuts.push({ label: NFP_CAPTIONS.remarks, text: s.remarks });
    cv.text(wrapped[0], rxa + 0.5, y + 12, { size: 9.5 });
    if (wrapped.length > 1) cv.text(second ? second.text : wrapped[1], rxa + 0.5, y + 19, { size: 9.5 });
  }
  y += takeH;

  cells = row(y, handH, [1, 0.8, 1, 0.8]);
  s.handoverHeads.forEach((head, i) => {
    const xa = cells[i].x + 2.5, xb = cells[i].x + cells[i].w - 2.5;
    caption(head, xa, y + 3.6);
    if (i === 3 && s.direction !== 'out') {
      tick(xa, y + 8.3, 5.6, s.handoverDone);
      put(s.handover[3], xa + 7.5, xb, y + 13.4, head, { sizes: [10, 9, 8] });
    } else {
      writeLine(xa, xb, y + 13.4);
      put(s.handover[i], xa, xb, y + 13.4, head);
    }
  });

  nfpFooter(cv, s, 1, plan ? plan.total : 1);
  return { content: cv.ops.join('\n'), area: { room, width: textW }, cuts };
}

// A continuation page: the number and Betreff on top, then the lines
// ({ text, bold }) from NFP_CONT_TOP on.
function nfpContinuationPage(s, lines, size, n, total) {
  const cv = pdfCanvas(NFP_PAGE);
  const x0 = NFP_MARGIN, x1 = NFP_PAGE.width - NFP_MARGIN;
  const y = NFP_MARGIN;
  cv.text([NFP_CAPTIONS.org, s.title].filter(Boolean).join(' · ').toUpperCase(), x0, y + 3.2, { size: 7, gray: 0.15 });
  cv.text(`${NFP_CAPTIONS.title} – Fortsetzung`, x0, y + 11, { size: 14, bold: true });
  cv.rect(x1 - 50, y, 50, 14, { width: NFP_LINE });
  cv.text(NFP_CAPTIONS.number.toUpperCase(), x1 - 47.5, y + 3.8, { size: 6.8, gray: 0.15 });
  const num = nfpFit(s.number, 45, [14, 11], true);
  cv.text(num.text, x1 - 47.5, y + 11.2, { size: num.size, bold: true });
  const subj = nfpFit(`Betreff: ${s.subject}`, x1 - x0 - 58, [11, 10, 9], true);
  cv.text(subj.text, x0, y + 20, { size: subj.size, bold: true });
  cv.text(`Fortsetzung, Seite ${n} von ${total}`, x0, y + 25.5, { size: 9.5 });
  cv.line(x0, y + 28, x1, y + 28, { width: 1.5 });
  const pitch = size * NFP_LEAD;
  lines.forEach((l, i) => cv.text(l.text, x0 + 2.5, NFP_CONT_TOP + pitch * (i + 0.8), { size, bold: !!l.bold }));
  nfpFooter(cv, s, n, total);
  return cv.ops.join('\n');
}

// All pages of a form: [content, …]. The Inhalt text is set in the largest of
// NFP_TEXT_SIZES that fits the form page; if even the smallest does not, the
// page shows what fits plus "Fortsetzung auf Seite 2" and continuation pages
// follow. Values cut in a cell are repeated in full on the last page.
function nfpPages(s) {
  const measured = nfpFirstPage(s, null);
  const text = String(s.text || '').replace(/\s+$/, '');
  const { room, width } = measured.area;
  let size = NFP_TEXT_SIZES[NFP_TEXT_SIZES.length - 1], first = [], rest = [];
  for (const candidate of NFP_TEXT_SIZES) {
    const lines = pdfWrap(text, width, candidate);
    const cap = Math.floor(room / (candidate * NFP_LEAD));
    size = candidate;
    if (lines.length <= cap) { first = lines; rest = []; break; }
    // the smallest size: what fits (one line less, for the notice) and the rest
    first = lines.slice(0, Math.max(cap - 1, 0));
    rest = lines.slice(Math.max(cap - 1, 0));
  }
  const body = rest.map(text => ({ text }));
  // values cut on the form page, in full
  if (measured.cuts.length) {
    if (body.length) body.push({ text: '' });
    body.push({ text: 'Vollständige Angaben (auf Seite 1 gekürzt)', bold: true });
    for (const c of measured.cuts) {
      body.push({ text: `${c.label}:`, bold: true });
      for (const l of pdfWrap(c.text, width, size)) body.push({ text: l });
    }
  }
  const perPage = Math.floor((NFP_PAGE.height - NFP_MARGIN - 8 - NFP_CONT_TOP) / (size * NFP_LEAD));
  const chunks = [];
  for (let i = 0; i < body.length; i += perPage) chunks.push(body.slice(i, i + perPage));
  const total = 1 + chunks.length;
  // overflowing text: the notice closes the text; only cut values: it sits in the Rücklesen row
  const plan = {
    size, lines: first, total,
    notice: rest.length ? 'Fortsetzung auf Seite 2' : '',
    note: total > 1 && !rest.length ? 'Gekürzte Angaben: vollständig auf Seite 2' : '',
  };
  return [nfpFirstPage(s, plan).content, ...chunks.map((c, i) => nfpContinuationPage(s, c, size, i + 2, total))];
}

// -> the empty form as PDF bytes (Uint8Array). op: the Einsatz (its name is
// in the title line), or null; now: ISO timestamp for "gedruckt".
export function blankFormPdf(op, { now }) {
  const s = blankFormSheet(op, { now });
  return pdfDocument(NFP_PAGE, nfpPages(s), `Meldeaufnahmeformular – Vordruck${s.title ? ` ${s.title}` : ''}`);
}

// -> the filled form of one message as PDF bytes: A4 portrait, one page, or
// more for a long text. op: the Einsatz; now: ISO timestamp for "gedruckt";
// revisions: how many earlier versions are stored ("Fassung n+1"); byId:
// Map of id -> message, to find the number of the message a reply answers.
export function formPdf(msg, op, { now, revisions = 0, byId = new Map() }) {
  const s = formSheet(msg, op, { now, revisions, byId });
  return pdfDocument(NFP_PAGE, nfpPages(s), `Meldeaufnahmeformular ${s.number}${s.title ? ` – ${s.title}` : ''}`);
}
