// Running the round: above the roster, who is on air and who is next, and
// one button that moves on. Star (directed net): every station gives back
// to the NCS, the button calls the next station in the planned order (the
// NCS speaks in between, not recorded). Circle (round-robin): the button
// passes to the next station, the NCS included. Both skip stations that
// are paused, listening or checked out. When everyone has spoken the same
// button offers the next round: a suggestion, the user decides.

import { $, el, fill } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { setText, setAttr } from './keyed.js';
import { speakingState, netStyle, roundsSorted } from './model.js';
import { addContribution, createRound } from './ops.js';
import { callText, isOwn } from './roster.js';

export function initSpeak(app) {
  $('#btn-next').addEventListener('click', () => nextSpeaker(app));
  $('#speak-strip').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-pid]');
    if (b) app.openStation(b.dataset.pid);
  });
}

// The turn strip: one chip per station in speaking order, its state at a
// glance (spoken, speaking, next, then), the NCS as the hub of a star.
function chip(app, p, st, hub) {
  const state = st.onAir && st.onAir.id === p.id ? 'on-air'
    : st.next && st.next.id === p.id ? 'next'
      : st.then && st.then.id === p.id ? 'then'
        : st.spoken.has(p.id) ? 'spoken' : 'waiting';
  const sym = { 'on-air': '●', next: '▶', then: '▷', spoken: '✓', waiting: '' }[state];
  return el('li', { class: `sp-chip ${state}${hub ? ' hub' : ''}${isOwn(app, p) ? ' own' : ''}` },
    el('button', { type: 'button', 'data-pid': p.id, 'aria-label': `${callText(p)}: ${t(`speak.chip.${state}`)}${hub ? `, ${t('ncs.current')}` : ''}`, title: t(`speak.chip.${state}`) },
      sym ? el('span', { class: 'sym', 'aria-hidden': 'true' }, sym) : null,
      el('span', { class: 'c' }, callText(p))));
}

function renderStrip(app, st, style) {
  const strip = $('#speak-strip');
  // only now and next (and, in a star, the station after the NCS)
  const items = [];
  const isHub = p => !!st.ncs && p.id === st.ncs.id;
  const arrow = () => el('li', { class: 'sp-link', 'aria-hidden': 'true' }, '→');
  if (st.onAir) items.push(chip(app, st.onAir, st, isHub(st.onAir)));
  if (st.next) { if (items.length) items.push(arrow()); items.push(chip(app, st.next, st, isHub(st.next))); }
  // "then" on its own line, so the strip keeps one line
  setText($('#speak-then'), st.then ? t('speak.thenLine', { call: callText(st.then) + (isOwn(app, st.then) ? ` (${t('own.badge')})` : '') }) : '');
  strip.classList.toggle('star', style === 'star');
  fill(strip, items);
}

// Start the next round at once (the next number; the topic can be added in
// Net Control); undo takes it back.
export async function startNextRound(app) {
  const r = await app.act(store => createRound(store, app.ctx(), {}));
  if (r) app.announce(t('round.startedUndo', { n: r.number }));
  return r;
}

export async function nextSpeaker(app) {
  if (!app.s || app.readOnly) return;
  const st = speakingState({ session: app.s, participants: app.sd.participants, contributions: app.sd.contributions });
  if (st.complete || !st.next) { await startNextRound(app); return; }
  const p = st.next;
  const c = await app.act(store => addContribution(store, app.ctx(), p.id));
  if (!c) return;
  app.announce(t('speak.nowOnAir', { call: callText(p) }));
  // the station's notes (or My Turn, when it is me)
  app.openStation(p.id);
}

// A small picture of the net: star = the NCS as a hub with spokes to the
// stations, circle = stations on a ring passing on in turn. Decorative
// (the text next to it says the same).
const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
export function topologyIcon(style) {
  const root = svg('svg', { viewBox: '0 0 24 24', width: '22', height: '22', 'aria-hidden': 'true', class: `topo-icon ${style}` });
  const pts = [0, 1, 2, 3, 4].map(i => {
    const a = -Math.PI / 2 + i * (2 * Math.PI / 5);
    return [12 + 9 * Math.cos(a), 12 + 9 * Math.sin(a)];
  });
  if (style === 'star') {
    for (const [x, y] of pts) root.append(svg('line', { x1: 12, y1: 12, x2: x.toFixed(1), y2: y.toFixed(1), class: 'spoke' }));
    root.append(svg('circle', { cx: 12, cy: 12, r: 3.2, class: 'hub' }));
  } else {
    root.append(svg('circle', { cx: 12, cy: 12, r: 9, class: 'ring' }));
  }
  for (const [x, y] of pts) root.append(svg('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.2, class: 'node' }));
  return root;
}

// Whose turn it is, for the roster rows: 'on-air' / 'next' / ''.
export function turnMark(app, p) {
  if (!app.s) return '';
  const st = app.speak || speakingState({ session: app.s, participants: app.sd.participants, contributions: app.sd.contributions });
  if (st.onAir && st.onAir.id === p.id) return 'on-air';
  if (st.next && st.next.id === p.id) return 'next';
  return '';
}

export function renderSpeak(app) {
  const panel = $('#speak-panel');
  panel.hidden = !app.s;
  if (!app.s) return;
  const st = speakingState({ session: app.s, participants: app.sd.participants, contributions: app.sd.contributions });
  app.speak = st;
  const style = netStyle(app.s);
  // the roster draws the topology: spokes from the NCS, or a chain
  const ul = $('#roster');
  ul.classList.toggle('topo-star', style === 'star' && !!st.ncs);
  ul.classList.toggle('topo-circle', style === 'circle');
  const hint = $('#topo-hint');
  hint.hidden = !st.order.length;
  setText(hint, t(style === 'circle' ? 'topo.circleHint' : 'topo.starHint', { ncs: st.ncs ? callText(st.ncs) : t('ncs.short') }));
  const round = app.sd.rounds.find(r => r.id === app.s.currentRoundId);
  const name = p => `${callText(p)}${isOwn(app, p) ? ` (${t('own.badge')})` : ''}`;
  const icon = $('#speak-style');
  if (icon.dataset.style !== `${style}|${app.lang()}`) {
    icon.dataset.style = `${style}|${app.lang()}`;
    fill(icon, topologyIcon(style), el('span', {}, t(`style.short.${style}`)));
    icon.title = t(`style.${style}`);
  }
  const parts = [];
  if (st.onAir) parts.push(t('speak.onAir', { call: name(st.onAir) }));
  if (st.next) parts.push(st.then ? t('speak.nextThen', { call: name(st.next), then: name(st.then) }) : t('speak.next', { call: name(st.next) }));
  if (st.complete) parts.push(t('speak.complete', { n: round ? round.number : '?' }));
  if (!st.order.length) parts.push(t('speak.nobody'));
  setText($('#speak-state'), parts.join(' · '));
  renderStrip(app, st, style);
  // me: speaking now or next, loud enough to notice from across the room
  const meState = st.onAir && isOwn(app, st.onAir) ? 'onAir' : st.next && isOwn(app, st.next) ? 'next' : st.then && isOwn(app, st.then) ? 'soon' : '';
  // always there (no jumping): about me, or how far the round is
  const meP = $('#speak-me');
  const doneN = st.order.filter(p => st.spoken.has(p.id)).length;
  setText(meP, meState ? t(`speak.me.${meState}`) : st.order.length ? t('speak.progress', { n: round ? round.number : '?', done: doneN, all: st.order.length }) : '');
  for (const k of ['onAir', 'next', 'soon']) {
    $('#speak-panel').classList.toggle(`me-${k}`, meState === k);
    $('#tab-turn').classList.toggle(`me-${k}`, meState === k);
  }
  const b = $('#btn-next');
  const nextNo = Math.max(0, ...roundsSorted(app.sd.rounds).map(r => r.number || 0)) + 1;
  setText(b, st.complete || !st.next ? t('speak.newRound', { n: nextNo }) : t('speak.nextBtn', { call: name(st.next) }));
  setAttr(b, 'aria-label', st.complete || !st.next ? t('speak.newRoundLabel', { n: nextNo }) : t('speak.nextLabel', { call: callText(st.next) }));
  b.classList.toggle('suggest-round', st.complete);
  b.disabled = app.readOnly || (!st.order.length && !st.complete);
}
