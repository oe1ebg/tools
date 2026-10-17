// The "Export" card in Net Control: stations and notes as CSV, the
// check-ins as ADIF (what is left out is listed under the button first),
// and a printable report of the session. The files are made by export.js.

import { $, el, fill } from '../../shared/js/dom.js';
import { loadRepeaterIndex } from '../../shared/js/repeaterui.js';
import { splitUtc } from '../../shared/js/time.js';
import { t } from './i18n.js';
import { setText } from './keyed.js';
import { download } from './dataui.js';
import { callText } from './roster.js';
import {
  stationsCsv, notesCsv, netAdif, netAdifIssues, reportData, exportBase,
  NETLOG_ADIF_MIME, NETLOG_CSV_MIME,
} from './export.js';
import { sessionLabel } from './model.js';

let exportRepeaters = null;

function exportSeries(app) {
  return app.s && app.s.seriesId ? app.data.series.find(x => x.id === app.s.seriesId) || null : null;
}

function exportRecords(app) {
  return { session: app.s, ...app.sd };
}

export function initExport(app) {
  loadRepeaterIndex().then(idx => { exportRepeaters = idx ? idx.list : null; if (app.s) renderExport(app); });
  const name = suffix => `${exportBase(app.s, exportSeries(app))}_${suffix}`;
  $('#btn-export-stations').addEventListener('click', () => {
    download(stationsCsv(exportRecords(app), t), name(t('export.file.stations')), NETLOG_CSV_MIME);
    app.announce(t('export.done'));
  });
  $('#btn-export-notes').addEventListener('click', () => {
    download(notesCsv(exportRecords(app), t), name(t('export.file.notes')), NETLOG_CSV_MIME);
    app.announce(t('export.done'));
  });
  $('#btn-export-adif').addEventListener('click', () => {
    const build = globalThis.NETLOG_BUILD || {};
    download(netAdif(exportRecords(app), { repeaters: exportRepeaters, series: exportSeries(app), programVersion: build.commit && build.commit !== 'dev' ? build.commit : '' }),
      name('log.adi'), NETLOG_ADIF_MIME);
    app.announce(t('export.done'));
  });
  $('#btn-export-print').addEventListener('click', () => printSessionReport(app));
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing');
    $('#print-report').hidden = true;
  });
}

// Under the ADIF button: what the file will lack or leave out.
export function renderExport(app) {
  if (!app.s) return;
  const { skipped, problems, info } = netAdifIssues(exportRecords(app), exportRepeaters);
  const items = [
    ...problems.map(k => el('li', {}, t(`export.problem.${k}`))),
    ...skipped.map(s => el('li', {}, t(`export.why.${s.why}`, { call: s.call }))),
  ];
  if (info.modeFromList && info.mode) items.unshift(el('li', { class: 'ok' }, t('export.modeFromList', { mode: info.mode[1] || info.mode[0] })));
  fill($('#export-issues'), items);
  $('#export-issues').hidden = !items.length;
}

// The report fills a hidden section; print styles show only it.
function printSessionReport(app) {
  const series = exportSeries(app);
  const d = reportData(exportRecords(app));
  const ncs = app.participant(app.s.ncsId);
  const hm = time => (time && time.iso ? `${splitUtc(time.iso).time.slice(0, 5)}${time.quality === 'estimated' ? ' ~' : ''}` : '');
  const radio = app.s.radio || {};
  const meta = [
    `${t('report.date')}: ${app.s.date || ''}`,
    ncs ? `${t('report.ncs')}: ${callText(ncs)}` : '',
    radio.repeater ? `${t('session.repeater')}: ${radio.repeater}` : '',
    radio.freq ? `${t('session.freq')}: ${radio.freq}` : '',
    radio.mode ? `${t('session.mode')}: ${radio.mode}` : '',
    app.s.own && app.s.own.call ? `${t('session.own')}: ${app.s.own.call}` : '',
    t('report.times'),
  ].filter(Boolean);
  const stationRows = d.stations.map(p => {
    const first = (p.presence || []).find(x => x.from && x.from.iso);
    return el('tr', {},
      el('td', { class: 'mono' }, callText(p)), el('td', {}, p.name || ''), el('td', {}, p.qth || ''),
      el('td', {}, t(`status.${p.status}`)), el('td', { class: 'mono' }, first ? hm(first.from) : ''));
  });
  const rounds = d.rounds.map(r => el('section', { class: 'rp-round' },
    el('h3', {}, `${t('round.indicator', { n: r.number })}${r.topic ? ` · ${r.topic}` : ''}`),
    r.groups.length ? r.groups.map(g => el('div', { class: 'rp-group' },
      el('h4', { class: 'mono' }, g.p ? `${callText(g.p)}${g.p.name ? ` · ${g.p.name}` : ''}` : '?'),
      el('ul', {}, g.notes.map(n => el('li', {}, el('span', { class: 'mono rp-time' }, hm(n.time)), ' ', n.text))))) : el('p', { class: 'hint' }, t('report.emptyRound'))));
  fill($('#print-report'),
    el('h1', {}, `Netlog · ${sessionLabel(app.s, series) || t('report.adhoc')}`),
    el('p', { class: 'rp-meta' }, meta.join(' · ')),
    el('h2', {}, t('report.stations', { n: d.stations.length })),
    el('table', { class: 'rp-table' },
      el('thead', {}, el('tr', {}, ['call', 'name', 'qth', 'status', 'checkinTime'].map(k => el('th', { scope: 'col' }, t(`export.col.${k}`))))),
      el('tbody', {}, stationRows)),
    el('h2', {}, t('report.rounds')),
    rounds);
  $('#print-report').hidden = false;
  document.body.classList.add('printing');
  window.print();
}
