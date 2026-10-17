// "Sessions & series": start a session at once (ad-hoc or in a series,
// also joining a net that is already running, in a given round), create
// and edit series, open earlier sessions, assign an ad-hoc session to a
// series later.

import { $, el, fill } from '../../shared/js/dom.js';
import { isoBindDateField, isoDateFromText } from '../../shared/js/isodate.js';
import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { t } from './i18n.js';
import { keyedList, setText } from './keyed.js';
import { liveOf, nextSessionNumber, sessionLabel, sessionsOf, normCall, cmp, NET_STYLES } from './model.js';
import { createSession, createSeries, updateSeries, assignSeries, deleteSession } from './ops.js';
import { sessionAction, exportBackup, importFile } from './dataui.js';
import { historyData } from './historyui.js';
import { seriesStats } from './history.js';
import { attachRepeaterField, attachCallField } from './fieldsearch.js';

export const OWN_PREF = 'oe1ebg-netlog-own-call';

// A series' default speaking order for the select.
const styleOf = series => (series && NET_STYLES.includes(series.defaults.style) ? series.defaults.style : 'star');

let importTarget = null; // { seriesId, msg } of the card whose restore was clicked

export function initSessions(app) {
  const sForm = $('#session-form');
  const srForm = $('#series-form');
  const sBtn = $('#btn-new-session');
  const srBtn = $('#btn-new-series');
  const checkDate = isoBindDateField($('#sf-date'), $('#sf-date-pick'));
  let editingSeries = null;

  const openSessionForm = (on, seriesId = '') => {
    sForm.hidden = !on;
    sBtn.setAttribute('aria-expanded', String(on));
    if (!on) return;
    fillSeriesSelect(app, seriesId);
    $('#sf-date').value = new Date().toISOString().slice(0, 10);
    checkDate();
    $('#sf-own').value = prefGet(OWN_PREF, '') || '';
    $('#sf-name').value = '';
    $('#sf-round').value = '1';
    $('#sf-joined').checked = false;
    { const sr = app.data.series.find(s => s.id === seriesId); $('#sf-style').value = styleOf(sr); }
    setText($('#sf-error'), '');
    suggestNumber(app);
    $('#sf-series').focus();
  };
  app.openSessionForm = openSessionForm;
  const openSeriesForm = (on, series = null) => {
    srForm.hidden = !on;
    srBtn.setAttribute('aria-expanded', String(on && !series));
    editingSeries = on ? series : null;
    if (!on) return;
    setText($('#series-form-title'), t(series ? 'series.edit' : 'series.newTitle'));
    $('#srf-name').value = series ? series.name : '';
    $('#srf-description').value = series ? series.description || '' : '';
    $('#srf-schedule').value = series ? series.schedule || '' : '';
    $('#srf-repeater').value = series ? series.defaults.repeater || '' : '';
    $('#srf-freq').value = series ? series.defaults.freq || '' : '';
    $('#srf-mode').value = series ? series.defaults.mode || '' : '';
    $('#srf-ncs').value = series ? series.defaults.ncs || '' : '';
    $('#srf-numbering').value = series ? series.numbering : 'sequential';
    $('#srf-style').value = styleOf(series);
    setText($('#srf-error'), '');
    $('#srf-name').focus();
  };
  sBtn.addEventListener('click', () => { openSeriesForm(false); openSessionForm(sForm.hidden); });
  srBtn.addEventListener('click', () => { openSessionForm(false); openSeriesForm(srForm.hidden); });
  $('#btn-session-cancel').addEventListener('click', () => { openSessionForm(false); sBtn.focus(); });
  $('#btn-series-cancel').addEventListener('click', () => { openSeriesForm(false); srBtn.focus(); });
  for (const f of [sForm, srForm]) {
    f.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      if (f === sForm) { openSessionForm(false); sBtn.focus(); } else { openSeriesForm(false); srBtn.focus(); }
    });
  }
  $('#sf-series').addEventListener('change', () => suggestNumber(app));
  attachRepeaterField(app, $('#sf-repeater'), { freq: $('#sf-freq'), mode: $('#sf-mode'), hint: $('#sf-mode-hint') });
  attachRepeaterField(app, $('#srf-repeater'), { freq: $('#srf-freq'), mode: $('#srf-mode'), hint: $('#srf-mode-hint') });
  attachCallField(app, $('#srf-ncs'));
  attachCallField(app, $('#sf-own'));

  sForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    checkDate();
    const date = isoDateFromText($('#sf-date').value);
    const round = Number($('#sf-round').value.trim() || '1');
    const numText = $('#sf-number').value.trim();
    const err = !date ? t('session.badDate')
      : (!Number.isInteger(round) || round < 1 || round > 999) ? t('session.badRound')
        : (numText && !/^\d{1,6}$/.test(numText)) ? t('session.badNumber') : '';
    setText($('#sf-error'), err);
    if (err) return;
    const own = normCall($('#sf-own').value);
    if (own) prefSet(OWN_PREF, own);
    const seriesId = $('#sf-series').value || null;
    const s = await app.act(store => createSession(store, { tab: app.tab }, {
      seriesId,
      number: numText === '' ? null : Number(numText),
      name: $('#sf-name').value,
      date,
      own,
      radio: { repeater: $('#sf-repeater').value.trim(), freq: $('#sf-freq').value.trim(), mode: $('#sf-mode').value },
      round,
      style: $('#sf-style').value,
      joined: $('#sf-joined').checked,
    }), { global: true });
    if (!s) return;
    openSessionForm(false);
    app.go(s.id, 'live');
  });

  srForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    const name = $('#srf-name').value.trim();
    setText($('#srf-error'), name ? '' : t('series.needName'));
    if (!name) return;
    const fields = {
      name,
      description: $('#srf-description').value.trim(),
      schedule: $('#srf-schedule').value.trim(),
      defaults: { repeater: $('#srf-repeater').value.trim(), freq: $('#srf-freq').value.trim(), mode: $('#srf-mode').value, ncs: normCall($('#srf-ncs').value), style: $('#srf-style').value },
      numbering: $('#srf-numbering').value,
    };
    const r = editingSeries
      ? await app.act(store => updateSeries(store, { tab: app.tab }, editingSeries.id, fields), { global: true })
      : await app.act(store => createSeries(store, { tab: app.tab }, fields), { global: true });
    if (!r) return;
    openSeriesForm(false);
    app.announce(t('series.saved', { name: r.name }));
    srBtn.focus();
  });

  $('#series-list').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === 'open') app.go(id, 'live');
    if (b.dataset.act === 'new-in') { openSeriesForm(false); openSessionForm(true, id); }
    if (b.dataset.act === 'edit-series') { openSessionForm(false); openSeriesForm(true, app.data.series.find(s => s.id === id)); }
    if (b.dataset.act === 'delete') {
      const s = app.data.sessions.find(x => x.id === id);
      if (s && globalThis.confirm(t('session.deleteConfirm', { name: sessionLabel(s, seriesOf(app, s)) || s.date }))) {
        await app.act(store => deleteSession(store, { tab: null }, id), { global: true });
      }
    }
    if (b.dataset.act === 'restore') await app.act(store => deleteSession(store, { tab: null }, id, true), { global: true });
    if (b.dataset.act === 'export' || b.dataset.act === 'erase') await sessionAction(app, b.dataset.act, id);
    if (b.dataset.act === 'toggle-card') {
      const sec = b.closest('section');
      const open = b.getAttribute('aria-expanded') !== 'true';
      setCardOpen(sec.dataset.key, open);
      renderSessions(app);
    }
    if (b.dataset.act === 'export-series') await exportBackup(app, null, { seriesId: id, msg: b.closest('section').querySelector('.card-msg') });
    if (b.dataset.act === 'restore-series') {
      importTarget = { seriesId: id, msg: b.closest('section').querySelector('.card-msg') };
      $('#series-import-file').click();
    }
  });
  $('#series-import-file').addEventListener('change', async ev => {
    const f = ev.target.files[0];
    ev.target.value = '';
    const target = importTarget;
    importTarget = null;
    if (f && target) await importFile(app, f, target);
  });
  $('#series-list').addEventListener('change', async ev => {
    const sel = ev.target.closest('select[data-assign]');
    if (!sel) return;
    const id = sel.dataset.assign;
    const r = await app.act(store => assignSeries(store, { tab: null }, id, sel.value || null), { global: true });
    if (r) app.announce(t('session.assigned', { name: sessionLabel(r, seriesOf(app, r)) }));
  });
}

// Which series cards are open (per device): { <key>: true|false }; by
// default the one with the open session and the ad-hoc sessions are open.
const OPEN_PREF = 'oe1ebg-netlog-series-open';
function openState() {
  try {
    const v = JSON.parse(prefGet(OPEN_PREF, '{}'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function cardOpen(app, g) {
  const saved = openState()[g.key];
  if (typeof saved === 'boolean') return saved;
  if (g.deleted) return false;
  return !g.series || g.sessions.some(s => s.id === app.sessionId());
}
function setCardOpen(key, open) {
  const all = openState();
  all[key] = open;
  prefSet(OPEN_PREF, JSON.stringify(all));
}

function seriesOf(app, s) {
  return s.seriesId ? app.data.series.find(x => x.id === s.seriesId) || null : null;
}

function fillSeriesSelect(app, seriesId) {
  const sel = $('#sf-series');
  fill(sel, el('option', { value: '' }, t('session.adHoc')),
    liveOf(app.data.series).sort((a, b) => cmp(a.name, b.name)).map(s => el('option', { value: s.id }, s.name)));
  sel.value = seriesId || '';
}

function suggestNumber(app) {
  const id = $('#sf-series').value;
  const series = app.data.series.find(s => s.id === id);
  $('#sf-number').value = series && series.numbering !== 'none' ? String(nextSessionNumber(app.data.sessions, id)) : '';
  $('#sf-repeater').value = series ? series.defaults.repeater || '' : '';
  $('#sf-freq').value = series ? series.defaults.freq || '' : '';
  $('#sf-mode').value = series ? series.defaults.mode || '' : '';
  $('#sf-style').value = styleOf(series);
  $('#sf-repeater').placeholder = '';
}

// The list: each series with its sessions (newest first), then the
// ad-hoc sessions, then deleted ones (restorable).
export function renderSessions(app) {
  const series = liveOf(app.data.series).sort((a, b) => cmp(a.name, b.name));
  const groups = [
    ...series.map(s => ({ key: s.id, series: s, sessions: sessionsOf(app.data.sessions, s.id) })),
    { key: 'adhoc', series: null, sessions: sessionsOf(app.data.sessions, null) },
  ];
  const deleted = app.data.sessions.filter(s => s.deleted);
  if (deleted.length) groups.push({ key: 'deleted', series: null, deleted: true, sessions: deleted });
  const box = $('#series-list');
  keyedList(box, groups, {
    key: g => g.key,
    create: g => el('section', { class: 'card series-card' },
      el('div', { class: 'toolbar' },
        el('h3', {}, el('button', { type: 'button', class: 'card-toggle', 'data-act': 'toggle-card', 'aria-controls': `series-body-${g.key}` })),
        el('span', { class: 'spacer' }), el('span', { class: 'tools' })),
      el('p', { class: 'series-stats' }),
      el('p', { class: 'card-msg data-msg', role: 'status' }),
      el('div', { class: 'series-body', id: `series-body-${g.key}` }, el('p', { class: 'hint sub' }), el('ul', { class: 'session-rows' }))),
    update: (sec, g) => {
      const [bar, stats, , body] = sec.children;
      const [sub, ul] = body.children;
      const [h, , tools] = bar.children;
      const open = cardOpen(app, g);
      const title = g.series ? g.series.name : t(g.deleted ? 'session.deletedGroup' : 'session.adHocGroup');
      setText(h.firstChild, `${open ? '▾' : '▸'} ${title}`);
      h.firstChild.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      sec.classList.toggle('collapsed', !open);
      // the summary line: filled once all sessions' records are read
      if (!g.deleted) {
        historyData(app).then(recs => {
          const st = seriesStats(recs, g.series ? g.series.id : null);
          setText(stats, st.sessions ? t('series.stats', {
            n: st.sessions, range: st.first === st.last ? st.first : `${st.first} – ${st.last}`, avg: String(st.avgStations).replace('.', t('number.decimal')),
            stations: st.stations, notes: st.notes, open: st.open,
          }) : '');
        }, () => setText(stats, ''));
      } else setText(stats, t('series.statsDeleted', { n: g.sessions.length }));
      setText(sub, g.series ? [g.series.description, g.series.schedule, g.series.defaults.repeater, g.series.defaults.freq, g.series.defaults.mode].filter(Boolean).join(' · ') : '');
      const toolSig = `${g.key}|${app.lang()}`;
      if (tools.dataset.sig !== toolSig) {
        tools.dataset.sig = toolSig;
        fill(tools, g.series ? [
          el('button', { type: 'button', class: 'mini', 'data-act': 'new-in', 'data-id': g.series.id, 'aria-label': t('series.newInLabel', { name: g.series.name }) }, t('series.newIn')),
          el('button', { type: 'button', class: 'mini', 'data-act': 'edit-series', 'data-id': g.series.id, 'aria-label': t('series.editLabel', { name: g.series.name }) }, t('common.edit')),
          el('button', { type: 'button', class: 'mini', 'data-act': 'export-series', 'data-id': g.series.id, 'aria-label': t('series.exportLabel', { name: g.series.name }) }, t('series.export')),
          el('button', { type: 'button', class: 'mini', 'data-act': 'restore-series', 'data-id': g.series.id, 'aria-label': t('series.restoreLabel', { name: g.series.name }) }, t('series.restore')),
        ] : []);
      }
      keyedList(ul, g.sessions, {
        key: s => s.id,
        create: () => el('li', { class: 'session-row' }),
        update: (li, s) => {
          const label = sessionLabel(s, seriesOf(app, s)) || t('session.untitled');
          const count = app.data.participantCount[s.id] || 0;
          const sig = [s.updated, app.lang(), count, s.id === app.sessionId(), series.map(x => x.id + x.name).join()].join('|');
          if (li.dataset.sig === sig) return;
          li.dataset.sig = sig;
          fill(li,
            el('span', { class: 'session-main' },
              el('b', {}, label),
              ' ', el('span', { class: 'mono' }, s.date || ''),
              s.id === app.sessionId() ? el('span', { class: 'pill' }, t('session.current')) : null,
              ' ', el('small', { class: 'hint' }, t('session.participants', { n: count }))),
            s.deleted
              ? [
                el('button', { type: 'button', class: 'mini', 'data-act': 'restore', 'data-id': s.id, 'aria-label': t('session.restoreLabel', { name: label }) }, t('common.restore')),
                el('button', { type: 'button', class: 'mini danger', 'data-act': 'erase', 'data-id': s.id, 'aria-label': t('session.eraseLabel', { name: label }) }, t('session.erase')),
              ]
              : [
                el('button', { type: 'button', class: 'mini', 'data-act': 'export', 'data-id': s.id, 'aria-label': t('session.exportLabel', { name: label }) }, t('session.export')),
                el('button', { type: 'button', class: 'mini primary', 'data-act': 'open', 'data-id': s.id, 'aria-label': t('session.openLabel', { name: label }) }, t('session.open')),
                el('label', { class: 'inline-field' }, el('span', { class: 'sr-only' }, t('session.assignLabel', { name: label })),
                  el('select', { 'data-assign': s.id },
                    el('option', { value: '' }, t('session.adHoc')),
                    series.map(x => el('option', { value: x.id, selected: x.id === s.seriesId }, x.name)))),
                el('button', { type: 'button', class: 'mini danger', 'data-act': 'delete', 'data-id': s.id, 'aria-label': t('session.deleteLabel', { name: label }) }, t('common.delete')),
              ]);
        },
      });
      if (!open) return;
      if (!g.sessions.length && !ul.nextElementSibling) ul.after(el('p', { class: 'hint empty-small' }, t('session.none')));
      else if (g.sessions.length && ul.nextElementSibling) ul.nextElementSibling.remove();
      else if (ul.nextElementSibling) setText(ul.nextElementSibling, t('session.none'));
    },
  });
}
