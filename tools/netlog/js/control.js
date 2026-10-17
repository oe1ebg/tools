// Net Control: the roster with its planned speaking order. Planning and
// display order never change the actual speaking history, and nothing
// here starts a round.

import { $, el, fill } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { keyedList, setText, setAttr, setValue } from './keyed.js';
import { rosterSorted, roundsSorted, liveOf, cmp, timeOf, callBase, STATUSES, netStyle, ncsFirst, isUnresolved } from './model.js';
import { updateSession, addParticipant, setStatus, moveParticipant, setCurrentRound, updateRound, setItemDone, addTask, setItemText, setNcs, setEventTime, deleteParticipant, eraseParticipant } from './ops.js';
import { callText, statusLabel } from './roster.js';
import { expandedCount, setExpandedCount } from './notes.js';
import { hm, zone, parseHm } from './clock.js';
import { STATUS_MARK } from './roster.js';
import { startNextRound, turnMark } from './speak.js';
import { initExport, renderExport } from './exportui.js';
import { provenanceButton, renderProvenance, openProvenance } from './historyui.js';
import { prefSet } from '../../shared/js/prefs.js';
import { OWN_PREF } from './sessions.js';
import { isOwn } from './roster.js';
import { attachRepeaterField, attachCallField } from './fieldsearch.js';

// Planned order first (stations without one after them, in roster order).
// The list in Net Control: the roster (= speaking) order, the NCS first.
export function plannedOrder(participants, ncsId = null) {
  return ncsFirst(rosterSorted(participants), ncsId);
}

export function initControl(app) {
  initExport(app);
  // one click: the next round starts (number and topic are corrected in
  // the round list; undo takes it back)
  $('#btn-new-round').addEventListener('click', () => startNextRound(app));
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

  // the session's own facts, changed in place: my callsign (marked "me"),
  // name, repeater
  const se = $('#session-edit');
  attachRepeaterField(app, $('#se-repeater'), { freq: $('#se-freq'), mode: $('#se-mode'), hint: $('#se-mode-hint') });
  attachCallField(app, $('#se-own'));
  se.addEventListener('submit', ev => ev.preventDefault());
  se.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.matches('input')) { ev.preventDefault(); ev.target.dispatchEvent(new Event('change', { bubbles: true })); } });
  se.addEventListener('change', async ev => {
    const f = ev.target;
    if (f.id === 'se-own') {
      const r = await app.act(store => updateSession(store, app.ctx(), app.s.id, { own: f.value }));
      if (r && r.own.call) prefSet(OWN_PREF, r.own.call);
      if (r) app.announce(t('control.ownSaved', { call: r.own.call || '—' }));
    }
    if (f.id === 'se-name') await app.act(store => updateSession(store, app.ctx(), app.s.id, { name: f.value.trim() }));
    if (f.id === 'se-style') {
      const r = await app.act(store => updateSession(store, app.ctx(), app.s.id, { style: f.value }));
      if (r) app.announce(t(`style.${r.style}`));
    }
    if (f.id === 'se-repeater') await app.act(store => updateSession(store, app.ctx(), app.s.id, { radio: { repeater: f.value.trim() } }));
    if (f.id === 'se-freq') await app.act(store => updateSession(store, app.ctx(), app.s.id, { radio: { freq: f.value.trim() } }));
    if (f.id === 'se-mode') await app.act(store => updateSession(store, app.ctx(), app.s.id, { radio: { mode: f.value } }));
  });
  $('#btn-checkin-own').addEventListener('click', async () => {
    const r = await app.act(store => addParticipant(store, app.ctx(), { call: app.s.own.call }));
    if (r) app.announce(t('checkin.done', { call: callText(r) }));
  });
  $('#ncs-suggest').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-pid]');
    if (b) await app.act(store => setNcs(store, app.ctx(), b.dataset.pid));
  });
  // a handover's time: HH:MM in the shown zone (UTC or local, on the
  // event's date there) and whether it is an estimate; a correction keeps
  // a revision and can be undone
  $('#ncs-history').addEventListener('change', async ev => {
    const li = ev.target.closest('li');
    if (!li) return;
    const ev0 = app.sd.events.find(e => e.id === li.dataset.key);
    const tf = li.querySelector('input.ev-time');
    const est = li.querySelector('input.ev-est');
    const base = ev0.time && ev0.time.iso ? ev0.time.iso : ev0.created;
    const typed = tf.value.trim();
    const iso = typed ? (/^\d{1,2}:\d{2}$/.test(typed) ? parseHm(typed, base) : null) : null;
    if (typed && !iso) { tf.setAttribute('aria-invalid', 'true'); app.announce(t('ncs.badTime', { zone: zone(base) })); return; }
    tf.removeAttribute('aria-invalid');
    await app.act(store => setEventTime(store, app.ctx(), ev0.id, timeOf(iso, est.checked ? 'estimated' : 'exact')));
  });
  $('#removed-list').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('li').dataset.key;
    const p = app.sd.participants.find(x => x.id === id);
    if (b.dataset.act === 'restore') {
      const r = await app.act(store => deleteParticipant(store, app.ctx(), id, true));
      if (r) app.announce(t('station.restored', { call: callText(p) }));
    }
    if (b.dataset.act === 'erase' && globalThis.confirm(t('station.eraseConfirm', { call: callText(p) }))) {
      const r = await app.act(store => eraseParticipant(store, app.ctx(), id));
      if (r) app.announce(t('station.erased', { call: callText(p) }));
    }
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
    const f = ev.target.closest('button[data-act=from]');
    if (f) openProvenance(app, app.sd.items.find(i => i.id === f.closest('li').dataset.key));
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

  $('#order-list').addEventListener('change', async ev => {
    const sel = ev.target.closest('select.status-sel');
    if (!sel) return;
    const id = sel.closest('li').dataset.key;
    const p = app.participant(id);
    const r = await app.act(store => setStatus(store, app.ctx(), id, sel.value));
    if (r && p) app.announce(t('control.statusChanged', { call: callText(p), status: statusLabel(sel.value) }));
  });
  $('#order-list').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('li').dataset.key;
    if (b.dataset.act === 'open') { app.openStation(id); return; }
    if (b.dataset.act === 'me') {
      // this station is me: the session's own callsign
      const p = app.participant(id);
      const r = await app.act(store => updateSession(store, app.ctx(), app.s.id, { own: isOwn(app, p) ? '' : p.call }));
      if (r && r.own.call) prefSet(OWN_PREF, r.own.call);
      if (r) app.announce(t('control.ownSaved', { call: r.own.call || '—' }));
      $('#order-list').querySelector(`li[data-key="${CSS.escape(id)}"] button[data-act="me"]`)?.focus();
      return;
    }
    if (b.dataset.act === 'ncs') {
      const on = app.s.ncsId !== id;
      const r = await app.act(store => setNcs(store, app.ctx(), on ? id : null));
      if (r) app.announce(t(on ? 'ncs.assigned' : 'ncs.cleared', { call: callText(app.participant(id)) }));
      $('#order-list').querySelector(`li[data-key="${CSS.escape(id)}"] button[data-act="ncs"]`)?.focus();
      return;
    }
    const dir = b.dataset.act === 'up' ? -1 : 1;
    const moved = await app.act(store => moveParticipant(store, app.ctx(), id, dir, 'rosterOrder'));
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
  const list = plannedOrder(app.sd.participants, app.s.ncsId);
  keyedList($('#order-list'), list, {
    key: p => p.id,
    create: () => el('li', { class: 'order-row' },
      el('span', { class: 'st-mark', 'aria-hidden': 'true' }),
      el('button', { type: 'button', class: 'link open', 'data-act': 'open' }),
      el('label', { class: 'inline-field status-field' }, el('span', { class: 'sr-only' }), el('select', { class: 'status-sel' })),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'mini', 'data-act': 'me' }),
      el('button', { type: 'button', class: 'mini', 'data-act': 'ncs' }),
      el('button', { type: 'button', class: 'mini', 'data-act': 'up' }, '↑'),
      el('button', { type: 'button', class: 'mini', 'data-act': 'down' }, '↓')),
    update: (li, p) => {
      const [mark, open, status, , meB, ncsB, up, down] = li.children;
      const isNcs = app.s.ncsId === p.id;
      const me = isOwn(app, p);
      // the same marks as the roster: status, speaking now, next
      const turn = turnMark(app, p);
      setText(mark, turn === 'on-air' ? '●' : turn === 'next' ? '▶' : STATUS_MARK[p.status] || '');
      li.classList.toggle('on-air', turn === 'on-air');
      li.classList.toggle('up-next', turn === 'next');
      setText(meB, me ? `★ ${t('own.badge')}` : `☆ ${t('own.badge')}`);
      setAttr(meB, 'aria-pressed', String(me));
      setAttr(meB, 'aria-label', t('own.setLabel', { call: callText(p) }));
      meB.disabled = app.readOnly || isUnresolved(p.call);
      li.classList.toggle('own', isOwn(app, p));
      li.classList.toggle('ncs', isNcs);
      setText(ncsB, isNcs ? '★ NCS' : '☆ NCS');
      setAttr(ncsB, 'aria-pressed', String(isNcs));
      setAttr(ncsB, 'aria-label', t('ncs.assignLabel', { call: callText(p) }));
      ncsB.disabled = app.readOnly;
      const i = list.indexOf(p);
      setText(open, `${i + 1}. ${callText(p)}${p.name ? ` · ${p.name}` : ''}${isOwn(app, p) ? ` (${t('own.badge')})` : ''}`);
      setAttr(open, 'aria-label', t('control.openLabel', { call: callText(p) }));
      // the station's state, switched here like in its head: checking out
      // closes its presence, coming back opens a new interval
      const [lab, sel] = status.children;
      setText(lab, t('control.statusLabel', { call: callText(p) }));
      if (sel.options.length !== STATUSES.length || sel.dataset.lang !== app.lang()) {
        fill(sel, STATUSES.map(st => el('option', { value: st }, statusLabel(st))));
        sel.dataset.lang = app.lang();
      }
      if (document.activeElement !== sel) sel.value = p.status;
      sel.disabled = app.readOnly;
      li.classList.toggle('out', p.status === 'out');
      for (const s of STATUSES) li.classList.toggle(`st-${s}`, p.status === s);

      setAttr(up, 'aria-label', t('roster.upLabel', { call: callText(p) }));
      setAttr(down, 'aria-label', t('roster.downLabel', { call: callText(p) }));
      // the NCS stays first
      const ncsTop = list[0] && list[0].id === app.s.ncsId ? 1 : 0;
      up.disabled = isNcs || i <= ncsTop || app.readOnly;
      down.disabled = isNcs || i === list.length - 1 || app.readOnly;
    },
  });
  if (!list.length) fill($('#order-list'), el('li', { class: 'empty', 'data-key': '' }, t('control.empty')));

  setValue($('#se-own'), app.s.own.call || '');
  setValue($('#se-name'), app.s.name || '');
  setValue($('#se-repeater'), (app.s.radio && app.s.radio.repeater) || '');
  setValue($('#se-freq'), (app.s.radio && app.s.radio.freq) || '');
  if (document.activeElement !== $('#se-style')) $('#se-style').value = netStyle(app.s);
  if (document.activeElement !== $('#se-mode')) $('#se-mode').value = (app.s.radio && app.s.radio.mode) || '';
  renderExport(app);
  for (const f of $('#session-edit').elements) f.disabled = app.readOnly;
  const ownIn = app.s.own.base && app.sd.participants.some(p => !p.deleted && p.base === app.s.own.base);
  const ob = $('#btn-checkin-own');
  ob.hidden = !app.s.own.call || ownIn;
  setText(ob, t('control.checkinOwn', { call: app.s.own.call || '' }));
  ob.disabled = app.readOnly;

  // net control: current, the series' suggestion, the handovers
  const ncs = app.participant(app.s.ncsId);
  setText($('#ncs-current'), ncs ? t('ncs.is', { call: `${callText(ncs)}${ncs.name ? ` · ${ncs.name}` : ''}` }) : t('ncs.none'));
  const sug = app.s.suggestedNcs;
  const sugP = sug && app.sd.participants.find(p => p.base === callBase(sug) && !p.deleted);
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
      setText(tl.firstChild, t('ncs.time', { zone: zone(e.time && e.time.iso) }));
      setValue(tl.lastChild, e.time && e.time.iso ? hm(e.time.iso) : '');
      tl.lastChild.disabled = app.readOnly;
      // set the box only when the stored value changed: a click waiting for
      // its save is not undone by a re-render (Safari does not focus a
      // clicked checkbox, so focus cannot tell)
      const stored = String(!!(e.time && e.time.quality === 'estimated'));
      if (el2.firstChild.dataset.stored !== stored) {
        el2.firstChild.dataset.stored = stored;
        el2.firstChild.checked = stored === 'true';
      }
      el2.firstChild.disabled = app.readOnly;
      setText(el2.lastChild, t('ncs.estimated'));
      const name = id => (id && byId.get(id) ? callText(byId.get(id)) : '—');
      setText(what, `${name(e.from)} → ${name(e.to)}`);
    },
  });
  if (!handovers.length) fill($('#ncs-history'), el('li', { class: 'empty', 'data-key': '' }, t('ncs.noHandovers')));

  // removed (soft-deleted) stations: restore or erase; merged ones are
  // part of another station now and only come back through undo
  const removed = app.sd.participants.filter(p => p.deleted && !p.mergedInto).sort((a, b) => cmp(b.deleted, a.deleted));
  keyedList($('#removed-list'), removed, {
    key: p => p.id,
    create: () => el('li', { class: 'task-row' }, el('span', { class: 'task-note' }),
      el('button', { type: 'button', class: 'mini', 'data-act': 'restore' }),
      el('button', { type: 'button', class: 'mini danger', 'data-act': 'erase' })),
    update: (li, p) => {
      const [name, rb, eb] = li.children;
      setText(name, `${callText(p)}${p.name ? ` · ${p.name}` : ''}`);
      setText(rb, t('common.restore'));
      setText(eb, t('station.erase'));
      rb.setAttribute('aria-label', t('station.restoreLabel', { call: callText(p) }));
      eb.setAttribute('aria-label', t('station.eraseLabel', { call: callText(p) }));
      rb.disabled = eb.disabled = app.readOnly;
    },
  });
  if (!removed.length) fill($('#removed-list'), el('li', { class: 'hint', 'data-key': '' }, t('control.noRemoved')));

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
      i.noteId ? el('button', { type: 'button', class: 'mini link', 'data-act': 'open' }) : provenanceButton(i)),
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
      if (open && !n) renderProvenance(open, i);
      if (open && n) { open.dataset.pid = p ? p.id : ''; open.dataset.note = n.id; setText(open, t('turn.toNote')); setAttr(open, 'aria-label', t('turn.toNoteLabel', { call: p ? callText(p) : '?' })); }
    },
  });
  if (!tasks.length) fill($('#task-list'), el('li', { class: 'empty', 'data-key': '' }, t('control.noTasks')));
  for (const f of $('#task-form').elements) f.disabled = app.readOnly;
  $('#btn-new-round').disabled = app.readOnly;
}
