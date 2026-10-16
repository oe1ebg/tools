// Net Control: the roster with its planned speaking order. Planning and
// display order never change the actual speaking history, and nothing
// here starts a round.

import { $, el, fill } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { keyedList, setText, setAttr } from './keyed.js';
import { rosterSorted } from './model.js';
import { moveParticipant } from './ops.js';
import { callText, statusLabel } from './roster.js';

// Planned order first (stations without one after them, in roster order).
export function plannedOrder(participants) {
  return rosterSorted(participants).map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.plannedOrder ?? Infinity) - (b.p.plannedOrder ?? Infinity) || a.i - b.i)
    .map(x => x.p);
}

export function initControl(app) {
  $('#order-list').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('li').dataset.key;
    if (b.dataset.act === 'open') { app.openStation(id); return; }
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
      el('button', { type: 'button', class: 'mini', 'data-act': 'up' }, '↑'),
      el('button', { type: 'button', class: 'mini', 'data-act': 'down' }, '↓')),
    update: (li, p) => {
      const [open, status, , up, down] = li.children;
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
}
