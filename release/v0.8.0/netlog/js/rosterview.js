// The roster report on the page (Net Control): the roster table with in / out / duration and
// the presence timeline, as in the roster PDF (both use rosterData()). A collapsed widget of its
// own, separate from the roster list above it; built only while it is open.

import { $, el, fill } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { hm, zone } from './clock.js';
import { callText } from './roster.js';
import { rosterData, rosterDur } from './rosterdata.js';

const RV_NS = 'http://www.w3.org/2000/svg';
const rvSvg = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(RV_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids);
  return n;
};

// states drawn as hatching (the rest is a plain fill); the pattern lines per kind, in a 7 x 7 tile
const RV_HATCH = {
  listening: 'M0 7 L7 0 M-1 1 L1 -1 M6 8 L8 6',
  paused: 'M0 7 L7 0 M-1 1 L1 -1 M6 8 L8 6 M0 0 L7 7 M-1 6 L1 8 M6 -1 L8 1',
  unconfirmed: 'M3.5 0 V7',
};
const RV_STATES = ['active', 'listening', 'paused', 'unconfirmed'];

// one bar (top left x, y; size w, h): solid, or a white bar with hatching and an outline inside
function rvBar(x, y, w, h, status) {
  if (!RV_HATCH[status]) return rvSvg('rect', { x, y, width: w, height: h, class: 'rr-bar rr-active' });
  return rvSvg('g', { class: `rr-hatched rr-${status}` },
    rvSvg('rect', { x, y, width: w, height: h, class: 'rr-bg' }),
    rvSvg('rect', { x, y, width: w, height: h, fill: `url(#rr-pat-${status})`, class: 'rr-hatch' }),
    rvSvg('rect', { x: x + 0.75, y: y + 0.75, width: Math.max(w - 1.5, 0.5), height: h - 1.5, class: 'rr-outline' }));
}

function rvPatterns() {
  return rvSvg('defs', {}, ...Object.entries(RV_HATCH).map(([st, d]) => rvSvg('pattern', { id: `rr-pat-${st}`, width: 7, height: 7, patternUnits: 'userSpaceOnUse' },
    rvSvg('path', { d, class: `rr-line rr-${st}` }))));
}

const rvTime = ms => hm(new Date(ms).toISOString());

function rvTable(data) {
  const heads = ['#', t('pdf.call'), t('pdf.name'), t('station.status'), t('pdf.in'), t('pdf.out'), t('pdf.duration'), t('pdf.notes')];
  const tag = (text, cls) => el('span', { class: `rr-tag ${cls}` }, text);
  return el('div', { class: 'rr-scroll' }, el('table', { class: 'rr-table' },
    el('caption', { class: 'sr-only' }, t('rr.title')),
    el('thead', {}, el('tr', {}, heads.map(h => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, data.rows.map((r, i) => el('tr', {},
      el('td', { class: 'rr-no' }, String(i + 1)),
      el('td', {}, el('b', { class: 'call mono' }, callText(r.p)),
        r.ncs ? [' ', tag('NCS', r.ncs === 'current' ? 'ncs' : 'ncs-former')] : null,
        r.me ? [' ', tag(t('own.badge'), 'me')] : null),
      el('td', {}, r.p.name || ''),
      el('td', {}, t(`status.${r.p.status}`)),
      el('td', { class: 'mono' }, r.inAt ? hm(r.inAt) : ''),
      el('td', { class: 'mono' }, r.outAt ? hm(r.outAt) : (r.inAt ? '-' : '')),
      el('td', { class: 'mono' }, r.inAt ? rosterDur(r.ms) : ''),
      el('td', { class: 'mono' }, String(r.notes)))))));
}

function rvChart(chart) {
  const W = 1000, labelW = 104, padR = 26, axisH = 24, rowH = 26, barY = 7, barH = 14;
  const x0 = labelW, w = W - labelW - padR;
  const H = axisH + chart.rows.length * rowH + 4;
  const { t0, t1 } = chart;
  const X = ms => x0 + ((ms - t0) / (t1 - t0)) * w;
  const root = rvSvg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rr-chart', role: 'img', 'aria-labelledby': 'rr-chart-title rr-chart-desc' },
    rvSvg('title', { id: 'rr-chart-title' }, t('pdf.timeline')),
    rvSvg('desc', { id: 'rr-chart-desc' }, t('rr.chartDesc')),
    rvPatterns());
  // the axis: the hours in between, the start and the end of the net in bold
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360].map(m => m * 60000);
  const step = steps.find(s => (t1 - t0) / s <= 8) || steps.at(-1);
  const near = 46 / w * (t1 - t0);
  const tick = (ms, edge) => root.append(
    rvSvg('line', { x1: X(ms), y1: axisH - 6, x2: X(ms), y2: axisH - 1, class: `rr-tick-mark${edge ? ' edge' : ''}` }),
    rvSvg('text', { x: X(ms), y: axisH - 10, 'text-anchor': 'middle', class: `rr-axis${edge ? ' edge' : ''}` }, rvTime(ms)));
  for (let ms = Math.ceil(t0 / step) * step; ms <= t1; ms += step) if (ms - t0 >= near && t1 - ms >= near) tick(ms, false);
  tick(t0, true);
  tick(t1, true);
  chart.rows.forEach((row, i) => {
    const y = axisH + i * rowH;
    root.append(
      rvSvg('text', { x: 4, y: y + barY + barH - 3, class: 'rr-call' }, callText(row.p)),
      rvSvg('line', { x1: x0, y1: y + rowH - 1, x2: x0 + w, y2: y + rowH - 1, class: 'rr-rule' }));
    for (const s of row.stretches) {
      const bx = X(s.from), bw = Math.max(X(s.to) - bx, 2);
      const bar = rvBar(bx, y + barY, bw, barH, s.status);
      bar.append(rvSvg('title', {}, `${callText(row.p)} · ${t(`status.${s.status}`)} · ${rvTime(s.from)}–${rvTime(s.to)}`));
      root.append(bar);
    }
    for (const [a, b] of row.ncs) root.append(rvSvg('rect', { x: X(a), y: y + barY - 4, width: Math.max(X(b) - X(a), 2), height: 3, class: 'rr-ncs' }));
    for (const ms of row.notes) {
      const st = (row.stretches.find(s => ms >= s.from && ms <= s.to) || {}).status;
      root.append(rvSvg('line', { x1: X(ms), y1: y + barY + 2, x2: X(ms), y2: y + barY + barH - 2, class: `rr-note${RV_HATCH[st] ? ' on-light' : ''}` }));
    }
  });
  return root;
}

// the key: a swatch and the word for each state, the note tick and the net control strip (the
// hatch patterns are those of the chart above it)
function rvLegend() {
  const swatch = (status) => {
    const s = rvSvg('svg', { viewBox: '0 0 24 12', width: 24, height: 12, 'aria-hidden': 'true', class: 'rr-swatch' });
    s.append(rvBar(0, 0, 24, 12, status));
    return s;
  };
  const note = rvSvg('svg', { viewBox: '0 0 24 12', width: 24, height: 12, 'aria-hidden': 'true', class: 'rr-swatch' },
    rvBar(0, 0, 24, 12, 'active'), rvSvg('line', { x1: 12, y1: 2, x2: 12, y2: 10, class: 'rr-note' }));
  const ncs = rvSvg('svg', { viewBox: '0 0 24 12', width: 24, height: 12, 'aria-hidden': 'true', class: 'rr-swatch' },
    rvSvg('rect', { x: 0, y: 0, width: 24, height: 3, class: 'rr-ncs' }), rvBar(0, 5, 24, 7, 'active'));
  return el('ul', { class: 'rr-legend' },
    RV_STATES.map(st => el('li', {}, swatch(st), ' ', t(`status.${st}`))),
    el('li', {}, note, ' ', t('pdf.timelineNote')),
    el('li', {}, ncs, ' ', t('pdf.ncs')));
}

export function renderRosterView(app) {
  const details = $('#rr-details');
  if (!details || !details.open) return;
  const data = rosterData(app);
  const body = $('#rr-body');
  if (!data.rows.length) { fill(body, el('p', { class: 'empty' }, t('rr.empty'))); return; }
  fill(body,
    rvTable(data),
    el('p', { class: 'hint' }, t('pdf.times', { zone: zone() })),
    data.chart ? el('div', { class: 'rr-scroll' }, rvChart(data.chart)) : null,
    data.chart ? rvLegend() : null);
}

export function initRosterView(app) {
  $('#rr-details').addEventListener('toggle', () => renderRosterView(app));
}
