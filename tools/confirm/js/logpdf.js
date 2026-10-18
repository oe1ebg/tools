// A log as a PDF ("Drucken"): every live line, oldest first, as an A4
// landscape table in the columns of the log on screen (Nr · Zeit ·
// Rufzeichen · the template's columns · Relais · Notiz), with the log's
// header on every page: title, ALL fields of the Betrieb (labelled), the
// range from the first to the last line, the time zone and the print time.
// Full texts, wrapped, never truncated; a row that does not fit the rest of
// a page continues on the next one. Comment and marker lines are full-width
// rows (tinted, a bar at the left, the category in capitals); a Relais that
// differs from the Betrieb is framed (dashed) and said in words; siren
// grades are numbers in small boxes (tinted, but the digit says it); the
// yes/no of AT-Alert is a drawn tick or cross and the word. Written with the
// shared PDF writer (../../shared/js/pdf.js), so it prints the same at its
// own size in every browser. The empty sheet is paperpdf.js.

import { logColumns, chainValues, nameField, templateFor } from './templates.js';
import { liveSorted, checkinNumbers, isComment, modeInfo, parseMHz, signallingText } from './model.js';
import { splitTime, zoneAbbr } from '../../shared/js/time.js';
import { LOC_ORIGINS, locOrigin, locHints } from '../../shared/js/locmeta.js';
import { describeLocation } from '../../shared/js/locfield.js';
import { formatShift } from '../../shared/js/repeaters.js';
import { PDF_A4_LANDSCAPE, pdfCanvas, pdfDocument, pdfWrap, pdfTextWidth } from '../../shared/js/pdf.js';

export const CLP_PAGE = PDF_A4_LANDSCAPE;
const CLP_MARGIN = 10;
const CLP_PITCH = 4.3; // mm per text line
const CLP_PAD = 1.3; // mm above and below a row's text
const CLP_PADX = 1.6; // mm inside a column
const CLP_SIZE = 9.5; // pt, body text
const CLP_SMALL = 8; // pt, second lines
const CLP_BODY_BOTTOM = CLP_PAGE.height - CLP_MARGIN - 6;
const CLP_SHORT_ROW = 8; // lines: a shorter row moves to the next page rather than splitting
const CLP_BOX = 3.6; // mm, a siren grade's box
const CLP_GRADE_FILL = { 1: [0.88, 0.96, 0.88], 2: [0.88, 0.96, 0.88], 3: [0.99, 0.93, 0.78], 4: [0.99, 0.88, 0.88], 5: [0.99, 0.88, 0.88] };
const CLP_TINT = [0.9, 0.93, 0.98]; // comment rows

const clpLine = (t, o = {}) => ({ t, ...o });

// The Betrieb as labelled fields [[label, value]], only those that are set.
export function clpHeaderFields(h = {}) {
  const f = [];
  const add = (label, value) => { if (value !== undefined && value !== null && String(value).trim() !== '') f.push([label, String(value)]); };
  add('Operator', h.operator);
  add('Station', h.station);
  add('QTH', h.myQth);
  add('Locator', h.myGrid);
  add('Betriebsart', modeInfo(h.mode)?.label || h.mode);
  if (h.viaRepeater) {
    add('Relais', h.repeaterCall || 'Relais');
    add('Ausgabe', h.repeaterFreq && `${h.repeaterFreq} MHz`);
    const shift = h.repeaterShift !== '' && h.repeaterShift !== undefined && h.repeaterShift !== null ? formatShift(parseMHz(h.repeaterShift)) : '';
    add('Ablage', shift && `${shift} MHz`);
  } else {
    add('Relais', 'direkt');
    add('Frequenz', h.freq && `${h.freq} MHz`);
  }
  add('Signalisierung', signallingText(h));
  return f;
}

// "OE1ABC" or "OE1ABC/OE1XKS" (operator at another station's callsign).
function clpOp(s) {
  return s?.operator && s.station && s.operator !== s.station ? `${s.operator}/${s.station}` : s?.operator || s?.station || '';
}

// Everything a printout needs that depends on the log's settings, once.
function clpContext(event, entries, opts) {
  const mode = opts.mode === 'local' ? 'local' : 'utc';
  const now = opts.now || new Date().toISOString();
  const tpl = templateFor(event.template);
  const live = liveSorted(entries);
  const zone = mode === 'utc' ? 'UTC' : zoneAbbr(now);
  const fmt = iso => splitTime(iso, mode);
  return { event, h: event.header || {}, mode, now, tpl, live, zone, fmt, nums: checkinNumbers(entries), opts, columns: logColumns(tpl), nf: nameField(tpl) };
}

// The widths of the columns [{ kind, head, w, ... }] for a template; Notiz
// takes the rest of the page's width (never less than 45 mm).
function clpColumns(cx) {
  const width = CLP_PAGE.width - 2 * CLP_MARGIN;
  const cols = [
    { kind: 'nr', head: 'Nr', w: 9 },
    { kind: 'time', head: `Zeit (${cx.zone})`, w: 19.5 },
    { kind: 'call', head: 'Rufzeichen', w: 27 },
  ];
  for (const c of cx.columns) {
    if (c.kind === 'name') cols.push({ kind: 'name', head: c.head, w: 24, c });
    else if (c.kind === 'rst') cols.push({ kind: 'rst', head: `RST ${c.fields.map(f => f.short.replace(/\.$/, '')).join(' / ')}`, w: 24, c });
    else if (c.kind === 'location') cols.push({ kind: 'location', head: c.head, w: 58, c });
    else if (c.kind === 'grades') cols.push({ kind: 'grades', head: c.head, w: 12 + 15 * c.fields.length, c });
    else cols.push({ kind: 'chain', head: c.head, w: c.fields[0].key === 'atalert' ? 34 : 30, c });
  }
  cols.push({ kind: 'route', head: 'Relais', w: 23 });
  const used = cols.reduce((s, c) => s + c.w, 0);
  const note = Math.max(width - used, 45);
  const scale = used + note > width ? (width - 45) / used : 1; // too wide: the others shrink
  let x = CLP_MARGIN;
  cols.push({ kind: 'note', head: 'Notiz', w: note });
  for (const c of cols) { c.w = c.kind === 'note' ? width - (x - CLP_MARGIN) : c.w * scale; c.x = x; x += c.w; }
  return cols;
}

const clpWrap = (text, col, size, o = {}) => pdfWrap(text, col.w - 2 * CLP_PADX, size, !!o.bold).map(t => clpLine(t, { size, ...o }));
const clpAt = (cx, iso) => { const { date, time } = cx.fmt(iso); return { date, time }; };

// The time cell: the time (Z for UTC), the date where it is not the first
// line's day, the zone where a local time is in another zone than now.
function clpTimeCell(cx, e, col) {
  const { date, time } = clpAt(cx, e.ts);
  const out = [clpLine(cx.mode === 'utc' ? `${time}Z` : time, { size: CLP_SIZE })];
  if (cx.live.length && date !== clpAt(cx, cx.live[0].ts).date) out.push(clpLine(date, { size: CLP_SMALL, gray: 0.25 }));
  if (cx.mode === 'local' && zoneAbbr(e.ts) !== zoneAbbr(cx.now)) out.push(clpLine(zoneAbbr(e.ts), { size: CLP_SMALL, gray: 0.25 }));
  return out;
}

function clpLocationCell(cx, f, e, col) {
  const text = e.fields?.[f.key] || '';
  const plz = f.plzKey ? e.fields?.[f.plzKey] || '' : '';
  const loc = e.loc;
  if (!loc) {
    if (!text && !plz) return [];
    return [...clpWrap(text, col, CLP_SIZE), ...clpWrap([plz, text ? 'nicht zugeordnet' : ''].filter(Boolean).join(' · '), col, CLP_SMALL, { gray: 0.25 })];
  }
  const k = locOrigin(loc, text);
  const o = LOC_ORIGINS[k];
  const full = describeLocation(loc, cx.opts.utmDigits || 0);
  const sub = full.startsWith(loc.label) && loc.label === text ? full.slice(loc.label.length).replace(/^[\s,·]+/, '') : full;
  const subText = [sub, ...locHints(loc), o?.label].filter(Boolean).join(' · ');
  return [...clpWrap(text || loc.label, col, CLP_SIZE), ...(subText ? clpWrap(subText, col, CLP_SMALL, { gray: 0.25 }) : [])];
}

// Siren grades: label and a box with the number per field, on one line if
// they fit the column, else one per line.
function clpGradesCell(c, e, col) {
  const items = c.fields.map(f => ({ label: f.short, g: e.fields?.[f.key] || '' }));
  const itemW = it => pdfTextWidth(it.label, CLP_SMALL) + 1 + CLP_BOX + 1.6;
  const total = items.reduce((s, it) => s + itemW(it), 0);
  if (total <= col.w - 2 * CLP_PADX) return [clpLine('', { chips: items })];
  return items.map(it => clpLine('', { chips: [it] }));
}

function clpChainCell(c, e, cx, col) {
  const vs = chainValues(c, e.fields || {}, cx.tpl);
  if (!vs.length) return [];
  if (c.fields[0].key === 'atalert') {
    const ok = e.fields?.atalert === 'ja';
    const out = [clpLine(vs[0], { size: CLP_SIZE, bold: true, mark: ok ? 'yes' : 'no' })];
    if (vs.length > 1) out.push(...clpWrap(vs.slice(1).join(' · '), col, CLP_SMALL, { gray: 0.25 }));
    return out;
  }
  return clpWrap(vs.join(' · '), col, CLP_SIZE);
}

// Does the line's Relais differ from the Betrieb's (as the screen's dashed frame)?
function clpRouteDiffers(cx, e) {
  return !!e.viaRepeater !== !!cx.h.viaRepeater || !!(e.viaRepeater && e.snap?.repeaterOverride);
}

function clpRouteCell(cx, e, col) {
  const s = e.snap || {};
  const differs = clpRouteDiffers(cx, e);
  const out = [clpLine(e.viaRepeater ? s.repeaterCall || 'Relais' : 'direkt', { size: CLP_SIZE, bold: differs, dashed: differs })];
  if (differs) {
    out.push(...clpWrap('abweichend', col, CLP_SMALL, { gray: 0.25 }));
    if (e.viaRepeater && s.repeaterFreq) out.push(clpLine(`${s.repeaterFreq} MHz`, { size: CLP_SMALL, gray: 0.25 }));
  }
  return out;
}

// The cells of a check-in: an array of lines per column.
function clpCells(cx, cols, e) {
  const n = cx.nums.get(e.id);
  const cb = cx.opts.callbook ? cx.opts.callbook(e.call) : '';
  const name = cx.nf ? e.fields?.[cx.nf.key] || '' : '';
  return cols.map(col => {
    switch (col.kind) {
      case 'nr': return [clpLine(String(e.seq), { size: CLP_SIZE, bold: true })];
      case 'time': return clpTimeCell(cx, e, col);
      case 'call': return [clpLine(e.call, { size: 10, bold: true }),
        ...(n > 1 ? [clpLine(`${n}. Check-in`, { size: CLP_SMALL, gray: 0.25 })] : []),
        ...(!cx.nf && cb ? clpWrap(cb, col, CLP_SMALL, { gray: 0.25 }) : [])];
      case 'name': return [...(name ? clpWrap(name, col, CLP_SIZE) : []), ...(cb && cb !== name ? clpWrap(cb, col, CLP_SMALL, { gray: 0.25 }) : [])];
      case 'rst': return [clpLine(col.c.fields.map(f => e.fields?.[f.key] || '–').join(' / '), { size: CLP_SIZE })];
      case 'location': return clpLocationCell(cx, col.c.fields[0], e, col);
      case 'grades': return clpGradesCell(col.c, e, col);
      case 'chain': return clpChainCell(col.c, e, cx, col);
      case 'route': return clpRouteCell(cx, e, col);
      default: {
        const lines = [];
        const op = clpOp(e.snap);
        if (op && op !== clpOp(cx.h)) lines.push(...clpWrap(`Op ${op}`, col, CLP_SIZE, { bold: true }));
        if (e.note) lines.push(...clpWrap(e.note, col, CLP_SIZE));
        return lines;
      }
    }
  });
}

// The category of a comment: in capitals at 7.5 pt, smaller (down to 6 pt)
// where the word does not fit the column, then wrapped.
function clpCategory(text, width) {
  let size = 7.5;
  while (size > 6 && pdfTextWidth(text, size, true) > width) size -= 0.5;
  return pdfWrap(text, width, size, true).map(t => clpLine(t, { size, bold: true }));
}

// A comment / marker line: time, category, operator if it differs, and the
// text (wrapped to the width after the callsign column).
function clpCommentRow(cx, cols, e) {
  const textX = cols[3].x;
  const width = CLP_PAGE.width - CLP_MARGIN - textX - 2 * CLP_PADX;
  const op = clpOp(e.snap);
  const opText = op && op !== clpOp(cx.h) ? `Op ${op}` : '';
  const opW = opText ? pdfTextWidth(opText, CLP_SIZE, true) + 4 : 0;
  const { time } = clpAt(cx, e.ts);
  const date = clpAt(cx, e.ts).date;
  const text = pdfWrap(e.text || '', width - opW, CLP_SIZE).map(t => clpLine(t, { size: CLP_SIZE }));
  const timeLines = [clpLine(cx.mode === 'utc' ? `${time}Z` : time, { size: CLP_SIZE })];
  if (cx.live.length && date !== clpAt(cx, cx.live[0].ts).date) timeLines.push(clpLine(date, { size: CLP_SMALL, gray: 0.25 }));
  return {
    comment: true,
    time: timeLines,
    cat: clpCategory(`${(e.category || 'Kommentar').toUpperCase()}${e.auto ? ' (AUTO)' : ''}`, cols[2].w - 2 * CLP_PADX),
    text, opText, textX,
  };
}

// Rows onto pages: [[row]], splitting rows that do not fit. A row is
// { cells } (check-in: lines per column) or a comment row { time, cat, text }.
function clpLayout(rows, bodyTop) {
  const pages = [[]];
  let used = 0;
  const height = lines => lines * CLP_PITCH + 2 * CLP_PAD;
  const room = () => Math.floor((CLP_BODY_BOTTOM - bodyTop - used - 2 * CLP_PAD) / CLP_PITCH);
  const next = () => { pages.push([]); used = 0; };
  const slice = (r, from, to) => (r.comment
    ? { ...r, time: r.time.slice(from, to), cat: r.cat.slice(from, to), text: r.text.slice(from, to) }
    : { ...r, cells: r.cells.map(c => c.slice(from, to)) });
  const count = r => (r.comment ? Math.max(r.text.length, r.time.length, r.cat.length, 1) : Math.max(1, ...r.cells.map(c => c.length)));
  for (let r of rows) {
    for (;;) {
      const lines = count(r);
      const fit = room();
      if (lines <= fit) { pages.at(-1).push(r); used += height(lines); break; }
      if (pages.at(-1).length && (lines <= CLP_SHORT_ROW || fit < 3)) { next(); continue; }
      pages.at(-1).push(slice(r, 0, fit));
      used += height(fit);
      const rest = slice(r, fit);
      // the continuation says whose line it is (number / category)
      if (r.comment) rest.cat = [clpLine('FORTSETZUNG', { size: 7.5, bold: true }), ...rest.cat];
      else rest.cells[0] = [clpLine(r.cells[0][0]?.t || '', { size: CLP_SIZE, bold: true }), ...rest.cells[0]];
      r = rest;
      next();
    }
  }
  return pages;
}

function clpGradeBox(cv, x, base, item) {
  const y = base - 2.9;
  if (!item.g) {
    cv.rect(x, y, CLP_BOX, CLP_BOX, { width: 0.3, gray: 0.5, dash: [0.6, 0.6] });
    cv.text('–', x + CLP_BOX / 2, base - 0.2, { size: CLP_SIZE, align: 'center', gray: 0.4 });
    return;
  }
  cv.fill(x, y, CLP_BOX, CLP_BOX, CLP_GRADE_FILL[item.g] || 1);
  cv.rect(x, y, CLP_BOX, CLP_BOX, { width: 0.4, gray: 0.15 });
  cv.text(item.g, x + CLP_BOX / 2, base - 0.2, { size: CLP_SIZE, bold: true, align: 'center' });
}

// A tick or a cross of 3 mm at the baseline.
function clpMark(cv, x, base, yes) {
  if (yes) {
    cv.line(x, base - 1.2, x + 1, base, { width: 0.8 });
    cv.line(x + 1, base, x + 3, base - 2.8, { width: 0.8 });
  } else {
    cv.line(x, base - 2.8, x + 2.8, base, { width: 0.8 });
    cv.line(x, base, x + 2.8, base - 2.8, { width: 0.8 });
  }
}

// The header's fields flowed onto lines of the page's width: [[label, value]] per line.
function clpFieldLines(fields, width) {
  const size = 9;
  const lines = [[]];
  let at = 0;
  for (const [label, value] of fields) {
    const need = pdfTextWidth(`${label} `, size) + pdfTextWidth(value, size, true) + 5;
    if (at + need > width && lines.at(-1).length) { lines.push([]); at = 0; }
    lines.at(-1).push([label, value]);
    at += need;
  }
  return lines;
}

function clpRange(cx) {
  if (!cx.live.length) return 'keine Zeilen';
  const a = cx.fmt(cx.live[0].ts), b = cx.fmt(cx.live.at(-1).ts);
  return `${a.date} ${a.time} bis ${b.date} ${b.time}`;
}

// The layout that all pages share: the header's lines, where the table starts.
function clpHead(cx) {
  const fields = clpFieldLines(clpHeaderFields(cx.h), CLP_PAGE.width - 2 * CLP_MARGIN);
  const headY = CLP_MARGIN + 18 + fields.length * 5 + 6; // top of the column heads
  return { fields, headY, bodyTop: headY + 7 };
}

function clpPage(cx, head, cols, rows, n, total) {
  const cv = pdfCanvas(CLP_PAGE);
  const x0 = CLP_MARGIN, x1 = CLP_PAGE.width - CLP_MARGIN;
  const title = cx.event.title || 'Log';
  cv.text('Bestätigungsverkehr', x0, CLP_MARGIN + 5, { size: 15, bold: true });
  const pr = splitTime(cx.now, cx.mode);
  cv.text(`gedruckt ${pr.date} ${pr.time} ${cx.zone}`, x1, CLP_MARGIN + 5, { size: 9, align: 'right' });
  cv.text(title, x0, CLP_MARGIN + 11, { size: 10.5, bold: true });
  cv.text(`Vorlage: ${cx.tpl.label}`, x1, CLP_MARGIN + 11, { size: 9, align: 'right' });
  // every field of the Betrieb, labelled
  let y = CLP_MARGIN + 16.5;
  for (const line of head.fields) {
    let at = x0;
    line.forEach(([label, value]) => {
      cv.text(`${label} `, at, y, { size: 9, gray: 0.35 });
      at += pdfTextWidth(`${label} `, 9);
      cv.text(value, at, y, { size: 9, bold: true });
      at += pdfTextWidth(value, 9, true) + 5;
    });
    y += 5;
  }
  if (!head.fields.length) { cv.text('Betrieb: keine Angaben', x0, y, { size: 9 }); y += 5; }
  cv.text(`Zeitraum: ${clpRange(cx)}`, x0, y, { size: 9.5 });
  cv.text(`Zeiten in ${cx.mode === 'utc' ? 'UTC' : `Ortszeit (${cx.zone})`}`, x1, y, { size: 9, align: 'right' });
  cv.line(x0, y + 3, x1, y + 3, { width: 1.5 });
  // column heads (repeated on every page)
  for (const c of cols) cv.text(c.head.toUpperCase(), c.x + CLP_PADX, head.headY + 4.6, { size: 7, bold: true });
  cv.line(x0, head.bodyTop - 0.6, x1, head.bodyTop - 0.6, { width: 1 });

  y = head.bodyTop;
  if (!rows.length) cv.text('Keine Zeilen in diesem Log.', x0 + CLP_PADX, y + 7, { size: 10.5 });
  for (const row of rows) {
    const base = k => y + CLP_PAD + CLP_PITCH * (k + 0.78);
    if (row.comment) {
      const lines = Math.max(row.text.length, row.time.length, row.cat.length, 1);
      const h = lines * CLP_PITCH + 2 * CLP_PAD;
      cv.fill(x0, y, x1 - x0, h, CLP_TINT);
      cv.fill(x0, y, 1.4, h, 0.1);
      cv.line(x0, y, x1, y, { width: 0.7 });
      row.time.forEach((l, k) => cv.text(l.t, cols[1].x + CLP_PADX, base(k), { size: l.size, gray: l.gray || 0 }));
      row.cat.forEach((l, k) => cv.text(l.t, cols[2].x + CLP_PADX, base(k), { size: l.size, bold: true }));
      row.text.forEach((l, k) => cv.text(l.t, row.textX + CLP_PADX, base(k), { size: l.size }));
      if (row.opText) cv.text(row.opText, x1 - CLP_PADX, base(0), { size: CLP_SIZE, bold: true, align: 'right' });
      y += h;
      cv.line(x0, y, x1, y, { width: 0.7 });
      continue;
    }
    const lines = Math.max(1, ...row.cells.map(c => c.length));
    row.cells.forEach((lns, i) => lns.forEach((l, k) => {
      const col = cols[i];
      let tx = col.x + CLP_PADX;
      const b = base(k);
      if (l.chips) {
        for (const it of l.chips) {
          cv.text(it.label, tx, b, { size: CLP_SMALL, gray: 0.2 });
          tx += pdfTextWidth(it.label, CLP_SMALL) + 1;
          clpGradeBox(cv, tx, b, it);
          tx += CLP_BOX + 1.6;
        }
        return;
      }
      if (l.mark) { clpMark(cv, tx, b, l.mark === 'yes'); tx += 4.2; }
      cv.text(l.t, tx, b, { size: l.size || CLP_SIZE, bold: !!l.bold, gray: l.gray || 0 });
      if (l.dashed) {
        const w = pdfTextWidth(l.t, l.size || CLP_SIZE, !!l.bold);
        cv.rect(tx - 1, b - 3.4, w + 2, 4.4, { width: 0.5, dash: [1, 0.8] });
      }
    }));
    const h = lines * CLP_PITCH + 2 * CLP_PAD;
    for (const c of cols.slice(1)) cv.line(c.x, y, c.x, y + h, { width: 0.2, gray: 0.7 });
    y += h;
    cv.line(x0, y, x1, y, { width: 0.3, gray: 0.5 });
  }
  cv.text(`Bestätigungsverkehr · ${title}`, x0, CLP_PAGE.height - CLP_MARGIN + 0.5, { size: 8, gray: 0.2 });
  cv.text(`Seite ${n} von ${total}`, x1, CLP_PAGE.height - CLP_MARGIN + 0.5, { size: 9, align: 'right' });
  return cv.ops.join('\n');
}

// -> the log as PDF bytes (Uint8Array). event: the log; entries: all its
// lines (deleted ones are left out). opts: { mode: 'utc' | 'local' (the
// screen's time mode), now: ISO time of printing, callbook(call) -> name
// from the callsign list, utmDigits }.
export function logPdf(event, entries, opts = {}) {
  const cx = clpContext(event, entries, opts);
  const cols = clpColumns(cx);
  const head = clpHead(cx);
  const rows = cx.live.map(e => (isComment(e) ? clpCommentRow(cx, cols, e) : { cells: clpCells(cx, cols, e) }));
  const pages = clpLayout(rows, head.bodyTop);
  return pdfDocument(CLP_PAGE, pages.map((r, i) => clpPage(cx, head, cols, r, i + 1, pages.length)),
    `Bestätigungsverkehr – ${event.title || 'Log'}`);
}

