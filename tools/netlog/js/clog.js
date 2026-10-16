// Continuous Log: every note of the session in recorded order, across
// stations, grouped by round (older rounds collapsed like in Live Notes).
// The rows are the same note objects as in Live Notes and My Turn, edited
// with the same handlers (notes.js); each names and links its station.
// "Select notes" adds a checkbox to each row for moving several at once.

import { $, el } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { keyedList, setText, setAttr } from './keyed.js';
import { roundsSorted, liveOf, bySeq } from './model.js';
import { initNoteList, noteRow, updateNoteRow, roundOpen, openMoveDialog } from './notes.js';

export function initLog(app) {
  const box = $('#log-rounds');
  initNoteList(app, box);
  app.ui.logSelect = false;
  app.ui.logSelected = new Set();
  // the log's sections open and close on their own (not Live Notes')
  box.addEventListener('click', ev => {
    const toggle = ev.target.closest('button.log-toggle');
    if (!toggle) return;
    const rid = toggle.closest('section.round').dataset.key;
    app.ui.logOpen[rid] = toggle.getAttribute('aria-expanded') !== 'true';
    renderLog(app);
  });
  box.addEventListener('change', ev => {
    const cb = ev.target.closest('input.note-select');
    if (!cb) return;
    const id = cb.closest('li.note').dataset.key;
    if (cb.checked) app.ui.logSelected.add(id); else app.ui.logSelected.delete(id);
    renderLogBar(app);
  });
  app.ui.logOpen = {};
  $('#btn-log-select').addEventListener('click', () => {
    app.ui.logSelect = !app.ui.logSelect;
    if (!app.ui.logSelect) app.ui.logSelected.clear();
    renderLog(app);
  });
  $('#btn-log-move').addEventListener('click', () => openMoveDialog(app, [...app.ui.logSelected]));
  app.onMoved = () => { app.ui.logSelected.clear(); app.render(); };
}

function renderLogBar(app) {
  const sel = app.ui.logSelected;
  setAttr($('#btn-log-select'), 'aria-pressed', String(app.ui.logSelect));
  setText($('#btn-log-select'), t(app.ui.logSelect ? 'log.selectDone' : 'log.select'));
  $('#btn-log-move').hidden = !app.ui.logSelect;
  $('#btn-log-move').disabled = !sel.size || app.readOnly;
  $('#btn-log-select').disabled = app.readOnly;
  setText($('#log-selected'), app.ui.logSelect ? t('log.selected', { n: sel.size }) : '');
}

export function renderLog(app) {
  const sorted = roundsSorted(app.sd.rounds);
  const parts = new Map(app.sd.participants.map(p => [p.id, p]));
  const notes = liveOf(app.sd.notes).sort(bySeq);
  // a note that is gone is no longer selected
  for (const id of [...app.ui.logSelected]) if (!notes.some(n => n.id === id)) app.ui.logSelected.delete(id);
  keyedList($('#log-rounds'), sorted, {
    key: r => r.id,
    create: r => el('section', { class: 'round' },
      el('h3', { class: 'round-head' },
        el('button', { type: 'button', class: 'round-toggle log-toggle', 'aria-controls': `lb-${r.id}` }, el('span', { class: 'chev', 'aria-hidden': 'true' }), el('span', { class: 'rt' })),
        el('span', { class: 'round-counts hint' })),
      el('div', { class: 'round-body', id: `lb-${r.id}` }, el('ol', { class: 'notes', id: `log-notes-${r.id}` }), el('p', { class: 'empty empty-round' }))),
    update: (sec, r) => {
      const [head, body] = sec.children;
      const [toggle, counts] = head.children;
      const k = app.ui.logOpen[r.id];
      const open = k !== undefined ? k : roundOpen(app, { id: r.id }, sorted) || r.id === app.s.currentRoundId;
      setAttr(toggle, 'aria-expanded', String(open));
      setText(toggle.firstChild, open ? '▾' : '▸');
      setText(toggle.lastChild, [t('round.indicator', { n: r.number }), r.id === app.s.currentRoundId ? t('round.current') : '', r.topic].filter(Boolean).join(' · '));
      const list = notes.filter(n => n.roundId === r.id);
      setText(counts, t('log.count', { n: list.length }));
      sec.classList.toggle('current', r.id === app.s.currentRoundId);
      body.hidden = !open;
      const [ol, empty] = body.children;
      if (open) {
        keyedList(ol, list, {
          key: n => n.id,
          create: noteRow,
          update: (li, n) => updateNoteRow(app, li, n, parts.get(n.participantId) || { id: n.participantId, call: '?' }, r, {
            station: true, select: app.ui.logSelect, selected: app.ui.logSelected.has(n.id),
          }),
        });
      }
      empty.hidden = !open || list.length > 0;
      setText(empty, t('round.noNotesLog'));
    },
  });
  renderLogBar(app);
}

// The rows j/k move through in the log.
export function logRows() {
  return [...document.querySelectorAll('#log-rounds .round-body:not([hidden]) li.note')];
}
