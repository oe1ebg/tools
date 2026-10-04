// Tiny DOM helpers shared by the UI modules.

export const $ = sel => document.querySelector(sel);

// el('td', { class: 'x', onclick: fn }, 'text', childNode)
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

// Replace a node's children. Unlike node.replaceChildren(), arrays are
// flattened and null/undefined/false are skipped (replaceChildren would
// render them as "[object HTMLLIElement]" / "null").
export function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false));
  return node;
}

// Clipboard with a fallback for non-secure contexts (file://).
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// Completion dropdown directly under an input: shown while the input (or
// the dropdown) has focus and there is something in it. ↓ moves into the
// list, ↑/↓ within it, Enter picks, Esc closes. The items are not Tab stops
// (Tab goes on to the next field). Pointer-down on the list doesn't steal
// focus from the input, so a click always registers (also in Safari).
// enterPicksFirst: Enter in the input takes the first item; set it to false
// where the items are only guesses that must not replace valid input.
export function popover(input, pop, { enterPicksFirst = true } = {}) {
  pop.hidden = true;
  const focusInside = () => document.activeElement === input || pop.contains(document.activeElement);
  const api = {
    // Call after changing the dropdown's content.
    update() {
      pop.querySelectorAll('button').forEach(b => { b.tabIndex = -1; });
      pop.hidden = !pop.childElementCount || !focusInside();
    },
    hide() {
      pop.hidden = true;
    },
  };
  pop.addEventListener('pointerdown', ev => ev.preventDefault());
  input.addEventListener('focus', api.update);
  const later = () => setTimeout(() => { if (!focusInside()) api.hide(); }, 150);
  input.addEventListener('blur', later);
  pop.addEventListener('focusout', later);
  input.addEventListener('keydown', ev => {
    if (pop.hidden) return;
    if (ev.key === 'ArrowDown') {
      const b = pop.querySelector('button');
      if (b) { ev.preventDefault(); b.focus(); }
    } else if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && enterPicksFirst) {
      const b = pop.querySelector('button');
      if (b) { ev.preventDefault(); ev.stopPropagation(); b.click(); }
    } else if (ev.key === 'Escape') {
      ev.stopPropagation();
      api.hide();
    }
  });
  pop.addEventListener('keydown', ev => {
    const items = [...pop.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      items[Math.min(i + 1, items.length - 1)]?.focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (i <= 0) input.focus(); else items[i - 1].focus();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      api.hide();
      input.focus();
    }
  });
  return api;
}

// Move focus to the next control of a form, the way Tab would (used for
// Enter = next field). Skips hidden/disabled controls, dropdown items and
// tabindex=-1; a radio group counts once (its checked radio, else its first
// visible one).
export function focusNext(container, from) {
  const visible = n => !n.disabled && n.tabIndex >= 0 && !n.closest('[hidden], .ac-pop') && n.getClientRects().length > 0;
  const controls = [];
  const groups = new Set();
  for (const n of container.querySelectorAll('input, select, textarea, button')) {
    if (!visible(n)) continue;
    if (n.type === 'radio') {
      if (groups.has(n.name)) continue;
      const radios = [...container.querySelectorAll(`input[type=radio][name="${n.name}"]`)].filter(visible);
      groups.add(n.name);
      controls.push(radios.find(r => r.checked) || radios[0]);
    } else {
      controls.push(n);
    }
  }
  const i = controls.findIndex(n => n === from || (from.type === 'radio' && n.type === 'radio' && n.name === from.name));
  const next = controls[i + 1];
  if (next) next.focus();
  return next || null;
}
