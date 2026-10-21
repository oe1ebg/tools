// Live Notes for the selected station: its notes per round (newest round
// first; the current and previous ones expanded, configurable), each note
// one observation, editable in place, and the composer at the end of the
// current round. Enter saves the item and moves to the next one (the
// composer); Shift+Enter is a new line; an empty Enter saves nothing; an
// Enter that confirms an IME composition is not a save. Unsaved text is a
// draft (drafts.js) and comes back after a switch or a reload with its
// selection.
//
// Row focus model: a note row (li, tabindex -1) is the note's navigation
// surface: j/k move between rows, Enter edits the text, r toggles the
// on-air flag. Its buttons (flag, task, delete) act without navigating.

import { $, el, fill, isComposing } from '../../shared/js/dom.js';
import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { newId } from '../../shared/js/time.js';
import { t } from './i18n.js';
import { keyedList, setText, setAttr, setValue, setNamed } from './keyed.js';
import { roundsSorted, notesOf, responseOf, roundCounts, live, rosterSorted } from './model.js';
import { createNote, updateNote, deleteNote, toggleResponse, toggleTask, setItemText, setItemDone, moveNotes, addContribution } from './ops.js';
import { callText, isOwn } from './roster.js';
import { nextSpeaker } from './speak.js';
import { hm, zone, timeMode } from './clock.js';

export const EXPANDED_PREF = 'oe1ebg-netlog-expanded';

export function expandedCount() {
  const n = Number(prefGet(EXPANDED_PREF, '2'));
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : 2;
}
export function setExpandedCount(n) {
  prefSet(EXPANDED_PREF, String(n));
}

// Whether a round section is open: the user's choice, else the newest
// `expandedCount()` rounds up to the current one.
export function roundOpen(app, round, sorted) {
  const k = app.ui.roundOpen[round.id];
  if (k !== undefined) return k;
  const cur = sorted.findIndex(r => r.id === app.s.currentRoundId);
  const i = sorted.findIndex(r => r.id === round.id);
  return cur >= 0 ? i <= cur && cur - i < expandedCount() : sorted.length - i <= expandedCount();
}

export const composerKey = pid => `new:${pid}`;
export const noteKey = id => `note:${id}`;
export const replyKey = id => `item:${id}`;

// Grow a text field with its content (CSSOM, allowed by the policy). A
// field not on the page (or hidden) has no height to measure yet: it is
// measured once it is shown, never collapsed to nothing.
export function autosize(ta) {
  if (!ta.isConnected || !ta.offsetParent) {
    ta.style.height = '';
    if (!ta.dataset.sizePending) {
      ta.dataset.sizePending = '1';
      requestAnimationFrame(() => { delete ta.dataset.sizePending; if (ta.isConnected && ta.offsetParent) autosize(ta); });
    }
    return;
  }
  ta.style.height = 'auto';
  ta.style.height = `${Math.max(ta.scrollHeight + 2, 0)}px`;
}

// "19:42 UTC", "~19:42 UTC" (estimated), "—" (unknown). In local time the
// lines carry no zone name (the header switch says which zone it is).
const fmtTime = time => (time && time.iso ? `${time.quality === 'estimated' ? '~' : ''}${hm(time.iso)}${timeMode() === 'utc' ? ` ${zone(time.iso)}` : ''}` : '—');

export function initNotes(app) {
  // the composer's own id per station: a retried save never doubles a note
  const composerIds = {};
  app.composerId = pid => (composerIds[pid] ||= newId());
  app.resetComposerId = pid => { delete composerIds[pid]; };
  initNoteList(app, $('#station-rounds'));
  initMoveDialog(app);
}

// The note editing of a list of note rows (Live Notes, Continuous Log):
// the same handlers on the same note objects.
export function initNoteList(app, box) {
  box.addEventListener('click', ev => {
    const toggle = ev.target.closest('button.round-toggle:not(.log-toggle)');
    if (toggle) {
      const rid = toggle.closest('section.round').dataset.key;
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      app.ui.roundOpen[rid] = open;
      renderNotes(app);
      return;
    }
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const li = b.closest('li.note');
    const id = li && li.dataset.key;
    if (b.dataset.act === 'flag') flagNote(app, id);
    if (b.dataset.act === 'task') app.act(store => toggleTask(store, app.ctx(), id));
    if (b.dataset.act === 'delete') deleteWithUndo(app, id, li);
    if (b.dataset.act === 'move') openMoveDialog(app, [id]);
    if (b.dataset.act === 'station') app.openFrom(b.dataset.pid, { noteId: id, field: 'row' });
    if (b.dataset.act === 'save-new' || b.dataset.act === 'flag-new') {
      const ta = b.closest('.composer').querySelector('textarea.composer-text');
      saveComposer(app, ta, b.dataset.act === 'flag-new');
      ta.focus();
    }
  });
  box.addEventListener('change', ev => {
    const cb = ev.target.closest('input.item-done');
    if (cb) app.act(store => setItemDone(store, app.ctx(), cb.dataset.item, cb.checked));
  });
  box.addEventListener('input', ev => {
    const ta = ev.target;
    if (!ta.matches('textarea')) return;
    autosize(ta);
    const key = ta.dataset.draft;
    if (key) app.drafts.typed(key, ta, ta.dataset.base || null);
    if (ta.classList.contains('composer-text') && ta.value.trim()) goOnAir(app, ta.dataset.pid);
  });
  box.addEventListener('select', ev => { if (ev.target.dataset.draft) app.drafts.selection(ev.target.dataset.draft, ev.target); });
  box.addEventListener('keydown', ev => {
    const ta = ev.target;
    if (!ta.matches || !ta.matches('textarea')) return;
    // new-note field: Ctrl/⌘+Enter saves and moves on to the next station,
    // Ctrl/⌘+Shift+Enter saves it as a question (an on-air response is
    // expected); Shift+Enter is a plain line break (the default)
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !isComposing(ev) && ta.classList.contains('composer-text')) {
      ev.preventDefault();
      if (ev.shiftKey) saveComposer(app, ta, true);
      else saveComposer(app, ta).then(() => nextSpeaker(app));
      return;
    }
    if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey || isComposing(ev)) return;
    ev.preventDefault();
    if (ta.classList.contains('composer-text')) saveComposer(app, ta);
    else if (ta.classList.contains('note-text')) saveNoteText(app, ta, true);
    else if (ta.classList.contains('reply-text')) saveReply(app, ta, true);
  });
  // leaving an edited note or reply saves it
  box.addEventListener('focusout', ev => {
    const ta = ev.target;
    if (!ta.matches || !ta.matches('textarea')) return;
    if (ta.classList.contains('note-text')) saveNoteText(app, ta, false);
    if (ta.classList.contains('reply-text')) saveReply(app, ta, false);
  });
}

// Typing a note for a station means it is speaking: record its turn once
// (not when it is the last speaker already; free-form nets too).
const onAirPending = new Set();
async function goOnAir(app, pid) {
  const p = app.participant(pid);
  if (!p || app.readOnly || !app.s || isOwn(app, p) || onAirPending.has(pid)) return;
  if (app.speak && app.speak.onAir && app.speak.onAir.id === pid) return;
  if (!['active', 'unconfirmed'].includes(p.status)) return;
  onAirPending.add(pid);
  try {
    const c = await app.act(store => addContribution(store, app.ctx(), pid));
    if (c) app.announce(t('speak.nowOnAir', { call: callText(p) }));
  } finally { onAirPending.delete(pid); }
}

async function deleteWithUndo(app, id, li) {
  const next = li.nextElementSibling || li.previousElementSibling;
  const r = await app.act(store => deleteNote(store, app.ctx(), id));
  if (!r) return;
  app.announce(t('note.deleted'));
  const target = next && next.isConnected ? next : $('#station-rounds .composer-text');
  if (target) target.focus();
}

export async function flagNote(app, id) {
  const item = await app.act(store => toggleResponse(store, app.ctx(), id));
  if (item) app.announce(t(item.active !== false && item.state !== 'done' ? 'note.flagged' : 'note.unflagged'));
  return item;
}

async function saveComposer(app, ta, asQuestion = false) {
  // the station this composer belongs to (not whatever is selected now)
  const p = app.participant(ta.dataset.pid);
  const text = ta.value.replace(/\s+$/, '');
  if (!p || !text.trim()) return; // an empty Enter saves nothing
  const flagged = asQuestion || !!app.ui.composeFlag;
  // this note's id; the next one typed meanwhile gets a new one
  const id = app.composerId(p.id);
  app.resetComposerId(p.id);
  const key = composerKey(p.id);
  // the field empties at once: the next note can be typed while this one saves
  ta.value = '';
  autosize(ta);
  app.ui.composeFlag = false;
  const note = await app.drafts.commit(key, k => app.act(store => createNote(store, app.ctx(), { participantId: p.id, text, flagged, id, draftKey: k }), { keepFocus: true }));
  if (!note) {
    if (!ta.value) { ta.value = text; autosize(ta); app.drafts.typed(key, ta); }
    app.ui.composeFlag = flagged;
    return;
  }
  app.announce(t(flagged ? 'note.savedFlagged' : 'note.saved'));
}

async function saveNoteText(app, ta, moveOn) {
  const id = ta.closest('li.note').dataset.key;
  const note = app.sd.notes.find(n => n.id === id);
  if (!note) return;
  const text = ta.value.replace(/\s+$/, '');
  const key = noteKey(id);
  if (!text.trim()) {
    // an emptied note is not saved (× deletes it): the saved text comes back
    if (moveOn) app.announce(t('note.emptyNotSaved'));
    ta.value = note.text;
    autosize(ta);
    await app.drafts.discard(key);
  } else if (text !== note.text) {
    await app.drafts.commit(key, k => app.act(store => updateNote(store, app.ctx(), id, text, k), { keepFocus: true }));
  } else if (app.drafts.get(key)) {
    await app.drafts.discard(key);
  }
  if (moveOn) {
    // Live Notes: on to the composer; elsewhere (the log): the row
    const c = ta.closest('#station-rounds') && $('#station-rounds .composer-text');
    if (c) c.focus();
    else if (ta.closest('li.note')) ta.closest('li.note').focus();
  }
}

async function saveReply(app, ta, moveOn) {
  const id = ta.dataset.item;
  const item = app.sd.items.find(i => i.id === id);
  if (!item) return;
  const text = ta.value.replace(/\s+$/, '');
  const key = replyKey(id);
  if (text !== (item.text || '')) await app.drafts.commit(key, k => app.act(store => setItemText(store, app.ctx(), id, text, k), { keepFocus: true }));
  else if (app.drafts.get(key)) await app.drafts.discard(key);
  if (moveOn) {
    const li = ta.closest('li');
    if (li) li.focus();
  }
}


export function noteRow() {
  return el('li', { class: 'note', tabindex: '-1' },
    el('div', { class: 'note-main' },
      // the time (and in the log the station) in front of the note, the
      // badges after it: no extra line for them
      el('div', { class: 'note-lead' }, el('span', { class: 'time mono' }), el('button', { type: 'button', class: 'link station', 'data-act': 'station', hidden: true })),
      el('textarea', { class: 'note-text', rows: 1, spellcheck: 'true' }),
      el('div', { class: 'note-meta' }, el('span', { class: 'badges' }), el('span', { class: 'draft-mark hint' }))),
    el('div', { class: 'note-tools' },
      el('input', { type: 'checkbox', class: 'note-select', hidden: true }),
      el('button', { type: 'button', class: 'mini flag', 'data-act': 'flag' }),
      el('button', { type: 'button', class: 'mini task', 'data-act': 'task' }),
      el('button', { type: 'button', class: 'mini', 'data-act': 'move', 'aria-haspopup': 'dialog' }),
      el('button', { type: 'button', class: 'mini danger', 'data-act': 'delete' }, '×')),
    el('div', { class: 'reply' }));
}

// opts.station: show the station link (the log); opts.select: the
// selection checkbox (bulk move), with opts.selected.
export function updateNoteRow(app, li, n, p, round, opts = {}) {
  const [main, tools, reply] = li.children;
  const [lead, ta, meta] = main.children;
  const [time, stationB] = lead.children;
  const [badges, draftMark] = meta.children;
  stationB.hidden = !opts.station;
  if (opts.station) {
    stationB.dataset.pid = p.id;
    setText(stationB, `${callText(p)}${p.name ? ` · ${p.name}` : ''}`);
    setNamed(stationB, t('log.openStation', { call: callText(p) }));
  }
  const key = noteKey(n.id);
  const draft = app.drafts.get(key);
  ta.dataset.draft = key;
  ta.dataset.base = n.updated;
  setValue(ta, draft ? draft.text : n.text);
  if (document.activeElement !== ta) autosize(ta);
  ta.readOnly = app.readOnly;
  const label = t('note.label', { call: callText(p), round: round.number });
  setAttr(ta, 'aria-label', label);
  setText(time, fmtTime(n.time));
  setText(draftMark, draft ? t('note.draft') : '');
  const resp = responseOf(app.sd.items, n.id);
  const task = responseOf(app.sd.items, n.id, 'task');
  const flagged = !!resp && resp.active !== false;
  const respDone = flagged && resp.state === 'done';
  const taskOn = !!task && task.active !== false;
  const marks = [];
  if (flagged) marks.push({ text: t(respDone ? 'note.respDone' : 'note.respOpen'), cls: respDone ? 'ok' : 'warn' });
  if (taskOn) marks.push({ text: t(task.state === 'done' ? 'note.taskDone' : 'note.taskOpen'), cls: task.state === 'done' ? 'ok' : '' });
  const sig = marks.map(m => m.text).join('|');
  if (badges.dataset.sig !== sig) { badges.dataset.sig = sig; fill(badges, marks.map(m => el('span', { class: `pill ${m.cls}` }, m.text))); }
  meta.hidden = !marks.length && !draft;
  li.classList.toggle('flagged', flagged && !respDone);
  setAttr(li, 'aria-label', `${label}: ${n.text}${flagged ? `, ${marks[0].text}` : ''}`);
  setAttr(li, 'data-nav', 'note');
  const [sel, flagB, taskB, moveB, delB] = tools.children;
  sel.hidden = !opts.select;
  sel.checked = !!opts.selected;
  setAttr(sel, 'aria-label', t('log.selectLabel', { what: `${callText(p)}: ${n.text}` }));
  setText(moveB, t('note.moveShort'));
  setNamed(moveB, t('note.moveLabel'));
  setText(flagB, flagged && !respDone ? t('note.unflagShort') : t('note.flagShort'));
  setAttr(flagB, 'aria-pressed', String(flagged && !respDone));
  setNamed(flagB, t('note.flagLabel', { call: callText(p) }));
  setText(taskB, t('note.taskShort'));
  setAttr(taskB, 'aria-pressed', String(taskOn));
  setNamed(taskB, t('note.taskLabel'));
  setAttr(delB, 'aria-label', t('note.deleteLabel'));
  for (const b of tools.children) b.disabled = app.readOnly;
  // the prepared reply and the completion of the response, and the task
  const parts = [];
  if (flagged) parts.push({ kind: 'resp', item: resp });
  if (taskOn) parts.push({ kind: 'task', item: task });
  keyedList(reply, parts, {
    key: x => x.item.id,
    create: x => (x.kind === 'resp'
      ? el('div', { class: 'reply-row' },
        el('label', { class: 'field reply-field' }, el('span', {}, t('note.replyLabel')), el('textarea', { class: 'reply-text', rows: 1 })),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', class: 'item-done' }), el('span', {})))
      : el('div', { class: 'reply-row task-row' },
        el('label', { class: 'check' }, el('input', { type: 'checkbox', class: 'item-done' }), el('span', {})))),
    update: (row, x) => {
      const cb = row.querySelector('input.item-done');
      cb.dataset.item = x.item.id;
      cb.checked = x.item.state === 'done';
      cb.disabled = app.readOnly;
      setText(cb.nextElementSibling, t(x.kind === 'resp' ? 'note.respDoneLabel' : 'note.taskDoneLabel'));
      const rt = row.querySelector('textarea.reply-text');
      if (rt) {
        const k = replyKey(x.item.id);
        const d = app.drafts.get(k);
        rt.dataset.draft = k;
        rt.dataset.item = x.item.id;
        setValue(rt, d ? d.text : x.item.text || '');
        if (document.activeElement !== rt) autosize(rt);
        rt.readOnly = app.readOnly;
        setText(row.querySelector('.reply-field > span'), t('note.replyLabel'));
      }
    },
  });
}

let nextBtn = null;
// The platform's command key, as it is printed on it.
const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator ? navigator.platform : '') ? '⌘' : 'Ctrl';

// Key caps for a shortcut, one <kbd> per key (the shortcut is also on the
// button as aria-keyshortcuts, so the caps are decoration).
function keyCaps(keys) {
  return el('span', { class: 'keycaps', 'aria-hidden': 'true' }, keys.map(k => el('kbd', {}, k)));
}

export function renderNotes(app) {
  const box = $('#station-rounds');
  const p = app.participant(app.ui.selected);
  // the Next button lives in the current round's composer; park it while
  // that is rebuilt or gone
  // (kept by reference: the document no longer finds it while detached)
  nextBtn ||= $('#btn-next');
  const park = () => { if (!nextBtn.isConnected) $('#next-park').append(nextBtn); };
  if (!p || !app.s) { fill(box); park(); return; }
  const sorted = roundsSorted(app.sd.rounds);
  const counts = roundCounts(app.sd.notes, app.sd.items, p.id);
  const cur = app.s.currentRoundId;
  const prev = (() => { const i = sorted.findIndex(r => r.id === cur); return i > 0 ? sorted[i - 1].id : null; })();
  keyedList(box, [...sorted].reverse(), {
    key: r => r.id,
    create: r => el('section', { class: 'round' },
      el('h3', { class: 'round-head' },
        el('button', { type: 'button', class: 'round-toggle', 'aria-controls': `rb-${r.id}` }, el('span', { class: 'chev', 'aria-hidden': 'true' }), el('span', { class: 'rt' })),
        el('span', { class: 'round-counts hint' })),
      el('div', { class: 'round-body', id: `rb-${r.id}` },
        el('ol', { class: 'notes' }),
        el('p', { class: 'empty empty-round' }))),
    update: (sec, r) => {
      const [head, body] = sec.children;
      const [toggle, countsN] = head.children;
      const open = roundOpen(app, r, sorted);
      setAttr(toggle, 'aria-expanded', String(open));
      setText(toggle.firstChild, open ? '▾' : '▸');
      const tag = r.id === cur ? t('round.current') : r.id === prev ? t('round.previous') : '';
      setText(toggle.lastChild, [t('round.indicator', { n: r.number }), tag, r.topic].filter(Boolean).join(' · '));
      const c = counts.get(r.id) || { notes: 0, open: 0 };
      setText(countsN, t('round.counts', { n: c.notes, open: c.open }));
      sec.classList.toggle('current', r.id === cur);
      body.hidden = !open;
      const [ol, empty] = body.children;
      const notes = notesOf(app.sd.notes, p.id, r.id);
      const items = timeline(notes, stationEvents(app, r.id, p.id));
      if (open) {
        keyedList(ol, items, {
          key: x => (x.kind === 'note' ? x.n.id : `ev:${x.e.id}`),
          create: x => (x.kind === 'note' ? noteRow() : eventRow()),
          update: (li, x) => (x.kind === 'note' ? updateNoteRow(app, li, x.n, p, r) : updateEventRow(app, li, x.e)),
        });
      }
      empty.hidden = !open || items.length > 0;
      setText(empty, t('round.noNotes'));
      // the composer at the end of the current round
      let comp = body.querySelector('.composer');
      if (r.id === cur) {
        if (!comp) {
          comp = el('div', { class: 'composer' },
            el('label', { class: 'sr-only', for: `composer-${r.id}` }),
            el('textarea', { class: 'composer-text', id: `composer-${r.id}`, rows: 2, spellcheck: 'true' }),
            el('div', { class: 'composer-foot' },
              el('button', { type: 'button', class: 'mini', 'data-act': 'save-new', 'data-keys': '↵', 'aria-keyshortcuts': 'Enter' }),
              el('button', { type: 'button', class: 'mini flag', 'data-act': 'flag-new', 'data-keys': `${MOD} ⇧ ↵`, 'aria-keyshortcuts': 'Control+Shift+Enter Meta+Shift+Enter' }),
              el('span', { class: 'next-slot' }),
              el('span', { class: 'hint' })));
          body.append(comp);
        }
        const [lab, ta, foot] = comp.children;
        const key = composerKey(p.id);
        const d = app.drafts.get(key);
        setText(lab, t('note.newFor', { call: callText(p) }));
        ta.dataset.draft = key;
        if (ta.dataset.pid !== p.id) {
          // another station: its own unfinished text and selection
          ta.dataset.pid = p.id;
          ta.value = d ? d.text : '';
          if (d && document.activeElement === ta && d.selStart != null) try { ta.setSelectionRange(d.selStart, d.selEnd); } catch { /* */ }
        } else {
          setValue(ta, d ? d.text : (document.activeElement === ta ? ta.value : ''));
        }
        autosize(ta);
        ta.placeholder = t('note.placeholder', { call: callText(p) });
        ta.readOnly = app.readOnly;
        // a station that is skipped cannot get notes until it is active again (a)
        const skipped = !['active', 'unconfirmed'].includes(p.status);
        ta.disabled = skipped;
        if (skipped) ta.placeholder = t('note.inactive', { call: callText(p) });
        const nb = nextBtn;
        const slot = foot.querySelector('.next-slot');
        if (nb.parentNode !== slot) slot.prepend(nb);
        const saveB = foot.querySelector('button[data-act="save-new"]');
        const fb = foot.querySelector('button.flag');
        const hint = foot.querySelector('.hint');
        setText(saveB, t('note.saveBtn'));
        setText(fb, t('note.saveQuestionBtn'));
        setAttr(nb, 'aria-keyshortcuts', 'Control+Enter Meta+Enter');
        nb.dataset.keys = `${MOD} ↵`;
        saveB.disabled = fb.disabled = app.readOnly || skipped;
        // the line break and Esc: the two keys that have no button
        fill(hint, keyCaps(['⇧', '↵']), ` ${t('note.keyNewLine')} · `, keyCaps(['Esc']), ` ${t('note.keyLeave')}`);
        comp.hidden = false;
        body.hidden = false;
        if (!open) { setAttr(toggle, 'aria-expanded', 'false'); ol.hidden = true; empty.hidden = true; } else ol.hidden = false;
      } else if (comp) {
        comp.remove();
      }
    },
  });
  park();
}

// ---------- station events in the log ----------

// The events of a station in a round (check-in, status changes, net
// control), for showing them among its notes.
export function stationEvents(app, roundId, participantId = null) {
  return app.sd.events.filter(e => live(e) && e.roundId === roundId && ['presence', 'status', 'ncs'].includes(e.type)
    && (!participantId || e.participantId === participantId || (e.type === 'ncs' && (e.to === participantId || e.from === participantId))));
}

// Notes and events in recorded order (created time; notes by their seq
// among themselves, which follows it).
export function timeline(notes, events) {
  return [...notes.map(n => ({ kind: 'note', n, at: n.created })), ...events.map(e => ({ kind: 'event', e, at: e.created }))]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || ((a.n && a.n.seq) || 0) - ((b.n && b.n.seq) || 0));
}

// "19:42 UTC · checked out" (whose, in the log)
function eventText(app, e, withStation) {
  const p = id => app.sd.participants.find(x => x.id === id);
  const who = id => (p(id) ? callText(p(id)) : '—');
  let what;
  if (e.type === 'presence') what = t('event.checkin');
  else if (e.type === 'status') what = t('event.status', { status: t(`status.${e.to}`) });
  else what = t('event.ncs', { from: who(e.from), to: who(e.to) });
  const prefix = withStation && e.type !== 'ncs' ? `${who(e.participantId)}: ` : '';
  return `${prefix}${what}`;
}

export function eventRow() {
  return el('li', { class: 'event-line' }, el('span', { class: 'time mono' }), ' ', el('span', { class: 'event-text' }));
}

export function updateEventRow(app, li, e, withStation = false) {
  setText(li.firstChild, fmtTime(e.time));
  setText(li.lastChild, eventText(app, e, withStation));
}

// Focus where a station is edited: the note (its text) or the composer.
export function focusNoteEditor(app, noteId = null, { field = 'text', select = false } = {}) {
  if (noteId) {
    const li = $('#station-rounds').querySelector(`li.note[data-key="${CSS.escape(noteId)}"]`);
    if (!li) return false;
    const ta = field === 'reply' ? li.querySelector('textarea.reply-text') : li.querySelector('textarea.note-text');
    li.classList.add('highlight');
    setTimeout(() => li.classList.remove('highlight'), 2500);
    if (ta && !select) { ta.focus(); return true; }
    li.focus();
    li.scrollIntoView({ block: 'nearest' });
    return true;
  }
  const c = $('#station-rounds .composer-text');
  if (!c) return false;
  c.focus();
  const d = app.drafts.get(c.dataset.draft);
  if (d && d.selStart != null) try { c.setSelectionRange(d.selStart, d.selEnd); } catch { /* */ }
  return true;
}

// Is a note's response open (for the keyboard and My Turn)?
export function noteFlagged(app, noteId) {
  const r = responseOf(app.sd.items, noteId);
  return !!r && r.active !== false && r.state !== 'done' && live(r);
}

// ---------- moving notes (correction) ----------

let moveIds = [];

function initMoveDialog(app) {
  const dlg = $('#move-dlg');
  let back = null;
  app.openMoveDialog = ids => {
    if (app.readOnly || !ids.length) return;
    moveIds = ids;
    back = document.activeElement;
    const notes = ids.map(id => app.sd.notes.find(n => n.id === id)).filter(Boolean);
    const first = notes[0];
    setText($('#move-what'), notes.length === 1 ? t('move.one', { text: first.text }) : t('move.many', { n: notes.length }));
    const allSame = k => notes.every(n => n[k] === first[k]);
    fill($('#move-station'), rosterSorted(app.sd.participants).map(p => el('option', { value: p.id }, `${callText(p)}${p.name ? ` · ${p.name}` : ''}`)));
    $('#move-station').value = allSame('participantId') ? first.participantId : '';
    if (!allSame('participantId')) $('#move-station').prepend(el('option', { value: '', selected: true }, t('move.keepStation')));
    fill($('#move-round'), roundsSorted(app.sd.rounds).map(r => el('option', { value: r.id }, [t('round.indicator', { n: r.number }), r.topic].filter(Boolean).join(' · '))));
    $('#move-round').value = allSame('roundId') ? first.roundId : '';
    if (!allSame('roundId')) $('#move-round').prepend(el('option', { value: '', selected: true }, t('move.keepRound')));
    dlg.returnValue = '';
    dlg.showModal();
    $('#move-station').focus();
  };
  dlg.addEventListener('close', async () => {
    const ids = moveIds;
    moveIds = [];
    if (dlg.returnValue === 'ok') {
      const target = { participantId: $('#move-station').value || null, roundId: $('#move-round').value || null };
      const moved = await app.act(store => moveNotes(store, app.ctx(), ids, target));
      if (moved) {
        app.announce(t('move.done', { n: moved.length }));
        app.onMoved && app.onMoved(ids);
      }
    }
    if (back && back.isConnected) back.focus();
  });
}

export function openMoveDialog(app, ids) {
  app.openMoveDialog(ids);
}
