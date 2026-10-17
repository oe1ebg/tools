// The "History" panel in the station view (Live Notes): the selected
// station's earlier sessions on this device with what was recorded there,
// and possible matches to decide on. Collapsed by default; the heading
// counts sessions and open follow-ups. Every entry opens its exact source
// (b / Back returns, drafts kept). Read-only except the explicit identity
// decisions. Records come from history.js; nothing leaves the device.

import { $, el, fill } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { setText, setAttr } from './keyed.js';
import { hm } from './clock.js';
import { callText } from './roster.js';
import { openSource } from './searchui.js';
import { stationHistory, possibleMatches, historySummary, HISTORY_STORES } from './history.js';
import { linkSameStation, markNotSame } from './ops.js';
import { isUnresolved } from './model.js';

// All sessions' records, read once per change (app.reload marks it stale).
let historyRecords = null;
let historyLoading = null;

export function historyStale() {
  historyRecords = null;
}

async function historyData(app) {
  if (historyRecords) return historyRecords;
  if (!historyLoading) {
    historyLoading = Promise.all(HISTORY_STORES.map(s => app.store.getAll(s))).then(lists => {
      historyRecords = Object.fromEntries(HISTORY_STORES.map((s, i) => [s, lists[i]]));
      historyLoading = null;
      return historyRecords;
    }, e => { historyLoading = null; throw e; });
  }
  return historyLoading;
}

export function initHistory(app) {
  $('#btn-history').addEventListener('click', () => {
    app.ui.historyOpen = !app.ui.historyOpen;
    renderHistory(app);
  });
  $('#station-history').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const p = app.participant(app.ui.selected);
    if (b.dataset.act === 'open') {
      // the exact source, Back returns here; drafts are kept before anything moves
      await app.flush();
      app.nav.push();
      app.navigate(() => openSource(app, {
        kind: b.dataset.note ? 'note' : 'participant', field: 'note',
        sessionId: b.dataset.session, participantId: b.dataset.pid, noteId: b.dataset.note || null, roundId: b.dataset.round || null,
      }));
      return;
    }
    if (!p || app.readOnly) return;
    if (b.dataset.act === 'same') {
      const r = await app.act(store => linkSameStation(store, app.ctx(), p.id, b.dataset.pid));
      if (r) app.announce(t('history.linked', { call: callText(p) }));
    }
    if (b.dataset.act === 'notSame') {
      const r = await app.act(store => markNotSame(store, app.ctx(), p.id, b.dataset.pid));
      if (r) app.announce(t('history.notSameDone'));
    }
  });
}

function historyOpenButton(entry, n, children) {
  const attrs = { type: 'button', class: 'link history-open', 'data-act': 'open', 'data-session': entry.session.id, 'data-pid': entry.participant.id };
  if (n) { attrs['data-note'] = n.note.id; attrs['data-round'] = n.note.roundId || ''; }
  return el('button', attrs, children);
}

function historyItemBadge(kind, item) {
  const done = item.state === 'done';
  return el('span', { class: `pill ${done ? '' : 'warn'}` }, t(`history.${kind}.${done ? 'done' : 'open'}`));
}

function historyNoteRow(entry, n) {
  const time = n.note.time && n.note.time.iso ? hm(n.note.time.iso) : '';
  const where = n.round ? `${t('round.indicator', { n: n.round.number })}${n.round.topic ? ` · ${n.round.topic}` : ''}` : '';
  return el('li', { class: 'history-note' },
    historyOpenButton(entry, n, [
      el('span', { class: 'mono history-when' }, time),
      el('span', { class: 'history-where' }, where),
      el('span', { class: 'history-text' }, n.note.text),
    ]),
    n.response ? el('span', { class: 'history-item' }, historyItemBadge('response', n.response), n.response.text ? ` ${n.response.text}` : '') : null,
    n.task ? el('span', { class: 'history-item' }, historyItemBadge('task', n.task), n.task.text ? ` ${n.task.text}` : '') : null);
}

function historySessionEntry(app, p, entry) {
  const x = entry.participant;
  // the identity as recorded then, when it differs from today's
  const asThen = [x.call !== p.call ? callText(x) : '', x.name && x.name !== p.name ? x.name : ''].filter(Boolean).join(' · ');
  const head = [entry.session.date || '', entry.label || t('history.adhoc'), asThen ? t('history.asThen', { who: asThen }) : '']
    .filter(Boolean).join(' · ');
  return el('li', { class: 'history-session' },
    el('div', { class: 'history-head' },
      historyOpenButton(entry, null, el('span', {}, head)),
      el('span', { class: 'hint' }, t('history.notes', { n: entry.notes.length }))),
    entry.notes.length ? el('ul', { class: 'history-notes' }, entry.notes.map(n => historyNoteRow(entry, n))) : null);
}

function historyMatchRow(app, m) {
  const x = m.participant;
  const who = [callText(x), x.name].filter(Boolean).join(' · ');
  const where = [m.session.date, m.session.name || ''].filter(Boolean).join(' · ');
  return el('li', { class: 'history-match' },
    el('span', {}, `${who} — ${where} (${t(`history.why.${m.why}`)})`),
    el('span', { class: 'history-match-acts' },
      el('button', { type: 'button', class: 'mini', 'data-act': 'same', 'data-pid': x.id, disabled: app.readOnly }, t('history.same')),
      el('button', { type: 'button', class: 'mini', 'data-act': 'notSame', 'data-pid': x.id, disabled: app.readOnly }, t('history.notSame')),
      el('button', { type: 'button', class: 'mini', 'data-act': 'open', 'data-session': m.session.id, 'data-pid': x.id, 'aria-label': t('history.viewLabel', { who }) }, '↗')));
}

let historyRenderSeq = 0;

export async function renderHistory(app) {
  const box = $('#station-history');
  const p = app.participant(app.ui.selected);
  if (!app.s || !p) { box.hidden = true; return; }
  const seq = ++historyRenderSeq;
  let records;
  try {
    records = await historyData(app);
  } catch (e) {
    console.error(String(e));
    box.hidden = true;
    return;
  }
  // a newer render (another station, a change) took over meanwhile
  if (seq !== historyRenderSeq || app.participant(app.ui.selected) !== p) return;
  const history = stationHistory(records, p, app.s.id);
  const matches = possibleMatches(records, p, app.s.id);
  const sum = historySummary(history);
  box.hidden = false;
  const btn = $('#btn-history');
  const empty = !sum.sessions && !matches.length;
  // shown open only when there is something to show
  const open = !!app.ui.historyOpen && !empty;
  const label = sum.sessions
    ? t('history.heading', { n: sum.sessions, open: sum.open })
    : isUnresolved(p.call) ? t('history.partial') : t('history.none');
  setText(btn, `${open ? '▾' : '▸'} ${label}${matches.length ? ` · ${t('history.maybe', { n: matches.length })}` : ''}`);
  setAttr(btn, 'aria-expanded', String(open));
  btn.disabled = empty;
  $('#history-body').hidden = !open;
  if (!open) return;
  fill($('#history-matches'), matches.length ? [
    el('li', { class: 'history-sub' }, t('history.matchesTitle')),
    ...matches.map(m => historyMatchRow(app, m)),
  ] : []);
  fill($('#history-list'), history.map(entry => historySessionEntry(app, p, entry)));
}
