// The help dialog: what Netlog does, the keyboard commands (navigation
// keys fixed, editing commands configurable here, with a check against
// browser/OS conflicts) and how data is kept. Opened with ? or the header
// button; Esc or "Close" returns focus where it was.

import { $, el, fill } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { NAV_KEYS, EDIT_COMMANDS, bindingOf, setEditBinding } from './keys.js';

const keyName = k => ({ ArrowDown: '↓', ArrowUp: '↑', Escape: 'Esc', Enter: 'Enter' }[k] || k);
const kbd = text => el('kbd', {}, text);

// "Ctrl+Shift+Enter" as shown (⌘ for Meta)
export function bindingText(b) {
  return String(b).split('+').map(p => (p === 'Meta' ? '⌘' : p)).join('+');
}

function helpContent(app) {
  const nav = el('table', { class: 'keys' },
    el('caption', {}, t('help.navCaption')),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, t('help.key')), el('th', { scope: 'col' }, t('help.action')))),
    el('tbody', {}, NAV_KEYS.map(([k, alt, , label]) => el('tr', {},
      el('td', {}, kbd(keyName(k)), alt ? [' / ', kbd(keyName(alt))] : null),
      el('td', {}, t(label))))));
  const editRows = Object.entries(EDIT_COMMANDS).map(([name, c]) => {
    const msg = el('span', { class: 'hint', role: 'status' });
    const b = el('button', { type: 'button', class: 'mini', 'aria-label': t('help.changeLabel', { action: t(c.labelKey) }) }, t('help.change'));
    const shown = el('span', {}, kbd(bindingText(c.binding)));
    b.addEventListener('click', () => {
      msg.textContent = t('help.pressKeys');
      const capture = ev => {
        if (['Control', 'Shift', 'Meta', 'Alt'].includes(ev.key)) return;
        ev.preventDefault();
        ev.stopPropagation();
        b.removeEventListener('keydown', capture);
        if (ev.key === 'Escape') { msg.textContent = ''; return; }
        const binding = bindingOf(ev);
        const problem = setEditBinding(name, binding);
        msg.textContent = problem ? t(problem, { keys: bindingText(binding) }) : t('help.changed', { keys: bindingText(binding) });
        if (!problem) fill(shown, kbd(bindingText(binding)));
      };
      b.addEventListener('keydown', capture);
    });
    return el('tr', {}, el('td', {}, shown), el('td', {}, t(c.labelKey), ' ', b, ' ', msg));
  });
  return [
    el('p', {}, t('help.intro')),
    nav,
    el('table', { class: 'keys' },
      el('caption', {}, t('help.editCaption')),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, t('help.key')), el('th', { scope: 'col' }, t('help.action')))),
      el('tbody', {},
        el('tr', {}, el('td', {}, kbd('Esc')), el('td', {}, t('keys.leaveEditing'))),
        app.helpEditRows(),
        editRows)),
    el('p', { class: 'hint' }, t('help.editNote')),
    el('h3', {}, t('style.label')),
    el('ul', {}, ['star', 'circle', 'free'].map(s => el('li', {}, t(`style.${s}`)))),
    el('p', {}, t('help.speaking')),
    el('h3', {}, t('help.historyTitle')),
    el('p', {}, t('help.history')),
    el('h3', {}, t('help.dataTitle')),
    el('p', {}, t('help.data')),
    el('p', {}, t('help.tabs')),
    el('p', {}, t('help.times')),
    el('p', { class: 'hint' }, t('help.synthetic')),
  ];
}

export function initHelp(app) {
  const dlg = $('#help-dlg');
  let back = null;
  const open = () => {
    if (dlg.open) return;
    back = document.activeElement;
    fill($('#help-body'), helpContent(app));
    dlg.showModal();
    $('#help-title').focus?.();
  };
  dlg.addEventListener('close', () => { if (back && back.isConnected) back.focus(); });
  $('#btn-help').addEventListener('click', open);
  return { open };
}
