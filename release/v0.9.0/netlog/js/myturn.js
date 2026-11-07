// My Turn: one scrolling workspace for the operator's turn. First the open
// on-air responses and personal talking points of this session (from any
// round, in the user's order), then the notes of the current round (or,
// with p, the previous one), read-only and grouped by station. A My Turn
// review cycle (a "turn") opens with the workspace and stays across
// navigation and reloads until End Turn: items completed in it stay
// visible, subdued; End Turn hides them (their history stays) and keeps
// the open ones. Nothing here advances the round.
//
// Row focus model: each checklist item and each summary note is a row
// (li, tabindex -1, j/k); x completes/reopens the focused item, Enter opens
// its source. The checkbox, the reorder buttons and the reply field act on
// their own and never navigate.

import { $, el, fill, isComposing } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { keyedList, setText, setAttr, setValue, setNamed } from './keyed.js';
import { provenanceButton, renderProvenance, openProvenance } from './historyui.js';
import { speakingState, netStyle, queueItems, openTurn, previousRound, turnSummary, responseOf, liveOf, cmp } from './model.js';
import { setItemDone, moveItem, addPoint, startTurn, endTurn, setItemText, deleteItem } from './ops.js';
import { callText, isOwn } from './roster.js';
import { nextSpeaker } from './speak.js';
import { autosize, replyKey, MOD } from './notes.js';
import { hmz } from './clock.js';

const POINT_DRAFT = 'point:new';

export function initTurn(app) {
  const items = $('#turn-items');
  items.addEventListener('change', ev => {
    const cb = ev.target.closest('input.turn-done');
    if (cb) completeItem(app, cb.closest('li').dataset.key, cb.checked);
  });
  items.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('li').dataset.key;
    if (b.dataset.act === 'open') app.openSource(id);
    if (b.dataset.act === 'up' || b.dataset.act === 'down') reorder(app, id, b.dataset.act === 'up' ? 1 : -1, b.dataset.act);
    if (b.dataset.act === 'delete-point') app.act(store => deleteItem(store, app.ctx(), id));
    if (b.dataset.act === 'from') openProvenance(app, app.sd.items.find(i => i.id === id));
  });
  items.addEventListener('input', ev => {
    const ta = ev.target.closest('textarea');
    if (!ta) return;
    autosize(ta);
    app.drafts.typed(ta.dataset.draft, ta);
  });
  const saveText = async ta => {
    const id = ta.closest('li').dataset.key;
    const item = app.sd.items.find(i => i.id === id);
    const text = ta.value.replace(/\s+$/, '');
    if (!item) return;
    if (item.kind === 'point' && !text.trim()) { ta.value = item.text; return; }
    if (text !== (item.text || '')) await app.drafts.commit(ta.dataset.draft, k => app.act(store => setItemText(store, app.ctx(), id, text, k)));
    else await app.drafts.discard(ta.dataset.draft);
  };
  items.addEventListener('focusout', ev => { const ta = ev.target.closest('textarea'); if (ta) saveText(ta); });
  items.addEventListener('keydown', ev => {
    const ta = ev.target.closest('textarea');
    if (!ta || ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey || isComposing(ev)) return;
    ev.preventDefault();
    saveText(ta).then(() => ta.closest('li').focus());
  });

  const form = $('#point-form');
  const pt = $('#point-text');
  pt.dataset.draft = POINT_DRAFT;
  pt.addEventListener('input', () => { autosize(pt); app.drafts.typed(POINT_DRAFT, pt); });
  const submit = async () => {
    const text = pt.value.replace(/\s+$/, '');
    if (!text.trim()) return;
    pt.value = '';
    autosize(pt);
    const r = await app.drafts.commit(POINT_DRAFT, k => app.act(store => addPoint(store, app.ctx(), text, k)));
    if (!r) { if (!pt.value) pt.value = text; return; }
    app.announce(t('turn.pointAdded'));
  };
  pt.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !isComposing(ev)) { ev.preventDefault(); submit(); }
  });
  form.addEventListener('submit', ev => { ev.preventDefault(); submit(); });

  $('#sum-groups').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'station') app.openFrom(b.dataset.pid, { roundId: b.dataset.round });
    if (b.dataset.act === 'note') app.openFrom(b.dataset.pid, { noteId: b.closest('li').dataset.key });
  });
  $('#turn-history').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act=reopen]');
    if (b) completeItem(app, b.closest('li').dataset.key, false);
  });
  // Ctrl/⌘+Enter anywhere in My Turn (as in the note field): end the turn and hand over
  $('#btn-handover').dataset.keys = `${MOD} ↵`;
  $('#view-turn').addEventListener('keydown', async ev => {
    if (ev.key !== 'Enter' || ev.shiftKey || !(ev.ctrlKey || ev.metaKey) || ev.altKey || isComposing(ev) || app.readOnly) return;
    ev.preventDefault();
    await handOver(app);
  });
  $('#btn-handover').addEventListener('click', () => nextSpeaker(app));
  $('#btn-end-turn').addEventListener('click', async () => {
    const r = await app.act(store => endTurn(store, app.ctx()));
    if (r) { app.announce(t('turn.ended')); $('#resp-title').focus(); }
  });
  $('#btn-turn-back').addEventListener('click', () => app.back('live'));
}

// End the turn and hand over (My Turn: Ctrl/⌘+Enter, from a field or not).
export async function handOver(app) {
  if (!$('#btn-end-turn').disabled) await app.act(store => endTurn(store, app.ctx()));
  if (!$('#btn-handover').disabled) await nextSpeaker(app);
}

async function reorder(app, id, dir, act) {
  const moved = await app.act(store => moveItem(store, app.ctx(), id, dir));
  if (!moved) return;
  app.announce(t(dir > 0 ? 'turn.movedUp' : 'turn.movedDown'));
  const b = $('#turn-items').querySelector(`li[data-key="${CSS.escape(id)}"] button[data-act="${act}"]`);
  if (b && !b.disabled) b.focus();
  else $('#turn-items').querySelector(`li[data-key="${CSS.escape(id)}"]`)?.focus();
}

// dir: +1 moves the item up the list shown (newest on top), -1 down.
// done: true/false, or null to toggle on the stored state (x).
export async function completeItem(app, id, done) {
  const r = await app.act(store => setItemDone(store, app.ctx(), id, done));
  if (r) app.announce(t(r.state === 'done' ? 'turn.completed' : 'turn.reopened'));
  return r;
}


// Open the workspace: start (or resume) the review cycle.
export async function enterTurn(app) {
  if (app.readOnly || openTurn(app.sd.turns || [])) return;
  await app.act(store => startTurn(store, app.ctx()), { quiet: true });
}


// Who to hand over to when I am done: the next station in the net order,
// or the net control in a star net.
function renderHandover(app) {
  const st = speakingState({ session: app.s, participants: app.sd.participants, contributions: app.sd.contributions });
  const box = $('#turn-handover');
  const btn = $('#btn-handover');
  btn.hidden = false;
  let text = '';
  let label = t('turn.handoverBtn');
  const newRound = !st.free && !st.needsNcs && (st.complete || !st.next);
  if (!st.free && !st.needsNcs) {
    if (newRound) {
      // the round is through: start the next one, and say who opens it
      const opener = netStyle(app.s) === 'circle' ? st.next || st.order[0] : st.order[0];
      const n = Math.max(0, ...app.sd.rounds.map(r => r.number || 0)) + 1;
      // only the net control's own page starts the next round
      if (netStyle(app.s) === 'circle' && opener) {
        // round-robin: the last station hands over, and that starts the new round
        text = t('turn.handoverNewRound', { call: callText(opener), n });
        label = t('turn.handoverBtn');
      } else {
        const other = st.ncs && !isOwn(app, st.ncs);
        text = t(other ? 'turn.handoverDoneNcs' : 'turn.handoverDone', { call: st.ncs ? callText(st.ncs) : '' });
        btn.hidden = other;
        label = t(opener ? 'speak.newRoundNext' : 'speak.newRound', { n, call: opener ? callText(opener) : '' });
      }
    } else {
      const ncsNext = st.ncs && st.next.id === st.ncs.id && netStyle(app.s) === 'star';
      text = t(ncsNext ? 'turn.handoverNcs' : 'turn.handover', { call: callText(st.next) });
    }
  }
  setText(box, text);
  box.parentNode.hidden = !text;
  setText(btn, label);
  btn.classList.toggle('suggest-round', newRound && !!text);
  btn.disabled = app.readOnly || !text || (newRound && !st.order.length);
}

export function renderTurn(app) {
  const s = app.s;
  const cur = app.sd.rounds.find(r => r.id === s.currentRoundId);
  setText($('#turn-title'), t('turn.title', { own: s.own.call || t('turn.ownUnknown'), n: cur ? cur.number : '?' }));
  renderHandover(app);
  const turn = openTurn(app.sd.turns || []);
  // the open items, the newest first; what was ticked off during this turn goes to the collapsed list
  const queue = queueItems(app.sd.items, app.sd.notes, turn ? turn.id : null).filter(i => i.state !== 'done').reverse();
  const notes = new Map(app.sd.notes.map(n => [n.id, n]));
  const rounds = new Map(app.sd.rounds.map(r => [r.id, r]));
  keyedList($('#turn-items'), queue, {
    key: i => i.id,
    create: i => el('li', { class: 'turn-item', tabindex: '-1' },
      el('input', { type: 'checkbox', class: 'turn-done' }),
      el('div', { class: 'ti-body' },
        el('div', { class: 'ti-head' }, i.kind === 'point' ? el('span', { class: 'ti-point' }) : el('button', { type: 'button', class: 'link station', 'data-act': 'open' }), ' ', provenanceButton(i) || el('span', { class: 'hint ti-src' })),
        el('p', { class: 'ti-obs' }),
        el('label', { class: 'field ti-reply-field' }, el('span', {}), el('textarea', { class: 'ti-reply', rows: 1 }))),
      el('div', { class: 'ti-tools' },
        el('button', { type: 'button', class: 'mini', 'data-act': 'up' }, '↑'),
        el('button', { type: 'button', class: 'mini', 'data-act': 'down' }, '↓'),
        i.kind === 'point' ? el('button', { type: 'button', class: 'mini danger', 'data-act': 'delete-point' }, '×') : null)),
    update: (li, i) => {
      const k = queue.indexOf(i);
      const done = i.state === 'done';
      li.classList.toggle('done', done);
      const [cb, body, tools] = li.children;
      const [head, obs, replyField] = body.children;
      const note = i.noteId ? notes.get(i.noteId) : null;
      const p = note ? app.sd.participants.find(x => x.id === note.participantId) : null;
      const who = i.kind === 'point' ? t('turn.point') : `${p ? callText(p) : '?'}${p && p.name ? ` · ${p.name}` : ''}`;
      setText(head.firstChild, who);
      if (i.kind !== 'point') setNamed(head.firstChild, t('turn.openSource', { call: p ? callText(p) : '?' }));
      const r = note ? rounds.get(note.roundId) : null;
      if (i.from) renderProvenance(head.lastChild, i);
      else setText(head.lastChild, note ? t('turn.source', { n: r ? r.number : '?', time: note.time && note.time.iso ? hmz(note.time.iso) : '—' }) : '');
      setText(obs, note ? t('turn.observation', { text: note.text }) : '');
      obs.hidden = !note;
      const ta = replyField.lastChild;
      const key = replyKey(i.id);
      const d = app.drafts.get(key);
      ta.dataset.draft = key;
      setValue(ta, d ? d.text : i.text || '');
      if (document.activeElement !== ta) autosize(ta);
      ta.readOnly = app.readOnly;
      setText(replyField.firstChild, t(i.kind === 'point' ? 'turn.pointLabel' : 'turn.replyLabel'));
      cb.checked = done;
      cb.disabled = app.readOnly;
      const what = note ? `${who}: ${note.text}` : `${who}: ${i.text}`;
      setAttr(cb, 'aria-label', t('turn.doneLabel', { what }));
      setAttr(li, 'aria-label', `${what}${done ? `, ${t('turn.doneState')}` : ''}`);
      const [up, down] = tools.children;
      up.disabled = k === 0 || app.readOnly;
      down.disabled = k === queue.length - 1 || app.readOnly;
      setAttr(up, 'aria-label', t('turn.upLabel', { what: who }));
      setAttr(down, 'aria-label', t('turn.downLabel', { what: who }));
      if (tools.children[2]) { setAttr(tools.children[2], 'aria-label', t('turn.deletePoint')); tools.children[2].disabled = app.readOnly; }
    },
  });
  const openN = queue.filter(i => i.state !== 'done').length;
  $('#turn-empty').hidden = queue.length > 0;
  setText($('#turn-empty'), t('turn.empty'));
  setText($('#resp-count'), t('turn.openCount', { n: openN }));
  $('#point-text').readOnly = app.readOnly;
  setValue($('#point-text'), (app.drafts.get(POINT_DRAFT) || { text: document.activeElement === $('#point-text') ? $('#point-text').value : '' }).text);

  // answered: ticked off in this turn or earlier, in a compact list, reopenable
  const hist = liveOf(app.sd.items).filter(i => ['response', 'point'].includes(i.kind) && i.state === 'done' && i.active !== false)
    .sort((a, b) => cmp(b.updated, a.updated));
  $('#turn-history').hidden = hist.length === 0;
  setText($('#turn-history-summary'), t('turn.history', { n: hist.length }));
  keyedList($('#turn-history-list'), hist, {
    key: i => i.id,
    create: () => el('li', { class: 'th-row' }, el('strong', { class: 'th-who' }), el('span', { class: 'th-text' }), el('button', { type: 'button', class: 'mini', 'data-act': 'reopen' })),
    update: (li, i) => {
      const note = i.noteId ? notes.get(i.noteId) : null;
      const p = note ? app.sd.participants.find(x => x.id === note.participantId) : null;
      const [who, text, reopen] = li.children;
      setText(who, i.kind === 'point' ? t('turn.point') : p ? callText(p) : '?');
      setText(text, i.kind === 'point' ? i.text : note ? note.text : '');
      setAttr(text, 'title', text.textContent);
      setText(reopen, t('turn.reopen'));
      reopen.disabled = app.readOnly;
    },
  });

  // round notes: the current and the previous round together, by station
  const prev = previousRound(app.sd.rounds, cur && cur.id);
  const roundText = (r, which) => `${t(`turn.roundTag.${which}`, { n: r.number })}${r.topic ? ` (${r.topic})` : ''}`;
  setText($('#sum-topic'), cur
    ? [roundText(cur, 'current'), prev ? roundText(prev, 'previous') : t('turn.noPreviousRound')].join(' · ')
    : '');
  const groups = cur ? turnSummary({ notes: app.sd.notes, contributions: app.sd.contributions, participants: app.sd.participants, current: cur, previous: prev }) : [];
  keyedList($('#sum-groups'), groups, {
    key: g => g.participant.id,
    create: () => el('section', { class: 'sum-group' },
      el('h4', {}, el('button', { type: 'button', class: 'link station', 'data-act': 'station' })),
      el('ul', { class: 'sum-notes' })),
    update: (sec, g) => {
      const [h, ul] = sec.children;
      const b = h.firstChild;
      const p = g.participant;
      b.dataset.pid = p.id;
      b.dataset.round = cur.id;
      setText(b, `${callText(p)}${p.name ? ` · ${p.name}` : ''}`);
      setNamed(b, t('turn.stationNotes', { call: callText(p) }));
      if (!ul.id) ul.id = `sum-${p.id}`;
      keyedList(ul, g.entries, {
        key: e => e.note.id,
        create: () => el('li', { class: 'sum-note', tabindex: '-1' },
          el('span', { class: 'sum-round mono' }), el('span', { class: 'sum-text' }), el('span', { class: 'badges' }),
          el('button', { type: 'button', class: 'mini link', 'data-act': 'note' })),
        update: (li, e) => {
          const n = e.note;
          const [tag, text, badges, open] = li.children;
          const which = t(`turn.roundWhich.${e.which}`, { n: e.round.number });
          setText(tag, `R${e.round.number}`);
          setAttr(tag, 'title', which);
          li.classList.toggle('previous', e.which === 'previous');
          setText(text, n.text);
          const resp = responseOf(app.sd.items, n.id);
          const flagged = resp && resp.active !== false;
          const label = flagged ? t(resp.state === 'done' ? 'note.respDone' : 'note.respOpen') : '';
          if (badges.dataset.sig !== label) { badges.dataset.sig = label; fill(badges, label ? el('span', { class: `pill ${resp.state === 'done' ? 'ok' : 'warn'}` }, label) : null); }
          li.classList.toggle('flagged', !!flagged && resp.state !== 'done');
          setAttr(li, 'aria-label', `${callText(p)}, ${which}: ${n.text}${label ? `, ${label}` : ''}`);
          open.dataset.pid = p.id;
          setText(open, '→');
          setAttr(open, 'aria-label', t('turn.toNoteLabel', { call: callText(p) }));
        },
      });
    },
  });
  $('#sum-empty').hidden = groups.length > 0;
  setText($('#sum-empty'), t('turn.noRoundNotes2'));
  $('#btn-end-turn').disabled = app.readOnly || !turn;
  setText($('#turn-cycle'), turn ? t('turn.cycleSince', { time: hmz(turn.started) }) : '');
}

// The rows j/k move through in My Turn.
export function turnRows() {
  return [...document.querySelectorAll('#turn-items > li, #sum-groups li.sum-note')];
}

export function focusedTurnItem() {
  const li = document.activeElement && document.activeElement.closest && document.activeElement.closest('#turn-items > li');
  return li ? li.dataset.key : null;
}

