// The print-only sheet (#print-sheet): the Meldeaufnahmeformular of one
// message or the message book of a time range, built with el() from the
// data of print.js, then window.print(). The layout is in style.css (the
// .pf-* and .pb-* rules, A4); "Als PDF sichern" in the print dialog makes
// the PDF.
//
// The form is one A4 page: white, thin lines, no filled areas (nothing
// depends on printed backgrounds, so it also reads in black and white and
// saves toner). A circle = choose exactly one (channel, urgency, type), a
// square = an extra mark (Stab herhören!, Rücklesen). The chosen direction
// gets a thick frame and an ✕, the other one is pale.
//
// One page: fitForm() measures the sheet off-screen at the printed width.
// A long text first gets tighter spacing and a smaller font (down to
// 10 pt, never less); if it still doesn't fit, the sheet flows over
// several pages, each starting with the number, and app.js says so before
// printing. The form page has no page margin (printSheet() sets the margin
// of style.css's @page rule to 0 while it prints), which also keeps
// Chrome's and Edge's header and footer lines (URL, date, page number) off
// it. Not a named page: Safari accepts `page:` (CSS.supports says yes) but
// prints with the default page's margins. Where the @page rule can't be
// reached, the form prints with the normal page margins (html.pf-margins:
// the sheet is sized to the smaller area). The sheet's size is Safari's A4
// page (WebKit prints 1 CSS px as 0.8 pt: 197 × 278 mm in CSS units, see
// style.css), which also fits Chrome's and Firefox's full 210 × 297 mm.

import { $, el, fill } from '../../shared/js/dom.js';

function box(checked, label) {
  return el('span', { class: 'pf-opt' },
    el('span', { class: checked ? 'pf-box on' : 'pf-box', 'aria-hidden': 'true' }, checked ? '✕' : ''),
    el('span', { class: 'sr-only' }, checked ? 'angekreuzt: ' : ''),
    label);
}

function dot(checked, label) {
  return el('span', { class: checked ? 'pf-opt on' : 'pf-opt' },
    el('span', { class: checked ? 'pf-dot on' : 'pf-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'sr-only' }, checked ? 'gewählt: ' : ''),
    label);
}

const DIR_ARROW = { in: '↓', out: '↑' };

function cap(text) {
  return el('span', { class: 'pf-cap' }, text);
}

function cell(label, ...content) {
  return el('div', { class: 'pf-cell' }, cap(label), ...content);
}

function val(text, cls = 'pf-val') {
  return el('div', { class: cls }, text || ' ');
}

function directionTiles(s) {
  return el('div', { class: 'pf-dirrow' }, ...s.directions.map(d => el('div', { class: `pf-dir${s.blank ? '' : d.checked ? ' on' : ' off'}` },
    el('span', { class: 'pf-box', 'aria-hidden': 'true' }, d.checked ? '✕' : ''),
    el('span', { class: 'pf-dir-arrow', 'aria-hidden': 'true' }, DIR_ARROW[d.key] || ''),
    d.checked ? el('span', { class: 'sr-only' }, 'gewählt: ') : null,
    d.label.toUpperCase())));
}

function staffBlock(s) {
  const field = (label, value = '') => el('div', {}, cap(label), el('span', { class: 'pf-line' }, value));
  return el('section', { class: 'pf-staff', 'aria-label': 'Nur von der Meldesammelstelle / dem Stab auszufüllen' },
    el('div', { class: 'pf-staff-head' }, 'Nur von der Meldesammelstelle / dem Stab auszufüllen'),
    el('div', { class: 'pf-staff-grid' },
      field('Referenz / Geschäftsbuch-Nr.', s.staffRef), field('Federführend'), field('Mitwirkend'), field('Zur Kenntnis')));
}

function whenCell(s) {
  if (s.blank) {
    return el('div', { class: 'pf-cell pf-inline' }, cap(s.timeLabel),
      el('span', { class: 'pf-val pf-full' }, 'Datum ____________ Uhrzeit ________'),
      box(false, 'MEZ'), box(false, 'MESZ'), box(false, 'UTC'));
  }
  return el('div', { class: 'pf-cell pf-inline' }, cap(s.timeLabel),
    el('span', { class: 'pf-val pf-strong' }, `${s.date} · ${s.time} ${s.zone}`),
    el('span', { class: 'pf-small' }, `${s.utc} · erfasst ${s.created}`));
}

function priorityCell(s) {
  return el('div', { class: 'pf-cell pf-inline' }, cap('Dringlichkeit'),
    el('span', { class: 'pf-prio' }, ...s.priorities.map(p => dot(p.checked, p.label))),
    el('span', { class: 'pf-alarm' }, box(s.alarm, 'Stab herhören!')),
    s.alarmDone ? el('span', { class: 'pf-small' }, `angesagt ${s.alarmDone}`) : null);
}

export function renderFormSheet(s) {
  const peerLine = side => (s.blank || (side === 'from') === (s.direction !== 'out'))
    ? el('div', { class: 'pf-small' }, `Gegenstelle: ${s.peer}`) : null;
  return el('article', { class: s.blank ? 'pf-sheet blank' : 'pf-sheet' },
    el('header', { class: 'pf-top' },
      el('div', { class: 'pf-titlebox' },
        el('div', { class: 'pf-cap' }, ['ÖVSV Notfunk', s.title, s.station].filter(Boolean).join(' · ')),
        el('div', { class: 'pf-title' }, 'Meldeaufnahmeformular')),
      directionTiles(s),
      el('div', { class: 'pf-numbox' }, cap('Notfunk-Nr.'), el('b', { class: 'pf-num' }, s.number),
        s.deleted ? el('div', { class: 'pf-cap' }, 'gelöscht') : null)),
    staffBlock(s),
    el('div', { class: 'pf-row pf-ab pf-first' },
      whenCell(s),
      el('div', { class: 'pf-cell pf-inline' }, cap('Übermittlung'),
        ...s.channels.map(c => dot(c.checked, c.key === 'anders' && s.channelOther ? `anders: ${s.channelOther}` : c.label)))),
    el('div', { class: 'pf-row pf-ab' },
      priorityCell(s),
      el('div', { class: 'pf-cell pf-inline' }, cap('Meldungsart'),
        ...(s.blank ? s.types.map(t => dot(false, t)) : [el('span', { class: 'pf-val' }, s.type)]))),
    el('div', { class: 'pf-row pf-2' },
      cell('Von (Absender)', val(s.from), peerLine('from')),
      cell('An (Adressat)', val(s.to), peerLine('to'), el('div', { class: 'pf-small' }, `Verteiler: ${s.distribution}`))),
    el('div', { class: 'pf-row pf-3' },
      cell('Betreff', val(s.subject, 'pf-val pf-strong')),
      cell('Ort / Einsatzstelle', val(s.location)),
      cell('Bezug', val(s.ref))),
    el('div', { class: 'pf-text' },
      cap('Inhalt – wörtlich, wie übermittelt'),
      s.blank ? el('div', { class: 'pf-write' }) : el('p', {}, s.text || '–'),
      el('div', { class: 'pf-small' }, box(s.readBack, s.readBackLabel), s.extra ? ` · ${s.extra}` : '')),
    el('div', { class: 'pf-row pf-2' },
      cell('Aufgenommen von (Name / Unterschrift)', val(s.operator)),
      cell('Anmerkungen / weitere Veranlassung', val(s.remarks))),
    el('div', { class: 'pf-row pf-4' },
      ...s.handoverHeads.map((h, i) => cell(h,
        i === 3 && s.direction !== 'out' ? el('div', { class: 'pf-val' }, box(s.handoverDone, s.handover[3] || ' ')) : val(s.handover[i])))),
    el('footer', { class: 'pf-foot' },
      el('span', {}, s.blank ? `Notfunk-Meldebuch · Vordruck, gedruckt ${s.printed}` : `Notfunk-Meldebuch · Status ${s.status} · gedruckt ${s.printed}`),
      el('span', {}, s.blank ? 'Blatt ____' : `Fassung ${s.version}`)));
}

const MM = 96 / 25.4;
// fit levels (style.css .pf-sheet.fit-1 … fit-3): tighter, then 11 / 10.5 / 10 pt
const FIT_LEVELS = 3;

// The @page rule of style.css (there is only one), or null where the
// browser doesn't expose it.
function pageRule() {
  if (!globalThis.CSSPageRule) return null;
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) if (rule instanceof CSSPageRule) return rule;
  }
  return null;
}

// How the form fits: { level, pages }. level 0 = as designed; pages > 1 =
// it doesn't fit on one page even at the smallest readable size.
export function fitForm(sheet) {
  // The sheet's printed height (style.css): Safari's A4 page without page
  // margin (the sheet keeps the margins as padding), or the area inside the
  // page margins (12 mm, 14 mm).
  const noMargin = !!pageRule();
  const pageH = (noMargin ? 276 : 252) * MM;
  document.documentElement.classList.toggle('pf-margins', !noMargin);
  const probe = el('div', { class: 'pf-measure', 'aria-hidden': 'true' });
  document.body.append(probe);
  probe.append(sheet);
  let result = null;
  for (let level = 0; level <= FIT_LEVELS && !result; level++) {
    sheet.classList.remove(`fit-${level - 1}`);
    if (level) sheet.classList.add(`fit-${level}`);
    if (sheet.scrollHeight <= pageH) result = { level, pages: 1 };
  }
  if (!result) result = { level: FIT_LEVELS, pages: Math.ceil(sheet.scrollHeight / ((297 - 24) * MM)) };
  probe.remove();
  return result;
}

// The form with its fit applied: one page as measured, or the multi-page
// flow (page margins, the number repeated at the top of each page).
export function fittedFormSheet(data) {
  const sheet = renderFormSheet(data);
  const fit = fitForm(sheet);
  if (fit.pages === 1) return { node: sheet, fit };
  sheet.classList.add('multi');
  const head = `Meldeaufnahmeformular ${data.number} · ${data.title}`;
  const node = el('table', { class: 'pf-pages' },
    el('thead', {}, el('tr', {}, el('td', { class: 'pf-cap' }, head))),
    el('tbody', {}, el('tr', {}, el('td', {}, sheet))));
  return { node, fit };
}

export function renderBookSheet(b) {
  return el('article', { class: 'pb-sheet' },
    el('header', { class: 'pb-head' },
      el('div', {},
        el('div', { class: 'pf-cap' }, ['ÖVSV Notfunk', b.station].filter(Boolean).join(' · ')),
        el('div', { class: 'pf-title' }, `Meldebuch ${b.title}`)),
      el('div', { class: 'pf-small' }, `${b.range}`, el('br'), `gedruckt ${b.printed}`)),
    b.rows.length ? el('table', { class: 'pb-table' },
      el('thead', {}, el('tr', {}, ...['Nr.', 'Referenz', 'Datum', 'Uhrzeit', 'Ein/Aus', 'von / an', 'Betreff · Inhalt', 'Art, Dringl.', 'Status', 'Op'].map(h => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, ...b.rows.map(r => el('tr', {},
        el('td', { class: 'pb-num' }, r.number),
        el('td', {}, r.staffRef),
        el('td', {}, r.date),
        el('td', {}, r.time),
        el('td', {}, r.direction),
        el('td', {}, r.party),
        el('td', {}, el('b', {}, r.alarm ? 'STAB HERHÖREN! ' : '', r.subject), r.text ? el('div', { class: 'pb-text' }, r.text) : null),
        el('td', {}, r.type, r.priority ? el('div', { class: 'pb-prio' }, r.priority) : null),
        el('td', {}, r.status),
        el('td', {}, r.operator)))))
      : el('p', {}, 'Keine Meldungen in diesem Zeitraum.'));
}

// Puts the sheet in place and opens the print dialog; the sheet is removed
// again afterwards (it is print-only, but stale content would confuse a
// later browser-menu print). kind: 'form' (one page, no page margin) or
// 'book' (the book, or a form over several pages: normal page margins).
export function printSheet(node, kind) {
  const sheet = $('#print-sheet');
  fill(sheet, node);
  document.documentElement.dataset.print = kind;
  const rule = kind === 'form' ? pageRule() : null;
  const margin = rule?.style.margin;
  if (rule) rule.style.margin = '0';
  document.documentElement.classList.toggle('pf-margins', kind === 'form' && !rule);
  const done = () => {
    fill(sheet);
    if (rule) rule.style.margin = margin;
    delete document.documentElement.dataset.print;
    globalThis.removeEventListener('afterprint', done);
  };
  globalThis.addEventListener('afterprint', done);
  globalThis.print();
}
