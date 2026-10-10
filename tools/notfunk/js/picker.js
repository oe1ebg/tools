// Date and time pickers for the text fields of the message book: a button
// next to the field opens a small calendar (week from Monday) or a time
// grid (hours 00–23, minutes in steps of 5). They write the one format of
// the fields, YYYY-MM-DD and HH:MM (24 hours), never the browser's locale,
// and work the same everywhere (also Safari 15.4, offline). Typing stays
// the fast way: the buttons are no Tab stops. An empty field opens on
// "now" (today, the current hour), and both have a "Jetzt" button.
//
// pickerMonth() and shiftMonth() are pure (node-tested); the rest is DOM.

import { el, fill } from '../../shared/js/dom.js';
import { nowIso } from '../../shared/js/time.js';
import { dateText, clockText, normDate, normTime } from './form.js';

const MONTH_NAMES = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

// 'YYYY-MM' moved by n months.
export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

// The calendar of a month: { title: 'Oktober 2026', weeks: [[date|null ×7]] },
// weeks from Monday, dates as 'YYYY-MM-DD'.
export function pickerMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`)];
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { title: `${MONTH_NAMES[m - 1]} ${y}`, weeks };
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

let pickerSeq = 0;
let openPicker = null; // { pop, close }

function setValue(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// Wraps the input with its button and dropdown; kind 'date' or 'time'.
// next: the field to focus after a pick (the time field after the date).
function attachPicker(input, kind, next) {
  const id = `dt-pop-${++pickerSeq}`;
  const label = kind === 'date' ? 'Kalender' : 'Uhrzeit wählen';
  const pop = el('div', { class: 'dt-pop', id, role: 'dialog', 'aria-label': label, hidden: '' });
  const btn = el('button', {
    type: 'button', class: 'dt-btn', tabindex: '-1', 'aria-label': label, title: label,
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': id,
  }, el('span', { 'aria-hidden': 'true' }, kind === 'date' ? '📅' : '🕒'));
  // inside a <label> the button's name would join the field's: the field
  // keeps the label's text as its own name
  const outer = input.closest('label');
  if (outer && !input.hasAttribute('aria-label') && !input.hasAttribute('aria-labelledby')) input.setAttribute('aria-label', outer.textContent.trim());
  const wrap = el('span', { class: 'dt-wrap' });
  input.replaceWith(wrap);
  wrap.append(input, btn, pop);

  let view = '';   // date: the month shown ('YYYY-MM'); time: the hour chosen
  let focus = '';  // date: the day with focus

  const close = (back = false) => {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (openPicker?.pop === pop) openPicker = null;
    if (back) input.focus();
  };
  const pick = value => {
    setValue(input, value);
    close();
    (next || input).focus();
  };

  const renderDate = () => {
    const today = dateText(nowIso());
    const chosen = normDate(input.value) || '';
    const { title, weeks } = pickerMonth(view);
    // the one day that is a Tab stop: the focused, chosen or current day
    // of this month, else the 1st
    const target = [focus, chosen, today].find(d => d && d.startsWith(view)) || `${view}-01`;
    const nav = (n, text, name) => el('button', { type: 'button', class: 'dt-nav', 'aria-label': name, onclick: () => { view = shiftMonth(view, n); focus = ''; renderDate(); } }, text);
    fill(pop,
      el('div', { class: 'dt-head' }, nav(-1, '‹', 'Voriger Monat'), el('b', { 'aria-live': 'polite' }, title), nav(1, '›', 'Nächster Monat')),
      el('div', { class: 'dt-grid dt-days', role: 'grid' },
        ...WEEKDAYS.map(w => el('span', { class: 'dt-wd', 'aria-hidden': 'true' }, w)),
        ...weeks.flat().map(d => (d
          ? el('button', {
            type: 'button', class: ['dt-day', d === today ? 'today' : '', d === chosen ? 'on' : ''].filter(Boolean).join(' '),
            'data-date': d, tabindex: d === target ? '0' : '-1',
            'aria-label': `${Number(d.slice(8))}. ${title}`, 'aria-pressed': String(d === chosen), onclick: () => pick(d),
          }, String(Number(d.slice(8))))
          : el('span', { class: 'dt-empty' })))),
      el('div', { class: 'dt-foot' }, el('button', { type: 'button', onclick: () => pick(dateText(nowIso())) }, 'Heute')));
  };

  const renderTime = () => {
    const now = clockText(nowIso());
    const chosen = normTime(input.value) || '';
    const hour = view || (chosen || now).slice(0, 2);
    const minute = chosen ? chosen.slice(3) : '';
    const cell = (text, on, current, onclick, name) => el('button', {
      type: 'button', class: ['dt-cell', on ? 'on' : '', current ? 'today' : ''].filter(Boolean).join(' '), 'aria-pressed': String(on), 'aria-label': name, onclick,
    }, text);
    const hh = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
    const mm = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));
    fill(pop,
      el('div', { class: 'dt-cap' }, 'Stunde'),
      el('div', { class: 'dt-grid dt-hours' }, ...hh.map(h => cell(h, h === hour, h === now.slice(0, 2), () => { view = h; renderTime(); pop.querySelector('.dt-mins button')?.focus(); }, `${h} Uhr`))),
      el('div', { class: 'dt-cap' }, 'Minute'),
      el('div', { class: 'dt-grid dt-mins' }, ...mm.map(m => cell(`:${m}`, chosen.slice(0, 2) === hour && m === minute, false, () => pick(`${hour}:${m}`), `${hour}:${m}`))),
      el('div', { class: 'dt-foot' }, el('button', { type: 'button', onclick: () => pick(now) }, 'Jetzt')));
  };

  const open = () => {
    openPicker?.close();
    if (kind === 'date') { view = (normDate(input.value) || dateText(nowIso())).slice(0, 7); focus = ''; renderDate(); } else { view = ''; renderTime(); }
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    openPicker = { pop, close };
    (pop.querySelector('.dt-day[tabindex="0"]') || pop.querySelector('.dt-hours .dt-cell.on') || pop.querySelector('button'))?.focus();
  };

  btn.addEventListener('click', () => (pop.hidden ? open() : close(true)));
  pop.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(true); return; }
    const day = ev.target.closest?.('.dt-day');
    if (!day || kind !== 'date') return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
    const months = { PageUp: -1, PageDown: 1 }[ev.key];
    if (!step && !months) return;
    ev.preventDefault();
    if (step) focus = addDays(day.dataset.date, step);
    else { const [y, m, d] = day.dataset.date.split('-'); view = shiftMonth(`${y}-${m}`, months); focus = `${view}-${d}`; }
    if (focus.slice(0, 7) !== view) view = focus.slice(0, 7);
    renderDate();
    // a day past the month's end (31 → 30) falls back to the last day
    (pop.querySelector(`[data-date="${focus}"]`) || [...pop.querySelectorAll('.dt-day')].pop())?.focus();
  });
}

// One click or tap outside closes the open picker.
globalThis.document?.addEventListener('pointerdown', ev => {
  if (openPicker && !openPicker.pop.parentNode.contains(ev.target)) openPicker.close();
});

// The pickers for a date + time pair (time optional) and for lone time fields.
export function attachDatePicker(dateInput, timeInput = null) {
  attachPicker(dateInput, 'date', timeInput);
  if (timeInput) attachPicker(timeInput, 'time', null);
}

export function attachTimePicker(timeInput) {
  attachPicker(timeInput, 'time', null);
}
