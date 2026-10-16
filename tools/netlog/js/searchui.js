// The search dialog (/): offline over this session or all sessions, with
// a field filter; each result names its session, round and station.
// Enter (or a click) opens the exact match where it can be edited (the
// note, the prepared reply, the talking point, the task, the station's
// detail), expanding a collapsed round; b / Back returns to where the
// search started, also in another session. Unfinished input is kept
// (drafts) before anything moves.

import { $, el, fill } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { setText } from './keyed.js';
import { search, SEARCH_FIELDS } from './search.js';
import { sessionLabel } from './model.js';
import { callText } from './roster.js';
import { focusNoteEditor } from './notes.js';

let results = [];

async function allRecords(app) {
  const [sessions, series, participants, notes, items, rounds] = await Promise.all(
    ['sessions', 'series', 'participants', 'notes', 'items', 'rounds'].map(s => app.store.getAll(s)));
  return { sessions, series, participants, notes, items, rounds };
}

export function initSearch(app) {
  const dlg = $('#search-dlg');
  const q = $('#search-q');
  let records = null;
  let pushed = false;
  let opened = false;

  const fieldSel = $('#search-field');
  const fillFields = () => {
    const cur = fieldSel.value || 'all';
    fill(fieldSel, SEARCH_FIELDS.map(f => el('option', { value: f }, t(`search.f.${f}`))));
    fieldSel.value = cur;
  };
  fillFields();
  app.onLang(fillFields);

  const run = () => {
    if (!records) return;
    results = search(records, { query: q.value, scope: $('#search-scope').value, sessionId: app.sessionId(), field: fieldSel.value });
    const seriesById = new Map(records.series.map(s => [s.id, s]));
    fill($('#search-results'), results.map((r, i) => {
      const s = r.session;
      const where = [
        s ? (sessionLabel(s, s.seriesId ? seriesById.get(s.seriesId) : null) || t('session.untitled')) : '',
        s ? s.date : '',
        r.round ? t('round.indicator', { n: r.round.number }) : '',
        r.participant ? callText(r.participant) : '',
        t(`search.k.${r.field}`),
      ].filter(Boolean).join(' · ');
      // a long text: around the match
      const [a, b] = r.match;
      const long = r.text.length > 160;
      const start = long ? Math.max(0, a - 60) : 0;
      const end = long ? Math.min(r.text.length, b + 80) : r.text.length;
      const pre = start > 0 ? '…' : '';
      const text = `${pre}${r.text.slice(start, end)}${end < r.text.length ? '…' : ''}`;
      const ma = a - start + pre.length, mb = b - start + pre.length;
      return el('li', {}, el('button', { type: 'button', class: 'result', 'data-i': String(i) },
        el('span', { class: 'r-text' }, text.slice(0, ma), el('mark', {}, text.slice(ma, mb)), text.slice(mb)),
        el('small', { class: 'hint' }, where)));
    }));
    setText($('#search-count'), q.value.trim() ? t('search.count', { n: results.length }) : '');
  };

  // Opens at once (what is typed next goes into the field); the records
  // are read meanwhile and the results follow.
  app.openSearch = async () => {
    if (dlg.open) return;
    if (!app.s) $('#search-scope').value = 'all';
    // the origin for Back, if a result is opened
    app.nav.push();
    pushed = true;
    opened = false;
    records = null;
    dlg.showModal();
    q.focus();
    q.select();
    app.flush(); // drafts are kept before anything moves
    records = await allRecords(app);
    run();
  };
  $('#btn-search').addEventListener('click', () => app.openSearch());
  q.addEventListener('input', run);
  $('#search-scope').addEventListener('change', run);
  fieldSel.addEventListener('change', run);
  q.addEventListener('keydown', ev => {
    // Esc closes at once (in a search field it would only clear the text)
    if (ev.key === 'Escape') { ev.preventDefault(); dlg.close(); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); $('#search-results button')?.focus(); }
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      const b = $('#search-results button');
      if (b) b.click();
    }
  });
  $('#search-results').addEventListener('keydown', ev => {
    const btns = [...$('#search-results').querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'j') { ev.preventDefault(); btns[Math.min(i + 1, btns.length - 1)]?.focus(); }
    if (ev.key === 'ArrowUp' || ev.key === 'k') { ev.preventDefault(); if (i <= 0) q.focus(); else btns[i - 1].focus(); }
  });
  $('#search-results').addEventListener('click', ev => {
    const b = ev.target.closest('button.result');
    if (!b) return;
    const r = results[Number(b.dataset.i)];
    opened = true;
    dlg.close();
    app.navigate(() => openResult(app, r));
  });
  dlg.addEventListener('close', () => {
    // closed without opening a result: nothing to go back to
    if (pushed && !opened) app.nav.drop();
    pushed = false;
  });
}

// Go to a result and focus it for editing.
async function openResult(app, r) {
  if (r.sessionId !== app.sessionId()) await app.openSessionNow(r.sessionId, 'live');
  const flash = n => { if (!n) return; n.classList.add('highlight'); setTimeout(() => n.classList.remove('highlight'), 2500); };
  if (r.kind === 'participant') {
    app.ui.selected = r.participantId;
    app.ui.view = 'live';
    if (r.field === 'qth' || r.field === 'locator') app.ui.detailsOpen = true;
    app.syncHash();
    app.render();
    const f = r.field === 'qth' ? $('#det-qth') : r.field === 'locator' ? $('#det-locator') : null;
    if (f) { f.focus(); flash(f); } else { $('#station-rounds .composer-text')?.focus(); flash($('#station-call')); }
    return;
  }
  if (r.kind === 'point') {
    app.ui.view = 'turn';
    app.syncHash();
    app.render();
    const li = $('#turn-items').querySelector(`li[data-key="${CSS.escape(r.itemId)}"]`) || $('#turn-history');
    flash(li);
    (li.querySelector('textarea') || li).focus();
    return;
  }
  if (r.kind === 'task' && !r.noteId) {
    app.ui.view = 'control';
    app.syncHash();
    app.render();
    const li = $('#task-list').querySelector(`li[data-key="${CSS.escape(r.itemId)}"]`);
    if (li) { flash(li); (li.querySelector('input.task-text') || li.querySelector('input')).focus(); }
    return;
  }
  // a note, its reply or its task: the station, the round expanded
  if (r.roundId) app.ui.roundOpen[r.roundId] = true;
  app.ui.selected = r.participantId;
  app.ui.view = 'live';
  app.syncHash();
  app.render();
  focusNoteEditor(app, r.noteId, { field: r.kind === 'response' ? 'reply' : 'text' });
}
