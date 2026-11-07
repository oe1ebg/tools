// Keyboard model. Navigation mode (focus outside text fields): single
// keys without modifiers run commands (the table below; the same in both
// languages). Editing mode (focus in a field): typing, IME composition and
// browser/assistive shortcuts are untouched; only Esc (leave editing, the
// input stays) and the editing commands below act. No function keys and
// no Option/Alt character combinations: those type characters on macOS.

import { prefGet, prefSet } from '../../shared/js/prefs.js';

// [key, alternative key or '', command, translation key of the description]
export const NAV_KEYS = [
  ['j', 'ArrowDown', 'next', 'keys.next'],
  ['k', 'ArrowUp', 'prev', 'keys.prev'],
  ['Enter', '', 'open', 'keys.open'],
  ['n', '', 'newNote', 'keys.newNote'],
  ['i', '', 'insert', 'keys.insert'],
  ['r', '', 'flag', 'keys.flag'],
  ['m', '', 'myTurn', 'keys.myTurn'],
  ['.', '', 'nextSpeaker', 'keys.nextSpeaker'],
  [',', '', 'prevSpeaker', 'keys.prevSpeaker'],
  ['a', '', 'stActive', 'keys.stActive'],
  ['p', '', 'stPaused', 'keys.stPaused'],
  ['l', '', 'stListening', 'keys.stListening'],
  ['x', '', 'complete', 'keys.complete'],
  ['b', '', 'back', 'keys.back'],
  ['/', '', 'search', 'keys.search'],
  ['?', '', 'help', 'keys.help'],
  ['Escape', '', 'escape', 'keys.escape'],
];

// Editing-mode commands, configurable (help dialog). A binding is
// "Ctrl+Shift+Enter"-style text: modifiers Ctrl, Shift, Meta (⌘) and a
// key. Defaults avoid what browsers or macOS take (⌘/Ctrl + R, W, T, N,
// L, Q, F, …; Option/Alt + letters type characters on a Mac).
export const EDIT_COMMANDS = {};
export const KEYS_PREF = 'oe1ebg-netlog-keys';
const RESERVED = /^(Ctrl|Meta)\+(r|w|t|n|l|q|f|p|s|o|h|m|z|y|a|c|v|x|tab|\d|=|-|0)$/i;

export function registerEditCommand(name, binding, labelKey) {
  EDIT_COMMANDS[name] = { binding, def: binding, labelKey };
}

// The binding text of a keydown event, e.g. "Ctrl+Shift+Enter".
export function bindingOf(ev) {
  const mods = [ev.ctrlKey && 'Ctrl', ev.metaKey && 'Meta', ev.altKey && 'Alt', ev.shiftKey && 'Shift'].filter(Boolean);
  const k = ev.key.length === 1 ? ev.key.toUpperCase() : ev.key;
  return [...mods, k].join('+');
}

// Why a binding cannot be used, or '' (translation keys).
export function bindingProblem(binding, name) {
  const parts = String(binding).split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!key || mods.some(m => !['Ctrl', 'Shift', 'Meta', 'Alt'].includes(m))) return 'keys.badBinding';
  if (mods.includes('Alt')) return 'keys.noAlt';
  if (/^F\d+$/.test(key)) return 'keys.noFn';
  if (!mods.includes('Ctrl') && !mods.includes('Meta')) return 'keys.needCtrl';
  if (RESERVED.test(`${mods.includes('Ctrl') ? 'Ctrl' : 'Meta'}+${key}`) && !mods.includes('Shift')) return 'keys.reserved';
  for (const [n, c] of Object.entries(EDIT_COMMANDS)) if (n !== name && c.binding === binding) return 'keys.taken';
  return '';
}

export function loadEditBindings() {
  let saved = {};
  try { saved = JSON.parse(prefGet(KEYS_PREF, '{}')) || {}; } catch { saved = {}; }
  for (const [n, c] of Object.entries(EDIT_COMMANDS)) {
    if (typeof saved[n] === 'string' && !bindingProblem(saved[n], n)) c.binding = saved[n];
  }
}

export function setEditBinding(name, binding) {
  const problem = bindingProblem(binding, name);
  if (problem) return problem;
  EDIT_COMMANDS[name].binding = binding;
  prefSet(KEYS_PREF, JSON.stringify(Object.fromEntries(Object.entries(EDIT_COMMANDS).map(([n, c]) => [n, c.binding]))));
  return '';
}

export function isEditable(node) {
  if (!node || !node.closest) return false;
  if (node.isContentEditable) return true;
  if (node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
  if (node.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(node.type);
  return false;
}

// handlers: { command: ev => true when handled }; edit: { name: ev => … }
export function initKeys({ commands, edit, onMode }) {
  let mode = null;
  const syncMode = () => {
    const m = isEditable(document.activeElement) ? 'edit' : 'nav';
    if (m !== mode) { mode = m; onMode(m); }
  };
  document.addEventListener('focusin', syncMode);
  document.addEventListener('focusout', () => setTimeout(syncMode, 0));
  syncMode();
  document.addEventListener('keydown', ev => {
    if (ev.defaultPrevented || ev.isComposing || ev.keyCode === 229) return;
    // a dialog has its own keys (Esc closes it); the global ones wait
    if (document.querySelector('dialog[open]')) return;
    const target = ev.target;
    if (isEditable(target)) {
      if (ev.key === 'Escape' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (commands.leaveEditing && commands.leaveEditing(ev)) ev.preventDefault();
        return;
      }
      const b = bindingOf(ev);
      for (const [n, c] of Object.entries(EDIT_COMMANDS)) {
        if (c.binding === b && edit[n] && edit[n](ev)) { ev.preventDefault(); return; }
      }
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) {
      if (commands.modified && commands.modified(ev)) ev.preventDefault();
      return;
    }
    for (const [key, alt, cmd] of NAV_KEYS) {
      if (ev.key !== key && ev.key !== alt) continue;
      // Enter on a button/link activates it natively; arrows inside a
      // select or a group of radio buttons belong to it
      if (cmd === 'open' && target.closest && target.closest('button, a, summary, [role=button]')) return;
      if (commands[cmd] && commands[cmd](ev)) ev.preventDefault();
      return;
    }
  });
  return { mode: () => mode, syncMode };
}
