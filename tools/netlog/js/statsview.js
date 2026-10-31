// The statistics card of a series (#83) in "Sessions & series": opened with the "Statistics"
// button on the series heading, built only while it is open and read lazily then (the records of
// the series' sessions from the stores; never at startup, nothing leaves the device). The numbers
// come from stats.js, their texts from statsmodel.js; this module only draws them.

import { el, fill } from '../../shared/js/dom.js';
import { t, lang } from './i18n.js';
import { setText } from './keyed.js';
import { sessionsOf } from './model.js';
import { zone, timeMode } from './clock.js';
import { seriesStatistics } from './stats.js';
import { smSummary, smLeaderboard, smMatrix, smSessions, smRotation } from './statsmodel.js';

// the stores whose records statistics read (eventId = the session's id)
const SV_STORES = ['participants', 'rounds', 'contributions', 'notes', 'events'];

// Per series card: { open, busy, again, shown } (in memory only; the card is closed after a reload)
const svState = new Map();
const svOf = key => {
  if (!svState.has(key)) svState.set(key, { open: false, busy: false, again: false, shown: '' });
  return svState.get(key);
};

async function svLoad(app, seriesId) {
  const sessions = sessionsOf(app.data.sessions, seriesId);
  return Promise.all(sessions.map(async session => {
    const lists = await Promise.all(SV_STORES.map(s => app.store.getByEvent(s, session.id)));
    return { session, ...Object.fromEntries(SV_STORES.map((s, i) => [s, lists[i]])) };
  }));
}

// ---------- drawing ----------

const svQty = q => [q.text, q.note ? el('small', { class: 'st-note' }, ' ', q.note) : null];

// a table in a scrolling region of its own (reflow at 320 px: the page itself never scrolls
// sideways), named by its caption
function svTable(id, title, head, rows) {
  return el('div', { class: 'st-scroll', role: 'region', tabindex: '0', 'aria-labelledby': `${id}-cap` },
    el('table', { class: 'st-table' },
      el('caption', { class: 'sr-only', id: `${id}-cap` }, title),
      el('thead', {}, el('tr', {}, head.map(h => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, rows)));
}

const svStation = r => [el('b', { class: 'call mono' }, r.call), r.name ? el('span', { class: 'st-name' }, ' ', r.name) : null];

function svBlock(id, title, ...kids) {
  return el('section', { class: 'st-block', 'aria-labelledby': `${id}-h` }, el('h5', { id: `${id}-h` }, title), kids);
}

function svSummary(stats) {
  const s = smSummary(stats);
  const items = [
    t('stats.sessions', { n: s.sessions }),
    t('stats.stations', { n: s.stations }),
    t('stats.unknownTimes', { n: s.unknownTimes }),
    t('stats.excluded', { n: s.excluded }),
  ];
  return el('ul', { class: 'st-summary' }, items.map(x => el('li', {}, x)));
}

function svLeaderboard(id, stats) {
  const rows = smLeaderboard(stats);
  return svBlock(id, t('stats.lbTitle'),
    svTable(`${id}-t`, t('stats.lbCaption'),
      [t('stats.rank'), t('stats.station'), t('stats.attended'), t('stats.timePresent'), t('stats.speaking'), t('stats.ncsSessions'), t('stats.lastSeen')],
      rows.map(r => el('tr', {},
        el('td', { class: 'st-num' }, String(r.rank)),
        el('th', { scope: 'row' }, svStation(r)),
        el('td', {}, r.attendedText),
        el('td', { class: 'mono' }, svQty(r.timePresent)),
        el('td', { class: 'mono' }, svQty(r.speaking)),
        el('td', { class: 'st-num' }, String(r.ncsSessions)),
        el('td', { class: 'mono' }, r.lastSeen)))));
}

function svMatrix(id, stats) {
  const m = smMatrix(stats);
  return svBlock(id, t('stats.matrixTitle'),
    el('p', { class: 'hint' }, t('stats.matrixLegend')),
    svTable(`${id}-t`, t('stats.matrixCaption'),
      [t('stats.station'), ...m.sessions.map(s => [el('span', { class: 'mono' }, s.date), s.number ? el('br') : null, s.number])],
      m.rows.map(r => el('tr', {},
        el('th', { scope: 'row' }, svStation(r)),
        r.cells.map(c => el('td', { class: `st-cell${c.attended ? ' here' : ''}` },
          c.attended ? null : el('span', { class: 'sr-only' }, t('stats.absent')),
          el('span', { class: 'mono', 'aria-hidden': c.attended ? null : 'true' }, c.text),
          c.note ? el('small', { class: 'st-note' }, ' ', c.note) : null,
          c.ncs ? el('span', { class: 'rr-tag ncs' }, 'NCS') : null))))));
}

function svSessions(id, stats) {
  const rows = smSessions(stats);
  return svBlock(id, t('stats.sessionsTitle'),
    el('p', { class: 'hint' }, t('pdf.times', { zone: zone() })),
    svTable(`${id}-t`, t('stats.sessionsCaption'),
      [t('stats.date'), t('stats.session'), t('stats.length'), t('stats.rounds'), t('stats.present'), t('stats.ncs')],
      rows.map(r => el('tr', {},
        el('th', { scope: 'row', class: 'mono' }, r.date),
        el('td', {}, [r.number, r.name].filter(Boolean).join(' ')),
        el('td', { class: 'mono' }, r.span ? [r.span, el('br')] : null, svQty(r.length)),
        el('td', {}, r.rounds.length
          ? r.rounds.map(x => el('div', {}, t('stats.roundN', { n: x.number ?? '?' }), ': ', el('span', { class: 'mono' }, svQty(x.duration))))
          : t('stats.noRounds')),
        el('td', { class: 'st-num' }, String(r.present)),
        el('td', {}, r.ncs.length ? r.ncs.map(c => el('div', { class: 'call mono' }, c)) : '–')))));
}

function svRotation(id, stats) {
  const rows = smRotation(stats);
  return svBlock(id, t('stats.rotationTitle'),
    el('p', { class: 'hint' }, t('pdf.times', { zone: zone() })),
    svTable(`${id}-t`, t('stats.rotationCaption'),
      [t('stats.date'), t('stats.session'), t('stats.ncs')],
      rows.map(r => el('tr', {},
        el('th', { scope: 'row', class: 'mono' }, r.date),
        el('td', {}, r.number),
        el('td', {}, r.holders.length
          ? r.holders.map(h => el('div', {},
            el('b', { class: 'call mono' }, h.call), ' ',
            el('span', { class: 'mono' }, h.from || h.to ? `${h.from || '?'}–${h.to || '?'} ${h.zone}` : '', ' ', svQty(h.duration))))
          : '–')))));
}

// the whole card body for one result
function svDraw(id, stats) {
  if (!stats.sessionCount) return [el('p', { class: 'empty' }, t('stats.empty'))];
  return [
    svSummary(stats),
    el('p', { class: 'hint st-estimate' }, el('b', {}, t('stats.estimateTitle')), ' ', t('stats.estimateNote')),
    stats.leaderboard.length ? svLeaderboard(id, stats) : el('p', { class: 'empty' }, t('stats.noStations')),
    stats.leaderboard.length ? svMatrix(id, stats) : null,
    svSessions(id, stats),
    svRotation(id, stats),
  ];
}

// ---------- the card ----------

// The statistics panel of the series card `key`: (re)read and draw while it is open. The status
// line is a live region; focus never moves. A result identical to what is shown is not redrawn
// (focus and scroll positions in the tables survive other re-renders).
async function svRefresh(app, key, seriesId, panel) {
  const st = svOf(key);
  if (st.busy) { st.again = true; return; }
  st.busy = true;
  const status = panel.querySelector('.st-status');
  const body = panel.querySelector('.st-body');
  try {
    if (!st.shown) setText(status, t('stats.loading'));
    const stats = seriesStatistics(await svLoad(app, seriesId));
    const sig = `${lang()}|${timeMode()}|${JSON.stringify(stats)}`;
    if (st.open && sig !== st.shown) {
      st.shown = sig;
      fill(body, svDraw(`st-${key}`, stats));
    }
    setText(status, st.open ? t('stats.ready', { n: stats.sessionCount }) : '');
  } catch {
    st.shown = '';
    fill(body);
    setText(status, t('stats.error'));
  } finally {
    st.busy = false;
    if (st.again) { st.again = false; if (st.open) svRefresh(app, key, seriesId, panel); }
  }
}

export function statsPanel(key) {
  return el('div', { class: 'stats-panel', id: `series-stats-${key}`, hidden: true },
    el('h4', { class: 'st-title' }),
    el('p', { class: 'st-status hint', role: 'status' }),
    el('div', { class: 'st-body' }));
}

// Bring a card's panel and its button up to date (called by every render of the list).
export function syncStats(app, g, panel, btn) {
  const st = svOf(g.key);
  panel.hidden = !st.open;
  if (btn) btn.setAttribute('aria-expanded', String(st.open));
  if (!st.open) return;
  setText(panel.querySelector('.st-title'), t('stats.title'));
  svRefresh(app, g.key, g.series.id, panel);
}

// The "Statistics" button of a card: opens or closes the panel; focus stays on the button.
export function toggleStats(app, g, panel, btn) {
  const st = svOf(g.key);
  st.open = !st.open;
  if (!st.open) { st.shown = ''; fill(panel.querySelector('.st-body')); setText(panel.querySelector('.st-status'), ''); }
  syncStats(app, g, panel, btn);
}
