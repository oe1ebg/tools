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

// The modes of the session's mode field a listed repeater can stand for.
const REPEATER_MODES = { FM: 'FM', DMR: 'DMR', C4FM: 'C4FM', DSTAR: 'DSTAR' };

// A picked repeater fills its fields: the call into the repeater field,
// its output frequency into the frequency field, and the mode: the
// repeater's mode when the list gives exactly one usable mode; with
// several, the current mode stays if the repeater has it, otherwise the
// mode is cleared and a message names the choices (also with none usable,
// e.g. TETRA). Each field saves through its own change event.

function wrap(input) {
  // the dropdown goes right after the field, inside a positioned box
  const box = el('span', { class: 'ac-wrap field-ac' });
  input.replaceWith(box);
  box.append(input);
  const pop = el('div', { class: 'ac-pop', hidden: true });
  box.append(pop);
  return pop;
}

// fields: { freq: <input>, mode: <select>, hint: <element> } next to the
// repeater field; the hint says why the mode was cleared.
export function attachRepeaterField(app, input, fields = {}) {
  // the hint is about the last pick: gone once the mode is chosen
  if (fields.mode && fields.hint) fields.mode.addEventListener('input', () => { fields.hint.textContent = ''; });
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
        const set = (f, v) => {
          if (!f || f.value === v) return;
          f.value = v;
          f.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set(input, r.call);
        if (r.out) set(fields.freq, formatMHz(r.out));
        if (fields.mode) {
          const usable = (r.modes || []).map(m => REPEATER_MODES[m]).filter(Boolean);
          const cur = fields.mode.value;
          const next = usable.includes(cur) ? cur : usable.length === 1 ? usable[0] : '';
          set(fields.mode, next);
          const why = next ? '' : t(usable.length ? 'field.modeChoose' : 'field.modeNone', { call: r.call, modes: (r.modes || []).join(', ') || '—' });
          if (fields.hint) fields.hint.textContent = why;
          else if (why) app.announce(why);
        }
        dd.hide();
        input.focus();
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
