// The help of a tool (#108 C1): a <dialog id="help-dlg">, opened by the
// header button "? Hilfe" (#btn-help, the last control of the header in
// every tool) or the ? key outside text fields. `keys` adds keys that open
// it from anywhere, also from a text field (Notfunk: F1); `enabled()` can
// limit the keys to a view. Esc or #help-close closes it and puts the focus
// back where it was; the input is untouched. Section links (.help-nav a)
// scroll inside the dialog without changing the page's address.

import { $, isComposing } from './dom.js';

export function initHelpDialog({ keys = [], enabled = () => true } = {}) {
  const dlg = $('#help-dlg');
  const btn = $('#btn-help');
  if (!dlg || !btn) return;
  let back = null;
  const open = () => {
    if (dlg.open) return;
    back = document.activeElement;
    dlg.showModal();
    $('#help-close')?.focus();
  };
  dlg.addEventListener('close', () => { if (back?.isConnected) back.focus(); back = null; });
  $('#help-close')?.addEventListener('click', () => dlg.close());
  btn.addEventListener('click', open);
  for (const a of dlg.querySelectorAll('.help-nav a')) {
    a.addEventListener('click', ev => {
      ev.preventDefault();
      dlg.querySelector(a.getAttribute('href'))?.scrollIntoView({ block: 'start' });
    });
  }
  document.addEventListener('keydown', ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || isComposing(ev) || dlg.open || !enabled()) return;
    const typing = ev.target.closest?.('input, textarea, select, [contenteditable]');
    if (keys.includes(ev.key) || (ev.key === '?' && !typing)) {
      ev.preventDefault();
      open();
    }
  });
}
