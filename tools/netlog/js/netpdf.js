// Netlog as PDF (the shared writer, A4 portrait, black on white, 9-10 pt):
//   logPdf(app)     the Continuous Log: every round with its notes and
//                   events in recorded order, the full text, replies
//   rosterPdf(app)  the Net Control roster with the facts of the round, the
//                   session and its series, and the net control handovers
// Times follow the time mode of the page (UTC or local, the zone in the
// header). Text is WinAnsi: arrows and symbols of the screen are written as
// words or ASCII.

import { PDF_MM, PDF_A4_PORTRAIT, pdfCanvas, pdfDocument, pdfWrap, pdfTextWidth, pdfOpen, pdfFooterUrl } from '../../shared/js/pdf.js';
import { t } from './i18n.js';
import { hm, zone, timeMode } from './clock.js';
import { splitTime } from '../../shared/js/time.js';
import { liveOf, roundsSorted, rosterSorted, ncsFirst, netStyle, responseOf, sessionLabel } from './model.js';
import { timeline, stationEvents, eventText } from './notes.js';
import { callText } from './roster.js';

const NPDF_PAGE = PDF_A4_PORTRAIT;
const NPDF_M = 15; // mm margin
const NPDF_TOP = 30; // mm: first line under the page head
const NPDF_BOTTOM = NPDF_PAGE.height - 20;
const NPDF_W = NPDF_PAGE.width - 2 * NPDF_M;
const NPDF_PITCH = 4.4; // mm per text line
const NPDF_PAD = 1.3; // mm above and below a row

// the screen's symbols in WinAnsi text
const npdfPlain = s => String(s ?? '').replace(/→/g, '->').replace(/[↩↪●▶▸▾✓✕]/g, '').replace(/[ \t]+/g, ' ');

const npdfFileDate = app => (app.s && app.s.date) || new Date().toISOString().slice(0, 10);
const npdfSeriesOf = app => app.data.series.find(s => s.id === app.s.seriesId) || null;
const npdfNetName = app => sessionLabel(app.s, npdfSeriesOf(app)) || t('session.untitled');

// "2026-10-20 14:05 UTC"
function npdfStamp(iso = new Date().toISOString()) {
  return `${iso.slice(0, 10)} ${hm(iso)} ${zone(iso)}`;
}

// A document that flows onto A4 pages: page head and foot on each, rows of
// columns that split between pages by lines.
function npdfFlow(title, sub) {
  const pages = [];
  let cv = null;
  let y = NPDF_TOP;
  const head = () => {
    cv.text(npdfPlain(title), NPDF_M, NPDF_M + 4, { size: 14, bold: true });
    cv.text(`${t('pdf.printed')} ${npdfStamp()}`, NPDF_PAGE.width - NPDF_M, NPDF_M + 4, { size: 8.5, align: 'right', gray: 0.3 });
    cv.text(npdfPlain(sub), NPDF_M, NPDF_M + 10, { size: 9.5 });
    cv.line(NPDF_M, NPDF_M + 13, NPDF_PAGE.width - NPDF_M, NPDF_M + 13, { width: 1.2 });
  };
  const newPage = () => { cv = pdfCanvas(NPDF_PAGE); pages.push(cv); head(); y = NPDF_TOP; };
  newPage();
  const room = () => Math.floor((NPDF_BOTTOM - y - 2 * NPDF_PAD) / NPDF_PITCH);
  const api = {
    get cv() { return cv; },
    get y() { return y; },
    skip(mm) { y += mm; },
    need(mm) { if (y + mm > NPDF_BOTTOM) newPage(); },
    // a bar with a heading across the width (a round, a block of the page)
    bar(text, right = '') {
      api.need(NPDF_PITCH * 3);
      cv.fill(NPDF_M, y, NPDF_W, 6.4, 0.92);
      cv.text(npdfPlain(text), NPDF_M + 2, y + 4.5, { size: 10.5, bold: true });
      if (right) cv.text(npdfPlain(right), NPDF_PAGE.width - NPDF_M - 2, y + 4.5, { size: 8.5, align: 'right', gray: 0.3 });
      y += 6.4 + 1;
    },
    // a row: cols = [{ x, w, lines: [{ t, bold, size, gray }] }] (x from the left margin);
    // lines are wrapped here when given as { text, ... } with wrap: true
    row(cols, { rule = true } = {}) {
      const cells = cols.map(c => ({
        ...c,
        lines: c.lines.flatMap(l => (l.wrap === false ? [l] : pdfWrap(npdfPlain(l.t), c.w - 1.5, l.size || 9, !!l.bold).map(tt => ({ ...l, t: tt })))),
      }));
      for (;;) {
        const total = Math.max(1, ...cells.map(c => c.lines.length));
        const fit = Math.max(room(), 0);
        const take = total <= fit ? total : Math.max(fit, 0);
        if (take < Math.min(total, 2) && y > NPDF_TOP) { newPage(); continue; }
        const n = take || total;
        cells.forEach(c => c.lines.slice(0, n).forEach((l, k) => {
          const base = y + NPDF_PAD + NPDF_PITCH * (k + 0.78);
          cv.text(l.t, NPDF_M + c.x, base, { size: l.size || 9, bold: !!l.bold, gray: l.gray || 0 });
          // small tags after the text: NCS filled (a former one: light grey), me outlined
          let tx = NPDF_M + c.x + pdfTextWidth(l.t, l.size || 9, !!l.bold) + 1.8;
          for (const tag of l.tags || []) {
            const w = pdfTextWidth(tag.text, 7, true) + 2;
            if (tag.solid) { cv.fill(tx, base - 3, w, 3.8, 0.1); cv.text(tag.text, tx + 1, base - 0.2, { size: 7, bold: true, gray: 1 }); }
            else if (tag.soft) { cv.fill(tx, base - 3, w, 3.8, 0.85); cv.text(tag.text, tx + 1, base - 0.2, { size: 7, bold: true, gray: 0.25 }); }
            else { cv.rect(tx, base - 3, w, 3.8, { width: 0.5 }); cv.text(tag.text, tx + 1, base - 0.2, { size: 7, bold: true }); }
            tx += w + 1;
          }
        }));
        y += n * NPDF_PITCH + 2 * NPDF_PAD;
        if (n >= total) { if (rule) cv.line(NPDF_M, y, NPDF_PAGE.width - NPDF_M, y, { width: 0.3, gray: 0.6 }); return; }
        cells.forEach(c => { c.lines = c.lines.slice(n); });
        newPage();
      }
    },
    finish(docTitle) {
      pages.forEach((p, i) => {
        p.text(t('pdf.page', { n: i + 1, total: pages.length }), NPDF_PAGE.width - NPDF_M, NPDF_PAGE.height - NPDF_M + 0.5, { size: 9, align: 'right' });
        pdfFooterUrl(p, NPDF_M, NPDF_PAGE.height - NPDF_M + 0.5);
      });
      return pdfDocument(NPDF_PAGE, pages.map(p => p.ops.join('\n')), npdfPlain(docTitle));
    },
  };
  return api;
}

const npdfNote = (txt, o = {}) => ({ t: txt, ...o });

// "00:56", "01:05" (hh:mm) for a span in ms; "-" for none or for more than a day
// (a net does not run that long: the data is then not a continuous session)
const npdfDur = ms => {
  if (!(ms >= 0) || ms > 24 * 3600000) return '-';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// ---------- the Continuous Log ----------

export function logPdf(app) {
  const name = npdfNetName(app);
  const f = npdfFlow(`Netlog · ${t('log.title')}`, `${name} · ${app.s.date || ''} · ${t('pdf.times', { zone: zone() })}`);
  const sorted = roundsSorted(app.sd.rounds);
  const parts = new Map(app.sd.participants.map(p => [p.id, p]));
  const notes = liveOf(app.sd.notes);
  let any = false;
  for (const r of sorted) {
    const list = notes.filter(n => n.roundId === r.id);
    const ev = stationEvents(app, r.id);
    f.bar([t('round.indicator', { n: r.number }), r.id === app.s.currentRoundId ? t('round.current') : '', r.topic].filter(Boolean).join(' · '), t('log.count', { n: list.length }));
    const rows = timeline(list, ev);
    if (!rows.length) f.row([{ x: 2, w: NPDF_W - 2, lines: [npdfNote(t('round.noNotes'), { gray: 0.4 })] }], { rule: false });
    // consecutive notes of one station are one block (an event ends it)
    const blocks = [];
    for (const x of rows) {
      const last = blocks.at(-1);
      if (x.kind === 'note' && last && last.notes && last.pid === x.n.participantId) last.notes.push(x.n);
      else blocks.push(x.kind === 'note' ? { notes: [x.n], pid: x.n.participantId } : { event: x.e });
    }
    for (const b of blocks) {
      any = true;
      if (b.event) {
        f.row([
          { x: 0, w: 24, lines: [npdfNote(b.event.time && b.event.time.iso ? hm(b.event.time.iso) : '-', { gray: 0.35, size: 8.5 })] },
          { x: 24, w: NPDF_W - 24, lines: [npdfNote(eventText(app, b.event, true), { gray: 0.35, size: 8.5 })] },
        ], { rule: false });
        continue;
      }
      const p = parts.get(b.pid);
      // the speaking time: the first note's time, or from - to when it ran 2 minutes or more
      const at = n => (n.time && n.time.iso ? n.time.iso : null);
      const first = at(b.notes[0]);
      const lastT = at(b.notes.at(-1));
      const long = first && lastT && Date.parse(lastT) - Date.parse(first) >= 2 * 60000;
      const when = `${b.notes[0].time && b.notes[0].time.quality === 'estimated' ? '~' : ''}${first ? hm(first) : '-'}${long ? `\u2013${hm(lastT)}` : ''}`;
      const many = b.notes.length > 1;
      const textLines = [];
      for (const n of b.notes) {
        const resp = responseOf(app.sd.items, n.id);
        const asked = !!resp && resp.active !== false;
        textLines.push(npdfNote(`${many ? '\u2013 ' : ''}${n.text}`, { size: 9.5, bold: asked }));
        if (asked) {
          textLines.push(npdfNote(`${t('pdf.response')} (${resp.state === 'done' ? t('pdf.done') : t('pdf.open')})${resp.text ? `: ${resp.text}` : ''}`, { size: 8.5, bold: true, gray: 0.2 }));
        }
        const task = responseOf(app.sd.items, n.id, 'task');
        if (task && task.active !== false) {
          textLines.push(npdfNote(`${t('pdf.task')} (${task.state === 'done' ? t('pdf.done') : t('pdf.open')})${task.text ? `: ${task.text}` : ''}`, { size: 8.5, gray: 0.2 }));
        }
      }
      f.row([
        { x: 0, w: 24, lines: [npdfNote(when, { bold: true, size: 9 })] },
        { x: 24, w: 32, lines: [npdfNote(p ? callText(p) : '-', { bold: true, size: 9.5 }), ...(p && p.name ? [npdfNote(p.name, { size: 8, gray: 0.35 })] : [])] },
        { x: 56, w: NPDF_W - 56, lines: textLines },
      ]);
    }
    f.skip(2.5);
  }
  if (!sorted.length || !any) f.row([{ x: 0, w: NPDF_W, lines: [npdfNote(t('pdf.emptyLog'), { gray: 0.35 })] }], { rule: false });
  return f.finish(`Netlog - ${t('log.title')} - ${name}`);
}

// ---------- the presence timeline ----------

// How a status looks in black and white: a fill (gray level, 0 black .. 1 white) and an outline.
// Absent (checked out) stations have no bar, so every drawn state differs by more than its tone.
// the stroke of hatching and outlines: pt (as the writer takes it), and half of it in mm
const NPDF_LW = 0.55;
const NPDF_HALF = NPDF_LW / PDF_MM / 2;
const NPDF_HATCH = true; // the states other than active as hatching (else plain tints)
const NPDF_LOOK = {
  active: { gray: [0.1, 0.55, 0.27], tick: 1 },
  listening: { gray: [0.62, 0.8, 0.97], ink: [0.15, 0.4, 0.85], outline: true, tick: 0.1, hatch: ['/', 1.2] },
  unconfirmed: { gray: [0.8, 0.68, 0.9], ink: [0.55, 0.32, 0.75], outline: true, tick: 0.1, hatch: ['|', 1.1] },
  paused: { gray: [1, 0.82, 0.25], ink: [0.8, 0.5, 0], outline: true, tick: 0.1, hatch: ['x', 1.6] },
};

// Hatching in a bar (top left x, y; size w, h): '/' and '\\' diagonals, 'x' both, '|' vertical,
// every `gap` mm in `color`; the lines are cut at the bar's edges.
function npdfHatch(cv, kind, gap, x, y, w, h, color) {
  const opt = { width: NPDF_LW, color };
  cv.clip(x + NPDF_HALF, y + NPDF_HALF, w - 2 * NPDF_HALF, h - 2 * NPDF_HALF); // the lines end at the outline
  const diag = up => {
    for (let c = -h; c <= w; c += gap) {
      const lo = Math.max(0, -c), hi = Math.min(h, w - c);
      if (lo >= hi) continue;
      const px = x + c;
      if (up) cv.line(px + lo, y + h - lo, px + hi, y + h - hi, opt);
      else cv.line(px + lo, y + lo, px + hi, y + hi, opt);
    }
  };
  if (kind === '/' || kind === 'x') diag(true);
  if (kind === 'x') diag(false);
  if (kind === '|') for (let c = gap / 2; c < w; c += gap) cv.line(x + c, y, x + c, y + h, opt);
  cv.unclip();
}

// The outline of a bar, drawn inside its edge: a stroke is centred on the line, so the bar
// keeps the size of a plain one.
function npdfOutline(cv, x, y, w, h, look) {
  const k = NPDF_HALF;
  cv.rect(x + k, y + k, Math.max(w - 2 * k, 0.1), Math.max(h - 2 * k, 0.1), { width: NPDF_LW, dash: look.dash, ...(NPDF_HATCH && look.ink ? { color: look.ink } : {}) });
}

// net control strip: magenta, thin (not red: next to the green bars it is lost for red-green colour blindness; not dark: it read as black)
const NPDF_NCS = [0.72, 0.2, 0.62];

// one station's stretches of presence: [{ status, from, to }] in ms, from its status events
function npdfStretches(app, p, span) {
  const t0 = Date.parse(span.start), t1 = Date.parse(span.end);
  const evs = liveOf(app.sd.events).filter(e => e.type === 'status' && e.participantId === p.id && e.time && e.time.iso)
    .sort((a, b) => (a.time.iso < b.time.iso ? -1 : a.time.iso > b.time.iso ? 1 : 0));
  const first = (p.presence || []).find(iv => iv.from && iv.from.iso);
  let cur = evs.length ? evs[0].from : p.status;
  let at = first ? Math.max(t0, Date.parse(first.from.iso)) : t0;
  const out = [];
  const push = (status, to) => { if (status !== 'out' && to > at) out.push({ status, from: at, to }); };
  for (const e of evs) {
    const ms = Date.parse(e.time.iso);
    push(cur, ms);
    cur = e.to;
    at = Math.max(at, ms);
  }
  push(cur, t1);
  return out;
}

// Who was there when: a row per station with a bar per stretch (dark active, grey monitoring,
// dashed outline paused or unconfirmed), a tick per note on the bar, hours on top.
function npdfTimeline(f, app, roster, span, notes) {
  if (!span.start || !span.end || !roster.length) return;
  const t0 = Date.parse(span.start);
  const t1 = Math.max(Date.parse(span.end), t0 + 60000);
  const labelW = 34, rowH = 7, x0 = NPDF_M + labelW, w = NPDF_W - labelW - 1;
  const X = ms => x0 + ((ms - t0) / (t1 - t0)) * w;
  // who held net control when: from the handovers (before the first, the holder it was taken from)
  const hands = liveOf(app.sd.events).filter(e => e.type === 'ncs' && e.time && e.time.iso)
    .sort((a, b) => (a.time.iso < b.time.iso ? -1 : a.time.iso > b.time.iso ? 1 : 0));
  const ncsRuns = new Map();
  let holder = hands.length ? hands[0].from : app.s.ncsId, since = t0;
  const endRun = to => { if (holder && to > since) ncsRuns.set(holder, [...(ncsRuns.get(holder) || []), [since, to]]); };
  for (const e of hands) { const ms = Math.min(Math.max(Date.parse(e.time.iso), t0), t1); endRun(ms); holder = e.to; since = ms; }
  endRun(t1);
  f.skip(3);
  // whole on one page if it fits on one (it starts on a fresh page rather than being split); else it flows
  const whole = 7.4 + 4.6 + rowH * roster.length + 11;
  f.need(whole <= NPDF_BOTTOM - NPDF_TOP ? whole : rowH * 8 + 20);
  f.bar(t('pdf.timeline'));
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360].map(m => m * 60000);
  const step = steps.find(s => (t1 - t0) / s <= 8) || steps.at(-1);
  const axis = () => {
    const cv = f.cv, y = f.y;
    // the hours in between, then the start and the end of the net in bold (an hour label too
    // close to one of them is left out)
    const near = 10 / w * (t1 - t0);
    for (let ms = Math.ceil(t0 / step) * step; ms <= t1; ms += step) {
      if (ms - t0 < near || t1 - ms < near) continue;
      const x = X(ms);
      cv.line(x, y + 3.2, x, y + 4.4, { width: 0.3, gray: 0.4 });
      cv.text(hm(new Date(ms).toISOString()), x, y + 2.6, { size: 7.5, gray: 0.3, align: 'center' });
    }
    for (const ms of [t0, t1]) {
      cv.line(X(ms), y + 3.2, X(ms), y + 4.4, { width: 0.4 });
      cv.text(hm(new Date(ms).toISOString()), X(ms), y + 2.6, { size: 7.5, bold: true, align: 'center' });
    }
    f.skip(4.6);
  };
  axis();
  for (const p of roster) {
    if (f.y + rowH > NPDF_BOTTOM) { f.need(NPDF_BOTTOM); f.bar(t('pdf.timeline'), t('pdf.continued')); axis(); }
    const cv = f.cv, y = f.y;
    cv.text(callText(p), NPDF_M + 1, y + 4.6, { size: 8.5, bold: true });
    cv.line(x0, y + rowH - 0.5, x0 + w, y + rowH - 0.5, { width: 0.2, gray: 0.75 });
    const stretches = npdfStretches(app, p, span);
    for (const s of stretches) {
      const look = NPDF_LOOK[s.status] || NPDF_LOOK.active;
      const bx = X(s.from), bw = Math.max(X(s.to) - bx, 0.5);
      cv.fill(bx, y + 1.7, bw, rowH - 3.5, NPDF_HATCH && look.hatch ? 1 : look.gray);
      if (NPDF_HATCH && look.hatch) npdfHatch(cv, look.hatch[0], look.hatch[1], bx, y + 1.7, bw, rowH - 3.5, look.ink);
      if (look.dash || look.outline) npdfOutline(cv, bx, y + 1.7, bw, rowH - 3.5, look);
    }
    // net control: a thin magenta strip above the bar
    for (const [a, b] of ncsRuns.get(p.id) || []) cv.fill(X(a), y + 0.6, Math.max(X(b) - X(a), 0.5), 0.6, NPDF_NCS);
    for (const n of notes) {
      if (n.participantId !== p.id || !n.time || !n.time.iso) continue;
      const ms = Date.parse(n.time.iso);
      if (ms >= t0 && ms <= t1) cv.line(X(ms), y + 1.9, X(ms), y + rowH - 2.0, { width: 0.35, gray: (NPDF_LOOK[(stretches.find(s => ms >= s.from && ms <= s.to) || {}).status] || NPDF_LOOK.active).tick });
    }
    f.skip(rowH);
  }
  // the key
  f.need(10);
  f.skip(1.5);
  let lx = NPDF_M + 1;
  const cv = f.cv, y = f.y;
  for (const [st, look] of Object.entries(NPDF_LOOK)) {
    cv.fill(lx, y, 6, 3, NPDF_HATCH && look.hatch ? 1 : look.gray);
    if (NPDF_HATCH && look.hatch) npdfHatch(cv, look.hatch[0], look.hatch[1], lx, y, 6, 3, look.ink);
    if (look.dash || look.outline) npdfOutline(cv, lx, y, 6, 3, look);
    const label = t(`status.${st}`);
    cv.text(label, lx + 7.5, y + 2.6, { size: 7.5 });
    lx += 7.5 + pdfTextWidth(label, 7.5, false) + 5;
  }
  cv.fill(lx, y, 6, 3, NPDF_LOOK.active.gray);
  cv.line(lx + 3, y + 0.3, lx + 3, y + 2.7, { width: 0.35, gray: 1 });
  cv.text(t('pdf.timelineNote'), lx + 7.5, y + 2.6, { size: 7.5 });
  lx += 7.5 + pdfTextWidth(t('pdf.timelineNote'), 7.5, false) + 5;
  cv.fill(lx, y + 0.5, 6, 0.6, NPDF_NCS);
  cv.fill(lx, y + 1.6, 6, 1.6, NPDF_LOOK.active.gray);
  cv.text(t('pdf.ncs'), lx + 7.5, y + 2.6, { size: 7.5 });
  f.skip(6);
}

// ---------- the roster with the facts of the round and series ----------

export function rosterPdf(app) {
  const s = app.s;
  const series = npdfSeriesOf(app);
  const name = npdfNetName(app);
  const f = npdfFlow(`Netlog · ${t('pdf.rosterTitle')}`, name);
  const sorted = roundsSorted(app.sd.rounds);
  const roster = ncsFirst(rosterSorted(app.sd.participants), s.ncsId);
  const ncs = app.sd.participants.find(p => p.id === s.ncsId && !p.deleted) || null;
  const radio = s.radio || {};

  // the session: from the first check-in to the net closed (else the last thing that happened)
  const stamps = [];
  for (const p of app.sd.participants.filter(x => !x.deleted)) for (const iv of p.presence || []) { if (iv.from && iv.from.iso) stamps.push(iv.from.iso); if (iv.to && iv.to.iso) stamps.push(iv.to.iso); }
  for (const n of liveOf(app.sd.notes)) if (n.time && n.time.iso) stamps.push(n.time.iso);
  for (const e of liveOf(app.sd.events)) if (e.time && e.time.iso) stamps.push(e.time.iso);
  stamps.sort();
  const closedEv = liveOf(app.sd.events).filter(e => e.type === 'round' && e.kind === 'closed' && e.time && e.time.iso).map(e => e.time.iso).sort().at(-1) || null;
  const span = { start: stamps[0] || null, end: closedEv || stamps.at(-1) || null, closed: !!closedEv };
  // the last thing recorded for each station (its notes, events, turns)
  const lastSeen = new Map();
  const seen = (pid, iso) => { if (pid && iso && (!lastSeen.get(pid) || iso > lastSeen.get(pid))) lastSeen.set(pid, iso); };
  for (const n of liveOf(app.sd.notes)) seen(n.participantId, n.time && n.time.iso);
  for (const e of liveOf(app.sd.events)) seen(e.participantId, e.time && e.time.iso);
  for (const c of liveOf(app.sd.contributions)) seen(c.participantId, c.time && c.time.iso ? c.time.iso : c.created);
  // one participant's time in the net: the presence intervals; one still open runs to the
  // closing of the net, else to the last thing recorded for that station
  const presence = p => {
    const ivs = (p.presence || []).filter(iv => iv.from && iv.from.iso);
    if (!ivs.length) return { inAt: null, outAt: null, ms: 0 };
    // from the first check-in to the last check-out; a station still in runs to the closing of
    // the net, else to the last thing recorded for it
    const last = ivs.at(-1);
    const end = last.to && last.to.iso ? last.to.iso : span.closed ? span.end : (lastSeen.get(p.id) || ivs[0].from.iso);
    const ms = Date.parse(end) - Date.parse(ivs[0].from.iso);
    return { inAt: ivs[0].from.iso, outAt: last.to && last.to.iso ? last.to.iso : null, ms };
  };

  // A block of facts: a full-width head line, then two columns that each hold facts that belong
  // together (left: when and how much; right: who and how), and a full-width tail for long texts.
  const info = (title, { head = [], left = [], right = [], tail = [] }) => {
    f.bar(title);
    const half = NPDF_W / 2;
    const cell = (x, pair) => (pair && pair[1] ? [
      { x, w: 30, lines: [npdfNote(pair[0], { gray: 0.35, size: 8.5 })] },
      { x: x + 30, w: half - 32, lines: [npdfNote(pair[1], { bold: true, size: 9 })] },
    ] : []);
    const wide = pair => pair[1] && f.row([
      { x: 0, w: 30, lines: [npdfNote(pair[0], { gray: 0.35, size: 8.5 })] },
      { x: 30, w: NPDF_W - 30, lines: [npdfNote(pair[1], { bold: true, size: 10 })] },
    ], { rule: false });
    head.forEach(wide);
    const l = left.filter(([, v]) => v);
    const r = right.filter(([, v]) => v);
    for (let k = 0; k < Math.max(l.length, r.length); k++) f.row([...cell(0, l[k]), ...cell(half, r[k])], { rule: false });
    tail.forEach(wide);
    f.skip(2);
  };
  // start and end as times (the date has its own field); the end carries its date when the net crossed midnight
  const dayOf = iso => splitTime(iso, timeMode()).date;
  const endDay = span.start && span.end && dayOf(span.end) !== dayOf(span.start) ? `${dayOf(span.end)} ` : '';
  const endText = span.end ? `${endDay}${hm(span.end)} ${zone(span.end)}${span.closed ? '' : ` (${t('pdf.lastActivity')})`}` : '';
  info(t('pdf.round'), {
    // the name of the net is in the page head; the series only where the net's name does not already say it
    head: [[t('pdf.seriesShort'), series && !name.includes(series.name) ? series.name : '']],
    left: [
      [t('pdf.date'), s.date],
      [t('pdf.sessionStart'), span.start ? `${hm(span.start)} ${zone(span.start)}` : ''],
      [t('pdf.sessionEnd'), endText],
      [t('pdf.sessionDuration'), span.start && span.end ? npdfDur(Date.parse(span.end) - Date.parse(span.start)) : ''],
      [t('pdf.rounds'), String(sorted.length)],
    ],
    right: [
      [t('pdf.ncs'), ncs ? `${callText(ncs)}${ncs.name ? ` - ${ncs.name}` : ''}` : ''],
      [t('pdf.own'), s.own && s.own.call],
      [t('style.label'), t(`style.short.${netStyle(s)}`)],
      // via a repeater: its call with the frequency and mode in brackets; else the frequency and mode
      radio.repeater
        ? [t('pdf.repeater'), radio.repeater + (radio.freq || radio.mode ? ` (${[radio.freq, radio.mode].filter(Boolean).join(' ')})` : '')]
        : [t('pdf.freq'), [radio.freq, radio.mode].filter(Boolean).join(' ')],
      ...(series ? [[t('pdf.sessionsShort'), String(liveOf(app.data.sessions).filter(x => x.seriesId === series.id).length)]] : []),
    ],
    tail: series ? [[t('series.description'), series.description]] : [],
  });
  f.bar(t('pdf.roster'), t('roster.stats', { n: roster.length, active: roster.filter(p => p.status === 'active').length }));
  const counts = new Map();
  for (const n of liveOf(app.sd.notes)) counts.set(n.participantId, (counts.get(n.participantId) || 0) + 1);
  const heads = [['#', 0, 7], [t('pdf.call'), 7, 34], [t('pdf.name'), 41, 29], [t('station.status'), 70, 33], [t('pdf.in'), 103, 18], [t('pdf.out'), 121, 18], [t('pdf.duration'), 139, 22], [t('pdf.notes'), 162, 13]];
  f.row(heads.map(([h, x, w]) => ({ x, w, lines: [npdfNote(h, { bold: true, size: 8, gray: 0.3, wrap: false })] })));
  // stations that held net control before the current one (the times are in the timeline and the handovers)
  const formerNcs = new Set(liveOf(app.sd.events).filter(e => e.type === 'ncs' && e.from).map(e => e.from));
  roster.forEach((p, i) => {
    const tags = [...(s.ncsId === p.id ? [{ text: 'NCS', solid: true }] : formerNcs.has(p.id) ? [{ text: 'NCS', soft: true }] : []), ...(s.own && s.own.base && p.base === s.own.base ? [{ text: t('own.badge') }] : [])];
    const pr = presence(p);
    const cells = [String(i + 1), callText(p), p.name || '', t(`status.${p.status}`),
      pr.inAt ? hm(pr.inAt) : '', pr.outAt ? hm(pr.outAt) : (pr.inAt ? '-' : ''), pr.inAt ? npdfDur(pr.ms) : '', String(counts.get(p.id) || 0)];
    f.row(heads.map(([, x, w], k) => ({ x, w, lines: [npdfNote(cells[k], { size: k === 1 ? 9.5 : 9, bold: k === 1, gray: k === 0 ? 0.3 : 0, ...(k === 1 ? { tags, wrap: false } : {}) })] })));
  });
  npdfTimeline(f, app, roster, span, liveOf(app.sd.notes));
  const hand = liveOf(app.sd.events).filter(e => e.type === 'ncs').sort((a, b) => (a.created < b.created ? -1 : 1));
  if (hand.length) {
    f.skip(3);
    f.bar(t('control.handovers'));
    for (const e of hand) {
      f.row([
        { x: 0, w: 20, lines: [npdfNote(e.time && e.time.iso ? hm(e.time.iso) : '-', { bold: true, size: 9 })] },
        { x: 20, w: NPDF_W - 20, lines: [npdfNote(eventText(app, e, false), { size: 9 })] },
      ], { rule: false });
    }
  }
  return f.finish(`Netlog - ${t('pdf.rosterTitle')} - ${name}`);
}

// UI: the PDF in a new tab (downloaded where that is blocked).
export function openLogPdf(app) {
  pdfOpen(logPdf(app), `netlog-log-${npdfFileDate(app)}.pdf`);
}

export function openRosterPdf(app) {
  pdfOpen(rosterPdf(app), `netlog-roster-${npdfFileDate(app)}.pdf`);
}
