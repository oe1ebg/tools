// Per-line repeater in the entry form. The log header's repeater is the
// default and stands in the field (not just as a placeholder), so the form
// shows what will be saved; for exercises over a linked repeater network, a
// different one can be chosen for each line (search the ÖVSV list, or type
// any call). After saving, the field returns to the header's repeater; an
// emptied field means the header's too and is refilled on leaving it.

import { el, fill, popover } from '../../shared/js/dom.js';
import { loadRepeaterIndex, describeRepeater } from '../../shared/js/repeaterui.js';
import { searchRepeaters, positionFromLocator } from '../../shared/js/repeaters.js';
import { repeaterFields, REPEATER_KEYS } from './model.js';
import { normalizeCall } from '../../shared/js/callbook.js';


export function createLineRepeater({ checkbox, input, sug, getHeader, onChange }) {
  let override = null; // null = use the header's repeater
  let timer = null;

  // the Betrieb's relay, only when the log runs over it ("direkt" with a
  // relay call left over from before is no relay)
  function headerCall() {
    const h = getHeader();
    return h.viaRepeater ? h.repeaterCall || '' : '';
  }

  function refreshDefault() {
    // not while the field is being typed in
    if (!override && document.activeElement !== input) input.value = headerCall();
    input.classList.toggle('override', !!override);
  }

  function apply(ov) {
    // Choosing the header's own repeater is not an override.
    override = ov && ov.repeaterCall !== headerCall() ? ov : null;
    input.value = override ? override.repeaterCall : headerCall();
    if (ov) {
      checkbox.checked = true;
      checkbox.dataset.touched = '1';
    }
    sug.replaceChildren();
    pop.hide();
    refreshDefault();
    onChange();
  }

  async function suggest() {
    const q = input.value.trim();
    sug.replaceChildren();
    if (!q) {
      pop.update();
      override = null;
      refreshDefault();
      onChange();
      return;
    }
    checkbox.checked = true;
    checkbox.dataset.touched = '1';
    const idx = await loadRepeaterIndex();
    if (!idx) return;
    const hits = searchRepeaters(idx, q, { position: positionFromLocator(getHeader().myGrid), limit: 5 });
    // An exact callsign is taken right away (typing "OE3XSA" is enough).
    const exact = hits.find(h => h.r.call === normalizeCall(q));
    if (exact) {
      override = exact.r.call !== headerCall() ? repeaterFields(exact.r) : null;
      refreshDefault();
      onChange();
    }
    if (hits.length) {
      fill(sug, el('div', { class: 'ac-head' }, 'Relais für diese Zeile (↓, Enter):'),
        hits.map(({ r, distKm }) => el('button', { type: 'button', class: 'ac-item', onclick: () => { apply(repeaterFields(r)); input.focus(); } },
          el('b', {}, r.call), el('small', {}, describeRepeater(r, distKm).split(' · ').slice(1).join(' · ')))));
    }
    pop.update();
  }

  input.addEventListener('blur', () => {
    if (!input.value.trim() && !override) input.value = headerCall();
  });
  input.addEventListener('input', () => {
    override = null;
    clearTimeout(timer);
    timer = setTimeout(suggest, 120);
  });
  // Esc with the dropdown closed clears the override (registered before
  // the dropdown's own handler, which closes the dropdown first).
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && input.value && sug.hidden) {
      ev.stopPropagation();
      apply(null);
    }
  });
  const pop = popover(input, sug);

  return {
    refreshDefault,
    // Value for saving: null = header repeater; an unknown typed call is
    // kept as call-only override (frequencies then come from the header).
    get() {
      const q = normalizeCall(input.value);
      if (override) return override;
      if (q && q !== headerCall()) return { ...Object.fromEntries(REPEATER_KEYS.map(k => [k, ''])), repeaterCall: q };
      return null;
    },
    set(ov) {
      clearTimeout(timer);
      override = ov || null;
      input.value = override ? override.repeaterCall : headerCall();
      sug.replaceChildren();
      refreshDefault();
    },
    reset() {
      this.set(null);
    },
  };
}
