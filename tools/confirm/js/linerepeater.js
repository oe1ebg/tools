// Per-line repeater in the entry form. The log header's repeater is the
// default; for exercises over a linked repeater network, a different one
// can be chosen for each line (search the ÖVSV list, or type any call).
// After saving, the field returns to the header default.

import { el, fill, popover } from '../../shared/js/dom.js';
import { loadRepeaterIndex, describeRepeater } from './repeaterui.js';
import { searchRepeaters, positionFromLocator, formatMHz } from '../../shared/js/repeaters.js';
import { normalizeCall } from './model.js';

// Header-snapshot fields for a repeater from the list.
export function overrideFromRepeater(r) {
  return {
    repeaterCall: r.call,
    repeaterFreq: formatMHz(r.out),
    repeaterShift: r.shift === null || r.shift === undefined ? '' : String(r.shift),
    repeaterTone: r.ctcss ? String(r.ctcss) : '',
  };
}

export function createLineRepeater({ checkbox, input, sug, getHeader, onChange }) {
  let override = null; // null = use the header's repeater
  let timer = null;

  function headerCall() {
    return getHeader().repeaterCall || '';
  }

  function refreshDefault() {
    const call = headerCall();
    input.placeholder = call ? `${call} (Header)` : 'Relais';
    input.classList.toggle('override', !!override);
  }

  function apply(ov) {
    // Choosing the header's own repeater is not an override.
    override = ov && ov.repeaterCall !== headerCall() ? ov : null;
    input.value = override ? override.repeaterCall : '';
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
      override = exact.r.call !== headerCall() ? overrideFromRepeater(exact.r) : null;
      refreshDefault();
      onChange();
    }
    if (hits.length) {
      fill(sug, el('div', { class: 'ac-head' }, 'Relais für diese Zeile (↓, Enter):'),
        hits.map(({ r, distKm }) => el('button', { type: 'button', class: 'ac-item', onclick: () => { apply(overrideFromRepeater(r)); input.focus(); } },
          el('b', {}, r.call), el('small', {}, describeRepeater(r, distKm).split(' · ').slice(1).join(' · ')))));
    }
    pop.update();
  }

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
      if (q && q !== headerCall()) return { repeaterCall: q, repeaterFreq: '', repeaterShift: '', repeaterTone: '' };
      return null;
    },
    set(ov) {
      clearTimeout(timer);
      override = ov || null;
      input.value = override ? override.repeaterCall : '';
      sug.replaceChildren();
      refreshDefault();
    },
    reset() {
      this.set(null);
    },
  };
}
