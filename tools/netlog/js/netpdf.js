// Netlog as PDF (the shared writer, A4 portrait, black on white, 9-10 pt):
//   logPdf(app)     the Continuous Log: every round with its notes and
//                   events in recorded order, the full text, replies
//   rosterPdf(app)  the Net Control roster with the facts of the round, the
//                   session and its series, and the net control handovers
// Times follow the time mode of the page (UTC or local, the zone in the
// header). Text is WinAnsi: arrows and symbols of the screen are written as
// words or ASCII.

import { PDF_A4_PORTRAIT, pdfCanvas, pdfDocument, pdfWrap, pdfOpen } from '../../shared/js/pdf.js';
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
          cv.text(l.t, NPDF_M + c.x, y + NPDF_PAD + NPDF_PITCH * (k + 0.78), { size: l.size || 9, bold: !!l.bold, gray: l.gray || 0 });
        }));
        y += n * NPDF_PITCH + 2 * NPDF_PAD;
        if (n >= total) { if (rule) cv.line(NPDF_M, y, NPDF_PAGE.width - NPDF_M, y, { width: 0.3, gray: 0.6 }); return; }
        cells.forEach(c => { c.lines = c.lines.slice(n); });
        newPage();
      }
    },
    finish(docTitle) {
      pages.forEach((p, i) => {
        p.text(npdfPlain(title), NPDF_M, NPDF_PAGE.height - NPDF_M + 0.5, { size: 8, gray: 0.3 });
        p.text(t('pdf.page', { n: i + 1, total: pages.length }), NPDF_PAGE.width - NPDF_M, NPDF_PAGE.height - NPDF_M + 0.5, { size: 9, align: 'right' });
      });
      return pdfDocument(NPDF_PAGE, pages.map(p => p.ops.join('\n')), npdfPlain(docTitle));
    },
  };
  return api;
}

const npdfNote = (txt, o = {}) => ({ t: txt, ...o });

// "56 min", "1 h 05 min" for a span in ms; "-" for none or for more than a day
// (a net does not run that long: the data is then not a continuous session)
const npdfDur = ms => {
  if (!(ms > 0) || ms > 24 * 3600000) return '-';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
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

// ---------- the roster with the facts of the round and series ----------

export function rosterPdf(app) {
  const s = app.s;
  const series = npdfSeriesOf(app);
  const name = npdfNetName(app);
  const f = npdfFlow(`Netlog · ${t('pdf.rosterTitle')}`, `${name} · ${s.date || ''} · ${t('pdf.times', { zone: zone() })}`);
  const sorted = roundsSorted(app.sd.rounds);
  const cur = sorted.find(r => r.id === s.currentRoundId) || sorted.at(-1) || null;
  const roster = ncsFirst(rosterSorted(app.sd.participants), s.ncsId);
  const ncs = app.sd.participants.find(p => p.id === s.ncsId && !p.deleted) || null;
  const radio = s.radio || {};
  const dash = v => (v ? String(v) : '-');

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
    let ms = 0;
    for (const iv of ivs) {
      const to = iv.to && iv.to.iso ? iv.to.iso : span.closed ? span.end : (lastSeen.get(p.id) || iv.from.iso);
      ms += Math.max(0, Date.parse(to) - Date.parse(iv.from.iso));
    }
    const last = ivs.at(-1);
    return { inAt: ivs[0].from.iso, outAt: last.to && last.to.iso ? last.to.iso : null, ms };
  };

  // label / value pairs in two blocks side by side, one page-wide when long
  const info = (title, pairs) => {
    f.bar(title);
    const half = NPDF_W / 2;
    const cell = (x, [label, value]) => [
      { x, w: 30, lines: [npdfNote(label, { gray: 0.35, size: 8.5 })] },
      { x: x + 30, w: half - 32, lines: [npdfNote(value, { bold: true, size: 9 })] },
    ];
    let pending = null;
    const flush = () => { if (pending) { f.row(cell(0, pending), { rule: false }); pending = null; } };
    for (const pair of pairs.filter(([, v]) => v)) {
      if (String(pair[1]).length > 60) { // a long text takes the whole width
        flush();
        f.row([{ x: 0, w: 30, lines: [npdfNote(pair[0], { gray: 0.35, size: 8.5 })] }, { x: 30, w: NPDF_W - 30, lines: [npdfNote(pair[1], { bold: true, size: 9 })] }], { rule: false });
      } else if (pending) { f.row([...cell(0, pending), ...cell(half, pair)], { rule: false }); pending = null; } else pending = pair;
    }
    flush();
    f.skip(2);
  };
  info(t('pdf.round'), [
    [t('pdf.net'), name],
    [t('pdf.date'), s.date],
    [t('pdf.currentRound'), cur ? [t('round.indicator', { n: cur.number }), cur.topic].filter(Boolean).join(' · ') : ''],
    [t('pdf.rounds'), String(sorted.length)],
    [t('pdf.notes'), String(liveOf(app.sd.notes).length)],
    [t('pdf.sessionStart'), span.start ? `${splitTime(span.start, timeMode()).date} ${hm(span.start)} ${zone(span.start)}` : ''],
    [t('pdf.sessionEnd'), span.end ? `${hm(span.end)} ${zone(span.end)}${span.closed ? '' : ` (${t('pdf.lastActivity')})`}` : ''],
    [t('pdf.sessionDuration'), span.start && span.end ? npdfDur(Date.parse(span.end) - Date.parse(span.start)) : ''],
    [t('session.repeater'), radio.repeater],
    [t('session.freq'), radio.freq],
    [t('session.mode'), radio.mode],
    [t('style.label'), t(`style.short.${netStyle(s)}`)],
    [t('pdf.ncs'), ncs ? `${callText(ncs)}${ncs.name ? ` - ${ncs.name}` : ''}` : ''],
    [t('pdf.own'), s.own && s.own.call],
  ]);
  if (series) {
    const d = series.defaults || {};
    info(t('pdf.series'), [
      [t('series.name'), series.name],
      [t('series.description'), series.description],
      [t('series.schedule'), series.schedule],
      [t('series.ncs'), d.ncs],
      [t('session.repeater'), d.repeater],
      [t('session.freq'), d.freq],
      [t('session.mode'), d.mode],
      [t('pdf.sessionsInSeries'), String(liveOf(app.data.sessions).filter(x => x.seriesId === series.id).length)],
    ]);
  }

  f.bar(t('pdf.roster'), t('roster.stats', { n: roster.length, active: roster.filter(p => p.status === 'active').length }));
  const counts = new Map();
  for (const n of liveOf(app.sd.notes)) counts.set(n.participantId, (counts.get(n.participantId) || 0) + 1);
  const heads = [['#', 0, 7], [t('pdf.call'), 7, 26], [t('pdf.name'), 33, 36], [t('station.status'), 69, 34], [t('pdf.in'), 103, 18], [t('pdf.out'), 121, 18], [t('pdf.duration'), 139, 22], [t('pdf.notes'), 162, 13]];
  f.row(heads.map(([h, x, w]) => ({ x, w, lines: [npdfNote(h, { bold: true, size: 8, gray: 0.3, wrap: false })] })));
  roster.forEach((p, i) => {
    const role = [s.ncsId === p.id ? 'NCS' : '', s.own && s.own.base && p.base === s.own.base ? t('own.badge') : ''].filter(Boolean).join(', ');
    const pr = presence(p);
    const cells = [String(i + 1), callText(p), p.name || '', `${t(`status.${p.status}`)}${role ? ` (${role})` : ''}`,
      pr.inAt ? hm(pr.inAt) : '', pr.outAt ? hm(pr.outAt) : (pr.inAt ? '-' : ''), pr.inAt ? npdfDur(pr.ms) : '', String(counts.get(p.id) || 0)];
    f.row(heads.map(([, x, w], k) => ({ x, w, lines: [npdfNote(cells[k], { size: k === 1 ? 9.5 : 9, bold: k === 1, gray: k === 0 ? 0.3 : 0 })] })));
  });
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
