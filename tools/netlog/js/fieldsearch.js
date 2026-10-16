// Completion for single fields outside the roster: the repeater fields
// (series and session) search the offline Austrian repeater list, the
// callsign fields (my callsign, the usual net control) the local
// identities and the callsign list. A suggestion only fills the field when
// picked (↓ and Enter, or a click); Enter never swaps typed text for one.

import { el, fill, popover } from '../../shared/js/dom.js';
import { loadRepeaterIndex, describeRepeater } from '../../shared/js/repeaterui.js';
import { searchRepeaters, formatMHz } from '../../shared/js/repeaters.js';
import { t } from './i18n.js';
import { candidateButtons } from './roster.js';

// "OE1XUU 145.600" for a picked repeater.
export function repeaterText(r) {
  return [r.call, formatMHz(r.out)].filter(Boolean).join(' ');
}

function wrap(input) {
  // the dropdown goes right after the field, inside a positioned box
  const box = el('span', { class: 'ac-wrap field-ac' });
  input.replaceWith(box);
  box.append(input);
  const pop = el('div', { class: 'ac-pop', hidden: true });
  box.append(pop);
  return pop;
}

export function attachRepeaterField(app, input, onPick = null) {
  const pop = wrap(input);
  const dd = popover(input, pop, { enterPicksFirst: false, label: t('field.repeaters') });
  app.onLang(() => pop.setAttribute('aria-label', t('field.repeaters')));
  let timer = null;
  let seq = 0;
  const suggest = async () => {
    const mine = ++seq;
    const q = input.value.trim();
    const idx = q.length >= 2 ? await loadRepeaterIndex() : null;
    if (mine !== seq) return;
    const hits = idx ? searchRepeaters(idx, q, { limit: 8 }) : [];
    fill(pop, hits.length ? el('div', { class: 'ac-head' }, t('field.repeaterSource')) : null, hits.map(({ r, distKm }) => el('button', {
      type: 'button',
      class: 'ac-item',
      onclick: () => {
        input.value = repeaterText(r);
        dd.hide();
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.focus();
        if (onPick) onPick(r);
      },
    }, el('b', {}, r.call), el('small', {}, describeRepeater(r, distKm).replace(`${r.call} · `, '')))));
    dd.update();
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(suggest, 120); });
}

export function attachCallField(app, input) {
  const pop = wrap(input);
  const dd = popover(input, pop, { enterPicksFirst: false, label: t('checkin.suggestions') });
  app.onLang(() => pop.setAttribute('aria-label', t('checkin.suggestions')));
  input.addEventListener('input', () => {
    fill(pop, candidateButtons(app, input, c => {
      input.value = c.call;
      dd.hide();
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
    }));
    dd.update();
  });
}
