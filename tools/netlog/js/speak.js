// Running the round: above the roster, who is on air and who is next, and
// one button that moves on. Star (directed net): every station gives back
// to the NCS, the button calls the next station in the planned order (the
// NCS speaks in between, not recorded). Circle (round-robin): the button
// passes to the next station, the NCS included. Both skip stations that
// are paused, listening or checked out. When everyone has spoken the same
// button offers the next round: a suggestion, the user decides.

import { $ } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { setText, setAttr } from './keyed.js';
import { speakingState, netStyle, roundsSorted } from './model.js';
import { addContribution, createRound } from './ops.js';
import { callText, isOwn } from './roster.js';

export function initSpeak(app) {
  $('#btn-next').addEventListener('click', () => nextSpeaker(app));
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

export function renderSpeak(app) {
  const panel = $('#speak-panel');
  panel.hidden = !app.s;
  if (!app.s) return;
  const st = speakingState({ session: app.s, participants: app.sd.participants, contributions: app.sd.contributions });
  const style = netStyle(app.s);
  const round = app.sd.rounds.find(r => r.id === app.s.currentRoundId);
  const name = p => `${callText(p)}${isOwn(app, p) ? ` (${t('own.badge')})` : ''}`;
  setText($('#speak-style'), t(`style.short.${style}`));
  $('#speak-style').title = t(`style.${style}`);
  const parts = [];
  if (st.onAir) parts.push(t('speak.onAir', { call: name(st.onAir) }));
  if (st.next) parts.push(t('speak.next', { call: name(st.next) }));
  if (st.complete) parts.push(t('speak.complete', { n: round ? round.number : '?' }));
  if (!st.order.length) parts.push(t('speak.nobody'));
  setText($('#speak-state'), parts.join(' · '));
  const b = $('#btn-next');
  const nextNo = Math.max(0, ...roundsSorted(app.sd.rounds).map(r => r.number || 0)) + 1;
  setText(b, st.complete || !st.next ? t('speak.newRound', { n: nextNo }) : t('speak.nextBtn', { call: name(st.next) }));
  setAttr(b, 'aria-label', st.complete || !st.next ? t('speak.newRoundLabel', { n: nextNo }) : t('speak.nextLabel', { call: callText(st.next) }));
  b.classList.toggle('suggest-round', st.complete);
  b.disabled = app.readOnly || (!st.order.length && !st.complete);
}
