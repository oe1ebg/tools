// The print-only sheet (#print-sheet): the Meldeaufnahmeformular of one
// message or the message book of a time range, built with el() from the
// data of print.js, then window.print(). The layout is in style.css
// (@media print, A4); "Als PDF sichern" in the print dialog makes the PDF.

import { $, el, fill } from '../../shared/js/dom.js';

function box(checked, label, detail) {
  return el('span', { class: 'pf-opt' },
    el('span', { class: checked ? 'pf-box on' : 'pf-box', 'aria-hidden': 'true' }, checked ? '✕' : ''),
    el('span', { class: 'sr-only' }, checked ? 'angekreuzt: ' : ''),
    label, detail ? el('span', { class: 'pf-detail' }, ` ${detail}`) : null);
}

function cell(label, ...content) {
  return el('div', { class: 'pf-cell' }, el('span', { class: 'pf-cap' }, label), ...content);
}

export function renderFormSheet(s) {
  return el('article', { class: s.blank ? 'pf-sheet blank' : 'pf-sheet' },
    el('header', { class: 'pf-head' },
      el('div', {},
        el('div', { class: 'pf-cap' }, ['ÖVSV Notfunk', s.title].filter(Boolean).join(' · ')),
        el('div', { class: 'pf-title' }, 'Meldeaufnahmeformular')),
      el('div', { class: 'pf-number' },
        el('div', { class: 'pf-cap' }, 'Notfunk-Nr.'),
        s.blank ? el('div', { class: 'pf-num pf-write' }) : el('div', { class: 'pf-num' }, s.number),
        s.deleted ? el('div', { class: 'pf-cap' }, 'GELÖSCHT') : null)),
    el('div', { class: 'pf-row pf-4' },
      cell('Richtung', ...s.directions.map(d => box(d.checked, d.label))),
      cell('Datum', el('span', { class: 'pf-val' }, s.date)),
      cell('Uhrzeit', el('span', { class: 'pf-val' }, s.time), el('span', { class: 'pf-small' }, s.blank ? 'MEZ / MESZ / UTC' : s.utc)),
      s.blank
        ? cell('Priorität', ...s.priorities.map(p => box(false, p.label)), box(false, el('b', {}, 'Stab herhören!')))
        : el('div', { class: s.urgent || s.alarm ? 'pf-cell pf-prio urgent' : 'pf-cell pf-prio' },
          el('span', { class: 'pf-cap' }, 'Priorität'),
          el('span', { class: 'pf-val' }, s.priority),
          s.alarm ? el('span', { class: 'pf-alarm' }, 'STAB HERHÖREN!') : null)),
    el('div', { class: 'pf-row' },
      cell('Übermittlung', el('span', { class: 'pf-opts' }, ...s.channels.map(c => box(c.checked, c.label, c.detail))))),
    el('div', { class: 'pf-row pf-2' },
      cell('Von', el('span', { class: 'pf-val' }, s.from)),
      cell('An', el('span', { class: 'pf-val' }, s.to))),
    el('div', { class: 'pf-row' },
      s.blank
        ? cell('Betreff', el('span', { class: 'pf-opts' }, ...s.types.map(t => box(false, t))), el('span', { class: 'pf-write' }))
        : cell('Betreff', el('span', { class: 'pf-val pf-subject' }, s.subject || '–', el('span', { class: 'pf-small' }, ` (${s.type})`)))),
    el('div', { class: 'pf-row pf-grow' },
      el('div', { class: 'pf-cell pf-text' },
        s.blank
          ? el('span', { class: 'pf-cap' }, 'Inhalt – wörtlich · ', box(false, 'rückgelesen'))
          : el('span', { class: 'pf-cap' }, `Inhalt – wörtlich${s.readBack ? ', rückgelesen ✓' : ''}`),
        el('p', {}, s.blank ? '' : s.text || '–'),
        el('div', { class: 'pf-small' }, [
          s.stichzeit ? `Stichzeit ${s.stichzeit}` : '',
          s.origin ? `Ursprung: ${s.origin}` : '',
          s.location ? `Standort: ${s.location}` : '',
          s.replyTo ? `Antwort auf ${s.replyTo}` : '',
        ].filter(Boolean).join(' · ')))),
    el('div', { class: 'pf-row pf-2' },
      cell('Aufgenommen von (Name / Unterschrift)', el('span', { class: 'pf-val' }, s.operator)),
      cell('Anmerkungen / weitere Veranlassung', el('span', { class: 'pf-val' }, s.remarks))),
    el('div', { class: 'pf-row' },
      el('div', { class: 'pf-cell pf-staff' },
        el('span', { class: 'pf-cap' }, 'Vom Stab auszufüllen: Geschäftszahl, Auszeichnung'),
        el('div', { class: 'pf-lines' },
          ...['GZ', 'federführend', 'mitwirkend / z. K.'].flatMap(l => [el('span', {}, l), el('span', { class: 'pf-line' })])))),
    el('footer', { class: 'pf-foot' },
      el('span', {}, s.blank ? `Notfunk-Meldebuch · Vordruck, gedruckt ${s.printed}` : `Notfunk-Meldebuch · Status ${s.status} · gedruckt ${s.printed}`),
      el('span', {}, s.blank ? 'Blatt ____' : `Fassung ${s.version}`)));
}

export function renderBookSheet(b) {
  return el('article', { class: 'pb-sheet' },
    el('header', { class: 'pf-head' },
      el('div', {},
        el('div', { class: 'pf-cap' }, ['ÖVSV Notfunk', b.station].filter(Boolean).join(' · ')),
        el('div', { class: 'pf-title' }, `Meldebuch ${b.title}`)),
      el('div', { class: 'pf-small' }, `${b.range}`, el('br'), `gedruckt ${b.printed}`)),
    b.rows.length ? el('table', { class: 'pb-table' },
      el('thead', {}, el('tr', {}, ...['Nr.', 'Datum', 'Uhrzeit', 'Ein/Aus', 'von / an', 'Betreff · Inhalt', 'Art, Prio.', 'Status', 'Op'].map(h => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, ...b.rows.map(r => el('tr', {},
        el('td', { class: 'pb-num' }, r.number),
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
// later browser-menu print).
export function printSheet(node, kind) {
  const sheet = $('#print-sheet');
  fill(sheet, node);
  document.documentElement.dataset.print = kind;
  const done = () => {
    fill(sheet);
    delete document.documentElement.dataset.print;
    globalThis.removeEventListener('afterprint', done);
  };
  globalThis.addEventListener('afterprint', done);
  globalThis.print();
}
