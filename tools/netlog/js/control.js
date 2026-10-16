// Net Control: the roster with its planned speaking order. Planning and
// display order never change the actual speaking history, and nothing
// here starts a round.

import { $, el, fill } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { keyedList, setText, setAttr, setValue } from './keyed.js';
import { rosterSorted, roundsSorted, nextRoundNumber, liveOf, cmp, timeOf, baseCall } from './model.js';
import { moveParticipant, createRound, setCurrentRound, updateRound, setItemDone, addTask, setItemText, setNcs, setEventTime } from './ops.js';
import { callText, statusLabel } from './roster.js';
import { expandedCount, setExpandedCount } from './notes.js';

// Planned order first (stations without one after them, in roster order).
export function plannedOrder(participants) {
  return rosterSorted(participants).map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.plannedOrder ?? Infinity) - (b.p.plannedOrder ?? Infinity) || a.i - b.i)
    .map(x => x.p);
}

// "+ New round": a dialog asks for the number (next one suggested) and an
// optional topic. Only this (or a correction in the list) changes rounds.
export function openRoundDialog(app) {
  if (!app.s || app.readOnly) return;
  const dlg = $('#round-dlg');
  const back = document.activeElement;
  $('#round-number').value = String(nextRoundNumber(app.sd.rounds));
  $('#round-topic').value = '';
  setText($('#round-error'), '');
  dlg.returnValue = '';
  dlg.showModal();
  $('#round-topic').focus();
  dlg.onclose = async () => {
    if (back && back.isConnected) back.focus();
    if (dlg.returnValue !== 'ok') return;
    const n = Number($('#round-number').value.trim());
    const r = await app.act(store => createRound(store, app.ctx(), { number: Number.isInteger(n) && n > 0 ? n : undefined, topic: $('#round-topic').value }));
    if (r) app.announce(t('round.started', { n: r.number }));
  };
}

export function initControl(app) {
  $('#btn-new-round').addEventListener('click', () => openRoundDialog(app));
  $('#round-form').addEventListener('submit', ev => {
    if (ev.submitter && ev.submitter.value !== 'ok') return;
    const n = $('#round-number').value.trim();
    if (n && !/^\d{1,3}$/.test(n)) { ev.preventDefault(); setText($('#round-error'), t('round.badNumber')); }
  });
  const sel = $('#expanded-count');
  sel.value = String(expandedCount());
  sel.addEventListener('change', () => { setExpandedCount(Number(sel.value)); app.ui.roundOpen = {}; app.render(); });

  $('#round-list').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('li').dataset.key;
    if (b.dataset.act === 'current') {
      const r = await app.act(store => setCurrentRound(store, app.ctx(), id));
      if (r) app.announce(t('round.nowCurrent', { n: app.sd.rounds.find(x => x.id === id).number }));
    }
  });
  $('#round-list').addEventListener('change', async ev => {
    const f = ev.target;
    const id = f.closest('li') && f.closest('li').dataset.key;
    if (!id) return;
    if (f.classList.contains('round-topic')) await app.act(store => updateRound(store, app.ctx(), id, { topic: f.value }));
    if (f.classList.contains('round-no')) {
      const n = Number(f.value.trim());
      if (!Number.isInteger(n) || n < 1 || n > 999) { f.setAttribute('aria-invalid', 'true'); app.announce(t('round.badNumber')); return; }
      f.removeAttribute('aria-invalid');
      await app.act(store => updateRound(store, app.ctx(), id, { number: n }));
    }
  });
  $('#round-list').addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target.matches('input')) { ev.preventDefault(); ev.target.dispatchEvent(new Event('change', { bubbles: true })); }
  });

  $('#ncs-suggest').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-pid]');
    if (b) await app.act(store => setNcs(store, app.ctx(), b.dataset.pid));
  });
  // a handover's time: HH:MM (UTC, on the event's date) and whether it is
  // an estimate; a correction keeps a revision and can be undone
  $('#ncs-history').addEventListener('change', async ev => {
    const li = ev.target.closest('li');
    if (!li) return;
    const ev0 = app.sd.events.find(e => e.id === li.dataset.key);
    const tf = li.querySelector('input.ev-time');
    const est = li.querySelector('input.ev-est');
    const m = /^(\d{1,2}):(\d{2})$/.exec(tf.value.trim());
    if (tf.value.trim() && (!m || Number(m[1]) > 23 || Number(m[2]) > 59)) { tf.setAttribute('aria-invalid', 'true'); app.announce(t('ncs.badTime')); return; }
    tf.removeAttribute('aria-invalid');
    const date = (ev0.time && ev0.time.iso ? ev0.time.iso : ev0.created).slice(0, 10);
    const iso = m ? `${date}T${m[1].padStart(2, '0')}:${m[2]}:00.000Z` : null;
    await app.act(store => setEventTime(store, app.ctx(), ev0.id, timeOf(iso, est.checked ? 'estimated' : 'exact')));
  });
  $('#task-list').addEventListener('change', ev => {
    const cb = ev.target.closest('input.item-done');
    if (cb) app.act(store => setItemDone(store, app.ctx(), cb.closest('li').dataset.key, cb.checked));
    const tx = ev.target.closest('input.task-text');
    if (tx) app.act(store => setItemText(store, app.ctx(), tx.closest('li').dataset.key, tx.value.trim()));
  });
  $('#task-list').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act=open]');
    if (b) app.openFrom(b.dataset.pid, { noteId: b.dataset.note });
  });
  $('#task-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = $('#task-text');
    const text = f.value.trim();
    if (!text) return;
    f.value = '';
    const r = await app.act(store => addTask(store, app.ctx(), text));
    if (!r && !f.value) f.value = text;
  });

  $('#order-list').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('li').dataset.key;
    if (b.dataset.act === 'open') { app.openStation(id); return; }
    if (b.dataset.act === 'ncs') {
      const on = app.s.ncsId !== id;
      const r = await app.act(store => setNcs(store, app.ctx(), on ? id : null));
      if (r) app.announce(t(on ? 'ncs.assigned' : 'ncs.cleared', { call: callText(app.participant(id)) }));
      $('#order-list').querySelector(`li[data-key="${CSS.escape(id)}"] button[data-act="ncs"]`)?.focus();
      return;
    }
    const dir = b.dataset.act === 'up' ? -1 : 1;
    const moved = await app.act(store => moveParticipant(store, app.ctx(), id, dir, 'plannedOrder'));
    if (moved) {
      app.announce(t(dir < 0 ? 'roster.movedUp' : 'roster.movedDown', { call: callText(app.participant(id)) }));
      // keep the keyboard on the same button of the moved row
      const row = $('#order-list').querySelector(`li[data-key="${CSS.escape(id)}"] button[data-act="${b.dataset.act}"]`);
      if (row && !row.disabled) row.focus();
      else $('#order-list').querySelector(`li[data-key="${CSS.escape(id)}"] button[data-act="open"]`)?.focus();
    }
  });
}

export function renderControl(app) {
  const list = plannedOrder(app.sd.participants);
  keyedList($('#order-list'), list, {
    key: p => p.id,
    create: () => el('li', { class: 'order-row' },
      el('button', { type: 'button', class: 'link open', 'data-act': 'open' }),
      el('span', { class: 'pill status' }),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'mini', 'data-act': 'ncs' }),
      el('button', { type: 'button', class: 'mini', 'data-act': 'up' }, '↑'),
      el('button', { type: 'button', class: 'mini', 'data-act': 'down' }, '↓')),
    update: (li, p) => {
      const [open, status, , ncsB, up, down] = li.children;
      const isNcs = app.s.ncsId === p.id;
      setText(ncsB, isNcs ? '★ NCS' : '☆ NCS');
      setAttr(ncsB, 'aria-pressed', String(isNcs));
      setAttr(ncsB, 'aria-label', t('ncs.assignLabel', { call: callText(p) }));
      ncsB.disabled = app.readOnly;
      const i = list.indexOf(p);
      setText(open, `${i + 1}. ${callText(p)}${p.name ? ` · ${p.name}` : ''}`);
      setAttr(open, 'aria-label', t('control.openLabel', { call: callText(p) }));
      setText(status, statusLabel(p.status));
      setAttr(up, 'aria-label', t('roster.upLabel', { call: callText(p) }));
      setAttr(down, 'aria-label', t('roster.downLabel', { call: callText(p) }));
      up.disabled = i === 0 || app.readOnly;
      down.disabled = i === list.length - 1 || app.readOnly;
    },
  });
  if (!list.length) fill($('#order-list'), el('li', { class: 'empty', 'data-key': '' }, t('control.empty')));

  // net control: current, the series' suggestion, the handovers
  const ncs = app.participant(app.s.ncsId);
  setText($('#ncs-current'), ncs ? t('ncs.is', { call: `${callText(ncs)}${ncs.name ? ` · ${ncs.name}` : ''}` }) : t('ncs.none'));
  const sug = app.s.suggestedNcs;
  const sugP = sug && app.sd.participants.find(p => p.base === baseCall(sug) && !p.deleted);
  const sugBox = $('#ncs-suggest');
  sugBox.hidden = !sug || (sugP && sugP.id === app.s.ncsId);
  if (!sugBox.hidden) {
    const sig = `${sug}|${sugP ? sugP.id : ''}|${app.lang()}|${app.readOnly}`;
    if (sugBox.dataset.sig !== sig) {
      sugBox.dataset.sig = sig;
      fill(sugBox, t('ncs.suggestion', { call: sug }), ' ', sugP ? el('button', { type: 'button', class: 'mini', 'data-pid': sugP.id, disabled: app.readOnly }, t('ncs.assignSuggested', { call: callText(sugP) })) : t('ncs.notCheckedIn'));
    }
  }
  const handovers = liveOf(app.sd.events).filter(e => e.type === 'ncs').sort((a, b) => cmp(a.created, b.created));
  const byId = new Map(app.sd.participants.map(p => [p.id, p]));
  keyedList($('#ncs-history'), handovers, {
    key: e => e.id,
    create: () => el('li', { class: 'ncs-row' },
      el('label', { class: 'inline-field' }, el('span', {}), el('input', { class: 'ev-time mono', inputmode: 'numeric', size: 5, autocorrect: 'off', placeholder: 'HH:MM' })),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', class: 'ev-est' }), el('span', {})),
      el('span', { class: 'ev-what' })),
    update: (li, e) => {
      const [tl, el2, what] = li.children;
      setText(tl.firstChild, t('ncs.time'));
      setValue(tl.lastChild, e.time && e.time.iso ? e.time.iso.slice(11, 16) : '');
      tl.lastChild.disabled = app.readOnly;
      el2.firstChild.checked = !!(e.time && e.time.quality === 'estimated');
      el2.firstChild.disabled = app.readOnly;
      setText(el2.lastChild, t('ncs.estimated'));
      const name = id => (id && byId.get(id) ? callText(byId.get(id)) : '—');
      setText(what, `${name(e.from)} → ${name(e.to)}`);
    },
  });
  if (!handovers.length) fill($('#ncs-history'), el('li', { class: 'empty', 'data-key': '' }, t('ncs.noHandovers')));

  const rounds = roundsSorted(app.sd.rounds);
  const counts = new Map();
  for (const n of liveOf(app.sd.notes)) counts.set(n.roundId, (counts.get(n.roundId) || 0) + 1);
  keyedList($('#round-list'), rounds, {
    key: r => r.id,
    create: () => el('li', { class: 'round-row' },
      el('label', { class: 'inline-field' }, el('span', {}), el('input', { class: 'round-no mono', inputmode: 'numeric', size: 3, autocorrect: 'off' })),
      el('label', { class: 'inline-field grow' }, el('span', {}), el('input', { class: 'round-topic', autocorrect: 'off' })),
      el('span', { class: 'hint count' }),
      el('button', { type: 'button', class: 'mini', 'data-act': 'current' })),
    update: (li, r) => {
      const [noL, topicL, count, cur] = li.children;
      setText(noL.firstChild, t('round.number'));
      setText(topicL.firstChild, t('round.topic'));
      setValue(noL.lastChild, String(r.number));
      setValue(topicL.lastChild, r.topic || '');
      noL.lastChild.disabled = topicL.lastChild.disabled = app.readOnly;
      setText(count, t('round.notesCount', { n: counts.get(r.id) || 0 }));
      const isCur = r.id === app.s.currentRoundId;
      li.classList.toggle('current', isCur);
      setText(cur, isCur ? t('round.current') : t('round.makeCurrent'));
      setAttr(cur, 'aria-pressed', String(isCur));
      setAttr(cur, 'aria-label', isCur ? t('round.isCurrentLabel', { n: r.number }) : t('round.makeCurrentLabel', { n: r.number }));
      cur.disabled = app.readOnly || isCur;
    },
  });

  const notes = new Map(app.sd.notes.map(n => [n.id, n]));
  const tasks = liveOf(app.sd.items).filter(i => i.kind === 'task' && i.active !== false && (!i.noteId || (notes.get(i.noteId) && !notes.get(i.noteId).deleted)))
    .sort((a, b) => (a.state === 'done') - (b.state === 'done') || cmp(a.created, b.created));
  keyedList($('#task-list'), tasks, {
    key: i => i.id,
    create: i => el('li', { class: 'task-row' },
      el('input', { type: 'checkbox', class: 'item-done' }),
      i.noteId ? el('span', { class: 'task-note' }) : el('input', { class: 'task-text', autocorrect: 'off' }),
      i.noteId ? el('button', { type: 'button', class: 'mini link', 'data-act': 'open' }) : null),
    update: (li, i) => {
      const [cb, body, open] = li.children;
      const n = i.noteId ? notes.get(i.noteId) : null;
      const p = n ? app.sd.participants.find(x => x.id === n.participantId) : null;
      const what = n ? `${p ? callText(p) : '?'}: ${n.text}` : i.text;
      cb.checked = i.state === 'done';
      cb.disabled = app.readOnly;
      setAttr(cb, 'aria-label', t('control.taskDone', { what }));
      li.classList.toggle('done', i.state === 'done');
      if (n) setText(body, what); else { setValue(body, i.text); setAttr(body, 'aria-label', t('control.taskText')); body.disabled = app.readOnly; }
      if (open) { open.dataset.pid = p ? p.id : ''; open.dataset.note = n.id; setText(open, t('turn.toNote')); setAttr(open, 'aria-label', t('turn.toNoteLabel', { call: p ? callText(p) : '?' })); }
    },
  });
  if (!tasks.length) fill($('#task-list'), el('li', { class: 'empty', 'data-key': '' }, t('control.noTasks')));
  for (const f of $('#task-form').elements) f.disabled = app.readOnly;
  $('#btn-new-round').disabled = app.readOnly;
}
