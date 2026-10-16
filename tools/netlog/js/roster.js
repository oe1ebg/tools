// The participant roster (sidebar) and the selected station's head and
// details in Live Notes: check-in with local candidate suggestions, inline
// correction of callsign/name, status, flags, details, roster order. No
// modal for routine work. Row focus model: each roster row is one button
// (the station's navigation surface: click or Enter opens its notes);
// j/k and the arrow keys move between rows (keys.js).

import { $, el, fill, popover, isComposing } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { keyedList, setText, setAttr, setValue } from './keyed.js';
import { rosterSorted, rosterStats, isUnresolved, callCandidates, normCall, STATUSES, FLAGS, live } from './model.js';
import { addParticipant, updateParticipant, setStatus, setFlag, moveParticipant } from './ops.js';

// "OE0QXA" or the provisional "?" marked as unresolved.
export function callText(p) {
  return p.call || '?';
}

export function statusLabel(status) {
  return t(`status.${status}`);
}

// Local identities for check-in/correction suggestions: profiles and the
// participants of other sessions (most recent first), never merged
// automatically.
function candidatePool(app) {
  const pool = [];
  for (const pr of app.data.profiles) if (live(pr)) pool.push({ call: pr.call, name: pr.name, profileId: pr.id, from: 'profile' });
  for (const p of [...app.data.knownCalls].reverse()) pool.push({ call: p.call, name: p.name, from: 'history' });
  return pool;
}

function candidateButtons(app, input, onPick) {
  const call = normCall(input.value);
  if (!call) return [];
  const exact = c => normCall(c.call) === call;
  return callCandidates(call, candidatePool(app)).filter(c => !exact(c) || isUnresolved(call)).map(c => el('button', {
    type: 'button',
    class: 'ac-item',
    onclick: () => onPick(c),
  }, el('b', {}, c.call), c.name ? el('small', {}, c.name) : null, el('small', { class: 'alt' }, t(c.from === 'profile' ? 'checkin.fromProfile' : 'checkin.fromHistory'))));
}

export function initRoster(app) {
  const form = $('#checkin-form');
  const call = $('#checkin-call');
  const name = $('#checkin-name');
  const pop = $('#checkin-pop');
  let picked = null;
  // a suggestion only fills the fields; Enter never replaces typed input with one
  const ac = popover(call, pop, { enterPicksFirst: false, label: t('checkin.suggestions') });
  app.onLang(() => pop.setAttribute('aria-label', t('checkin.suggestions')));
  const suggest = () => {
    fill(pop, candidateButtons(app, call, c => {
      call.value = c.call;
      name.value = c.name || name.value;
      picked = c.profileId || null;
      ac.hide();
      name.focus();
    }));
    ac.update();
  };
  call.addEventListener('input', () => { picked = null; suggest(); });
  call.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !isComposing(ev) && !ev.shiftKey) {
      ev.preventDefault();
      if (call.value.trim()) name.focus();
    }
  });
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (isComposingNow) return;
    const c = normCall(call.value) || '?';
    const typed = { call: call.value, name: name.value, picked };
    // empty at once, so the next station can be typed while this one saves
    call.value = '';
    name.value = '';
    picked = null;
    ac.hide();
    call.focus();
    const rec = await app.act(store => addParticipant(store, app.ctx(), { call: c, name: typed.name.trim(), profileId: typed.picked }));
    if (!rec) {
      // not saved: the input comes back (unless something new was typed)
      if (!call.value && !name.value) { call.value = typed.call; name.value = typed.name; picked = typed.picked; }
      return;
    }
    app.announce(t('checkin.done', { call: callText(rec) }));
    app.select(rec.id, { focus: false });
  });
  let isComposingNow = false;
  name.addEventListener('compositionstart', () => { isComposingNow = true; });
  name.addEventListener('compositionend', () => { isComposingNow = false; });

  $('#roster').addEventListener('click', ev => {
    const b = ev.target.closest('button.person');
    if (b) app.openStation(b.closest('li').dataset.key);
  });
  $('#roster').addEventListener('focusin', ev => {
    const li = ev.target.closest('li');
    if (li && li.dataset.key !== app.ui.selected) app.select(li.dataset.key, { focus: false });
  });
  $('#btn-roster-up').addEventListener('click', () => moveSelected(app, -1));
  $('#btn-roster-down').addEventListener('click', () => moveSelected(app, 1));

  initStation(app);
}

async function moveSelected(app, dir) {
  const id = app.ui.selected;
  if (!id) return;
  const moved = await app.act(store => moveParticipant(store, app.ctx(), id, dir, 'rosterOrder'));
  if (moved) app.announce(t(dir < 0 ? 'roster.movedUp' : 'roster.movedDown', { call: callText(app.participant(id)) }));
}

export function rosterRows(app) {
  return rosterSorted(app.sd.participants);
}

export function renderRoster(app) {
  const list = rosterRows(app);
  const st = rosterStats(app.sd.participants);
  setText($('#roster-stats'), t('roster.stats', { n: st.total, active: st.active }));
  keyedList($('#roster'), list, {
    key: p => p.id,
    create: () => el('li', { class: 'person-row' },
      el('button', { type: 'button', class: 'person' },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('b', { class: 'call mono' }),
        el('small', { class: 'pname' }),
        el('span', { class: 'badges' }))),
    update: (li, p) => {
      const b = li.firstElementChild;
      const [dot, callN, nameN, badges] = b.children;
      dot.className = `dot ${p.status}`;
      setText(callN, callText(p));
      callN.classList.toggle('unresolved', isUnresolved(p.call));
      setText(nameN, p.name || '');
      const marks = app.rowBadges(p);
      const sig = marks.map(m => m.text).join('|');
      if (badges.dataset.sig !== sig) {
        badges.dataset.sig = sig;
        fill(badges, marks.map(m => el('span', { class: `pill ${m.cls || ''}`, title: m.title || null }, m.text)));
      }
      const selected = p.id === app.ui.selected;
      li.classList.toggle('active', selected);
      setAttr(b, 'aria-current', selected ? 'true' : null);
      setAttr(b, 'aria-label', [callText(p), p.name, statusLabel(p.status), isUnresolved(p.call) ? t('station.unresolved') : '', ...marks.map(m => m.title || m.text)].filter(Boolean).join(', '));
      b.tabIndex = selected || (!app.ui.selected && p === list[0]) ? 0 : -1;
    },
  });
  const sel = app.participant(app.ui.selected);
  const i = list.findIndex(p => p.id === app.ui.selected);
  $('#btn-roster-up').disabled = !sel || i <= 0 || app.readOnly;
  $('#btn-roster-down').disabled = !sel || i < 0 || i >= list.length - 1 || app.readOnly;
  setAttr($('#btn-roster-up'), 'aria-label', sel ? t('roster.upLabel', { call: callText(sel) }) : null);
  setAttr($('#btn-roster-down'), 'aria-label', sel ? t('roster.downLabel', { call: callText(sel) }) : null);
  for (const n of $('#checkin-form').elements) n.disabled = app.readOnly;
}

// ---------- the station head and details ----------

function initStation(app) {
  const status = $('#station-status');
  status.addEventListener('change', () => {
    const p = app.participant(app.ui.selected);
    if (p) app.act(store => setStatus(store, app.ctx(), p.id, status.value));
  });
  $('#station-flags').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-flag]');
    const p = app.participant(app.ui.selected);
    if (b && p) app.act(store => setFlag(store, app.ctx(), p.id, b.dataset.flag, !p.flags[b.dataset.flag]));
  });

  const idForm = $('#identity-form');
  const idBtn = $('#btn-edit-identity');
  const idCall = $('#identity-call');
  const idName = $('#identity-name');
  const idPop = $('#identity-pop');
  const idAc = popover(idCall, idPop, { enterPicksFirst: false, label: t('checkin.suggestions') });
  const openIdentity = on => {
    const p = app.participant(app.ui.selected);
    idForm.hidden = !on || !p;
    idBtn.setAttribute('aria-expanded', String(!idForm.hidden));
    if (!idForm.hidden) {
      idCall.value = p.call;
      idName.value = p.name || '';
      idCall.focus();
      idCall.select();
    }
  };
  app.openIdentity = openIdentity;
  idBtn.addEventListener('click', () => openIdentity(idForm.hidden));
  $('#btn-identity-cancel').addEventListener('click', () => { openIdentity(false); idBtn.focus(); });
  idCall.addEventListener('input', () => {
    fill(idPop, candidateButtons(app, idCall, c => {
      idCall.value = c.call;
      if (c.name && !idName.value) idName.value = c.name;
      idAc.hide();
      idName.focus();
    }));
    idAc.update();
  });
  idForm.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); openIdentity(false); idBtn.focus(); }
  });
  idForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    const p = app.participant(app.ui.selected);
    if (!p) return;
    const r = await app.act(store => updateParticipant(store, app.ctx(), p.id, { call: normCall(idCall.value) || '?', name: idName.value.trim() }));
    if (r) {
      openIdentity(false);
      app.announce(t('station.corrected', { call: callText(r) }));
      idBtn.focus();
    }
  });

  const details = $('#station-details');
  const detBtn = $('#btn-details');
  detBtn.addEventListener('click', () => {
    details.hidden = !details.hidden;
    detBtn.setAttribute('aria-expanded', String(!details.hidden));
    app.ui.detailsOpen = !details.hidden;
  });
  // a detail is saved when the field is left (change); Enter does the same.
  // Until it is saved it is kept per station (pendingDetails), so neither a
  // re-render nor a failed save loses it.
  details.addEventListener('input', ev => {
    const key = ev.target.dataset.field;
    const p = app.participant(app.ui.selected);
    if (!key || !p) return;
    (pendingDetails[p.id] ||= {})[key] = fieldValue(ev.target);
  });
  details.addEventListener('change', ev => {
    const key = ev.target.dataset.field;
    const p = app.participant(app.ui.selected);
    if (key && p) (pendingDetails[p.id] ||= {})[key] = fieldValue(ev.target);
    commitDetails(app);
  });
  details.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target.matches('input:not([type=checkbox])') && !isComposing(ev)) {
      ev.preventDefault();
      commitDetail(app, ev.target);
    }
  });
  details.addEventListener('submit', ev => ev.preventDefault());
}

// Typed station details not saved yet: { participantId: { field: value } }.
const pendingDetails = {};

function fieldValue(f) {
  if (f.type === 'checkbox') return f.checked;
  return f.dataset.field === 'locator' ? f.value.trim().toUpperCase() : f.value.trim();
}

function commitDetail(app, field) {
  const key = field && field.dataset.field;
  const p = app.participant(app.ui.selected);
  if (!key || !p) return Promise.resolve(true);
  (pendingDetails[p.id] ||= {})[key] = fieldValue(field);
  return commitDetails(app);
}

// Save every pending detail (one change per station). Resolves true when
// nothing typed is left unsaved.
let detailChain = Promise.resolve(true);
function commitDetails(app) {
  detailChain = detailChain.then(async () => {
    let ok = true;
    for (const [id, fields] of Object.entries(pendingDetails)) {
      const p = app.participant(id);
      if (!p) { delete pendingDetails[id]; continue; }
      const patch = {};
      for (const [k, v] of Object.entries(fields)) if ((p[k] ?? (typeof v === 'boolean' ? false : '')) !== v) patch[k] = v;
      if (!Object.keys(patch).length) { delete pendingDetails[id]; continue; }
      const r = await app.act(store => updateParticipant(store, app.ctx(), id, patch), { quiet: false });
      if (!r) { ok = false; continue; }
      // only what was saved; typed meanwhile stays pending
      const now = pendingDetails[id] || {};
      for (const k of Object.keys(patch)) if (now[k] === patch[k]) delete now[k];
      if (!Object.keys(now).length) delete pendingDetails[id];
    }
    return ok;
  });
  return detailChain;
}

// Before leaving or updating: commit the field being typed in and every
// pending detail.
export function flushDetails(app) {
  const f = document.activeElement;
  if (f && f.closest && f.closest('#station-details') && f.dataset.field) {
    const p = app.participant(app.ui.selected);
    if (p) (pendingDetails[p.id] ||= {})[f.dataset.field] = fieldValue(f);
  }
  return commitDetails(app);
}

export function hasPendingDetails() {
  return Object.keys(pendingDetails).length > 0;
}

export function renderStation(app) {
  const p = app.participant(app.ui.selected);
  $('#station-empty').hidden = !!p;
  $('#station').hidden = !p;
  if (!p) return;
  const callN = $('#station-call');
  setText(callN, callText(p));
  callN.classList.toggle('unresolved', isUnresolved(p.call));
  setText($('#station-name'), p.name || '');
  const badges = app.rowBadges(p, true);
  const sig = badges.map(b => b.text).join('|');
  if ($('#station-badges').dataset.sig !== sig) {
    $('#station-badges').dataset.sig = sig;
    fill($('#station-badges'), badges.map(m => el('span', { class: `pill ${m.cls || ''}` }, m.title || m.text)));
  }
  const first = (p.presence || [])[0];
  const sub = [
    isUnresolved(p.call) ? t('station.unresolvedHint') : '',
    first && first.from.iso ? t('station.checkedIn', { time: first.from.iso.slice(11, 16) }) : '',
    p.call !== p.base && p.base ? t('station.base', { base: p.base }) : '',
  ].filter(Boolean).join(' · ');
  setText($('#station-sub'), sub);

  const status = $('#station-status');
  if (status.options.length !== STATUSES.length || status.dataset.lang !== app.lang()) {
    fill(status, STATUSES.map(s => el('option', { value: s }, statusLabel(s))));
    status.dataset.lang = app.lang();
  }
  if (document.activeElement !== status) status.value = p.status;
  status.disabled = app.readOnly;

  const flags = $('#station-flags');
  if (flags.childElementCount !== FLAGS.length || flags.dataset.lang !== app.lang()) {
    fill(flags, FLAGS.map(f => el('button', { type: 'button', class: 'mini flag', 'data-flag': f }, t(`flag.${f}`))));
    flags.dataset.lang = app.lang();
  }
  for (const b of flags.children) {
    setAttr(b, 'aria-pressed', String(!!p.flags[b.dataset.flag]));
    b.disabled = app.readOnly;
  }
  $('#btn-edit-identity').disabled = app.readOnly;

  const details = $('#station-details');
  details.hidden = !app.ui.detailsOpen;
  $('#btn-details').setAttribute('aria-expanded', String(!details.hidden));
  const pending = pendingDetails[p.id] || {};
  for (const f of details.querySelectorAll('[data-field]')) {
    f.disabled = app.readOnly;
    const k = f.dataset.field;
    const v = k in pending ? pending[k] : p[k];
    if (f.type === 'checkbox') { if (document.activeElement !== f) f.checked = !!v; }
    else if (!(k in pending) || document.activeElement !== f) setValue(f, v || '');
  }
  keyedList($('#presence-list'), (p.presence || []).map((iv, i) => ({ ...iv, i })), {
    key: iv => String(iv.i),
    create: () => el('li', {}),
    update: (li, iv) => setText(li, t('station.interval', {
      from: iv.from && iv.from.iso ? iv.from.iso.slice(11, 16) : '?',
      to: iv.to ? (iv.to.iso ? iv.to.iso.slice(11, 16) : '?') : t('station.now'),
    })),
  });
}
