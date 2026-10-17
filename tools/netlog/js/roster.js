// The participant roster (sidebar) and the selected station's head and
// details in Live Notes: check-in with local candidate suggestions, inline
// correction of callsign/name, status, flags, details, roster order. No
// modal for routine work. Row focus model: each roster row is one button
// (the station's navigation surface: click or Enter opens its notes);
// j/k and the arrow keys move between rows (keys.js).

import { $, el, fill, popover, isComposing } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { keyedList, setText, setAttr, setValue } from './keyed.js';
import { rosterSorted, rosterStats, isUnresolved, callCandidates, callPattern, normCall, callBase, STATUSES, FLAGS, live, ncsFirst } from './model.js';
import { addParticipant, updateParticipant, setStatus, setFlag, moveParticipant, setNcs, mergePreview, mergeParticipants, saveProfile, deleteParticipant } from './ops.js';
import { stationLinks } from './links.js';
import { hm, hmz, zone } from './clock.js';
import { turnMark } from './speak.js';
import { lookupCall, searchCallbook } from '../../shared/js/callbook.js';

// "OE0QXA" or the provisional "?" marked as unresolved.
export function callText(p) {
  return p.call || '?';
}

// Is this participant me (the session's own callsign)?
export function isOwn(app, p) {
  return !!(app.s && app.s.own && app.s.own.base && p && p.base === app.s.own.base);
}

// The status symbol shown in both lists (the words in the tooltip / for
// screen readers): paused/away, monitoring, unconfirmed, checked out.
export const STATUS_MARK = { paused: '⏸', listening: '🎧', unconfirmed: '?', out: '✕' };

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

// The Austrian callsign list (shared data, offline) for a complete
// callsign: { call, name, qth } or null.
export function callbookEntry(app, call) {
  if (!app.data.callbook || !call || isUnresolved(call)) return null;
  const e = lookupCall(app.data.callbook, call).entry;
  return e ? { call: e[0], name: e[1] || '', qth: e[2] || '' } : null;
}

// Callbook entries for what is typed: part of a callsign, a name or a
// place; for a partial callsign (OE0QX?) those its pattern fits.
function callbookCandidates(app, text, limit = 6) {
  const book = app.data.callbook;
  if (!book) return [];
  const call = normCall(text);
  let rows;
  if (isUnresolved(call)) {
    const re = callPattern(call);
    rows = re ? book.calls.filter(c => re.test(c[0])).slice(0, limit) : [];
  } else {
    rows = searchCallbook(book, text, limit);
  }
  return rows.map(c => ({ call: c[0], name: c[1] || '', qth: c[2] || '', from: 'callbook' }));
}

const FROM_KEY = { profile: 'checkin.fromProfile', history: 'checkin.fromHistory', callbook: 'checkin.fromCallbook' };

export function candidateButtons(app, input, onPick) {
  const call = normCall(input.value);
  if (!call) return [];
  const exact = c => normCall(c.call) === call;
  const local = callCandidates(call, candidatePool(app)).filter(c => !exact(c) || isUnresolved(call));
  const seen = new Set(local.map(c => callBase(c.call)));
  const book = callbookCandidates(app, input.value).filter(c => !seen.has(c.call) && (!exact(c) || isUnresolved(call)));
  return [...local, ...book].map(c => el('button', {
    type: 'button',
    class: 'ac-item',
    onclick: () => onPick(c),
  }, el('b', {}, c.call), c.name ? el('small', {}, c.name) : null, c.qth ? el('small', {}, c.qth) : null,
  el('small', { class: 'alt' }, t(FROM_KEY[c.from]))));
}

// The info line under a callsign field: what the callsign list says.
function callbookInfo(app, field, info) {
  const e = callbookEntry(app, normCall(field.value));
  setText(info, e ? t('checkin.inCallbook', { name: [e.name, e.qth].filter(Boolean).join(' · ') || e.call }) : '');
  info.className = `ac-info${e ? ' known' : ''}`;
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
  const info = $('#checkin-info');
  const suggest = () => {
    fill(pop, candidateButtons(app, call, c => {
      call.value = c.call;
      name.value = c.name || name.value;
      picked = { profileId: c.profileId || null, qth: c.qth || '' };
      ac.hide();
      callbookInfo(app, call, info);
      name.focus();
    }));
    ac.update();
  };
  call.addEventListener('input', () => { picked = null; suggest(); callbookInfo(app, call, info); });
  app.onCallbook = () => { if (document.activeElement === call) suggest(); callbookInfo(app, call, info); };
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
    setText(info, '');
    call.focus();
    // what the callsign list knows fills what was left empty (a profile's
    // details come in through the profile)
    const fields = { call: c, name: typed.name.trim(), profileId: typed.picked && typed.picked.profileId, qth: typed.picked ? typed.picked.qth : '' };
    const e = !fields.profileId && callbookEntry(app, c);
    if (e) {
      if (!fields.name) fields.name = e.name;
      if (!fields.qth) fields.qth = e.qth;
    }
    const rec = await app.act(store => addParticipant(store, app.ctx(), fields));
    if (!rec) {
      // not saved: the input comes back (unless something new was typed)
      if (!call.value && !name.value) { call.value = typed.call; name.value = typed.name; picked = typed.picked; callbookInfo(app, call, info); }
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
  // Keyboard focus (j/k, Tab) selects at once; a pointer selects on its
  // click: re-rendering on pointer-down would change the page height
  // under the pointer, and the release would land elsewhere.
  // The release may land outside the roster (a tap that shifts the layout
  // on a phone): it is caught document-wide, and any key ends pointer mode,
  // or j/k would only move the focus from then on.
  let pointer = false;
  const pointerDone = () => { setTimeout(() => { pointer = false; }, 0); };
  $('#roster').addEventListener('pointerdown', () => { pointer = true; });
  document.addEventListener('pointerup', pointerDone, true);
  document.addEventListener('pointercancel', pointerDone, true);
  document.addEventListener('keydown', () => { pointer = false; }, true);
  $('#roster').addEventListener('focusin', ev => {
    const li = ev.target.closest('li');
    if (pointer) return;
    if (li && li.dataset.key !== app.ui.selected) app.select(li.dataset.key, { focus: false });
  });
  $('#btn-roster-up').addEventListener('click', () => moveSelected(app, -1));
  $('#btn-roster-down').addEventListener('click', () => moveSelected(app, 1));

  initStation(app);
}

function focusRosterButton(id) {
  $('#roster').querySelector(`li[data-key="${CSS.escape(id)}"] button.person`)?.focus();
}

// The merge question with a preview of what would move.
async function askMerge(app, from, into) {
  const dlg = $('#merge-dlg');
  const pv = await mergePreview(app.store, app.sessionId(), from.id);
  setText($('#merge-text'), t('merge.text', { from: callText(from), into: `${callText(into)}${into.name ? ` (${into.name})` : ''}` }));
  fill($('#merge-preview'),
    el('li', {}, t('merge.notes', { n: pv.notes })),
    el('li', {}, t('merge.contributions', { n: pv.contributions })),
    el('li', {}, t('merge.events', { n: pv.events })),
    el('li', {}, t('merge.presence', { n: (from.presence || []).length })));
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue || 'cancel'), { once: true });
  });
}

async function moveSelected(app, dir) {
  const id = app.ui.selected;
  if (!id) return;
  const moved = await app.act(store => moveParticipant(store, app.ctx(), id, dir, 'rosterOrder'));
  if (moved) app.announce(t(dir < 0 ? 'roster.movedUp' : 'roster.movedDown', { call: callText(app.participant(id)) }));
}

// The roster as shown: the NCS first, then the roster order.
export function rosterRows(app) {
  return ncsFirst(rosterSorted(app.sd.participants), app.s && app.s.ncsId);
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
        el('span', { class: 'badges' }),
        // the details for screen readers, after the visible text (so the
        // name starts with what is shown, WCAG 2.5.3)
        el('span', { class: 'sr-only' }))),
    update: (li, p) => {
      const b = li.firstElementChild;
      const [dot, callN, nameN, badges, details] = b.children;
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
      li.classList.toggle('own', isOwn(app, p));
      li.classList.toggle('ncs', !!app.s && app.s.ncsId === p.id);
      for (const s of STATUSES) li.classList.toggle(`st-${s}`, p.status === s);
      const mark = turnMark(app, p);
      li.classList.toggle('on-air', mark === 'on-air');
      li.classList.toggle('up-next', mark === 'next');
      setAttr(b, 'aria-current', selected ? 'true' : null);
      setText(details, ['', statusLabel(p.status), isUnresolved(p.call) ? t('station.unresolved') : '', ...marks.map(m => m.title).filter(Boolean)].filter((x, i) => i === 0 || x).join(', '));
      setAttr(b, 'aria-label', null);
      b.tabIndex = selected || (!app.ui.selected && p === list[0]) ? 0 : -1;
    },
  });
  const sel = app.participant(app.ui.selected);
  const i = list.findIndex(p => p.id === app.ui.selected);
  // the NCS stays first: it does not move, and nobody moves above it
  const ncsTop = app.s && app.s.ncsId && list[0] && list[0].id === app.s.ncsId ? 1 : 0;
  const isNcs = sel && sel.id === (app.s && app.s.ncsId);
  $('#btn-roster-up').disabled = !sel || isNcs || i <= ncsTop || app.readOnly;
  $('#btn-roster-down').disabled = !sel || isNcs || i < 0 || i >= list.length - 1 || app.readOnly;
  for (const [id, key] of [['#btn-roster-up', 'roster.upLabel'], ['#btn-roster-down', 'roster.downLabel']]) {
    setAttr($(id), 'aria-label', sel ? t(key, { call: callText(sel) }) : null);
    setAttr($(id), 'title', sel ? t(key, { call: callText(sel) }) : null);
  }
  for (const n of $('#checkin-form').elements) n.disabled = app.readOnly;
}

// ---------- the station head and details ----------

function initStation(app) {
  const status = $('#station-status');
  status.addEventListener('change', () => {
    const p = app.participant(app.ui.selected);
    if (p) app.act(store => setStatus(store, app.ctx(), p.id, status.value));
  });
  for (const box of [$('#station-flags')]) box.addEventListener('click', ev => {
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
  // ✎ opens one edit panel right under the heading: callsign and name,
  // then every detail of the station
  const panel = $('#station-edit');
  const openIdentity = on => {
    const p = app.participant(app.ui.selected);
    app.ui.detailsOpen = on && p ? p.id : null;
    panel.hidden = !app.ui.detailsOpen;
    idBtn.setAttribute('aria-expanded', String(!!app.ui.detailsOpen));
    if (app.ui.detailsOpen) {
      idCall.value = p.call;
      idName.value = p.name || '';
      app.render();
      idCall.focus();
      idCall.select();
    }
  };
  app.openIdentity = openIdentity;
  idBtn.addEventListener('click', () => openIdentity(panel.hidden));
  $('#btn-identity-cancel').addEventListener('click', () => { openIdentity(false); idBtn.focus(); });
  idCall.addEventListener('input', () => {
    callbookInfo(app, idCall, $('#identity-info'));
    fill(idPop, candidateButtons(app, idCall, c => {
      idCall.value = c.call;
      if (c.name && !idName.value) idName.value = c.name;
      callbookInfo(app, idCall, $('#identity-info'));
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
    const call = normCall(idCall.value) || '?';
    // the corrected callsign is another station of this session: offer
    // to merge (preview, explicit), never merge by itself
    const twin = !isUnresolved(call) && app.sd.participants.find(x => live(x) && x.id !== p.id && x.base === callBase(call));
    if (twin) {
      const choice = await askMerge(app, p, twin);
      if (choice === 'cancel') { idCall.focus(); return; }
      if (choice === 'merge') {
        const r = await app.act(store => mergeParticipants(store, app.ctx(), p.id, twin.id));
        if (r) {
          openIdentity(false);
          app.ui.selected = twin.id;
          app.render();
          app.announce(t('merge.done', { call: callText(twin) }));
          focusRosterButton(twin.id);
        }
        return;
      }
    }
    // a resolved callsign: the list fills what is still empty
    const patch = { call, name: idName.value.trim() };
    const e = callbookEntry(app, call);
    if (e) {
      if (!patch.name) patch.name = e.name;
      if (!p.qth && e.qth) patch.qth = e.qth;
    }
    const r = await app.act(store => updateParticipant(store, app.ctx(), p.id, patch));
    if (r) {
      openIdentity(false);
      app.announce(t('station.corrected', { call: callText(r) }));
      idBtn.focus();
    }
  });

  $('#btn-ncs').addEventListener('click', async () => {
    const p = app.participant(app.ui.selected);
    if (!p) return;
    const on = app.s.ncsId !== p.id;
    const r = await app.act(store => setNcs(store, app.ctx(), on ? p.id : null));
    if (r) app.announce(t(on ? 'ncs.assigned' : 'ncs.cleared', { call: callText(p) }));
  });
  $('#btn-own-turn').addEventListener('click', () => app.openStation(app.ui.selected));
  $('#btn-remove-station').addEventListener('click', async () => {
    const p = app.participant(app.ui.selected);
    if (!p || !globalThis.confirm(t('station.removeConfirm', { call: callText(p) }))) return;
    const list = rosterSorted(app.sd.participants);
    const next = list[list.indexOf(p) + 1] || list[list.indexOf(p) - 1] || null;
    const r = await app.act(store => deleteParticipant(store, app.ctx(), p.id));
    if (!r) return;
    app.ui.selected = next ? next.id : null;
    app.render();
    app.announce(t('station.removed', { call: callText(p) }));
    if (next) focusRosterButton(next.id); else $('#checkin-call').focus();
  });
  $('#btn-profile').addEventListener('click', async () => {
    const p = app.participant(app.ui.selected);
    if (!p) return;
    await flushDetails(app);
    const r = await app.act(store => saveProfile(store, app.ctx(), p.id));
    if (r) app.announce(t('station.profileSaved', { call: callText(p) }));
  });

  const details = $('#station-details');
  details.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); flushDetails(app).then(() => { openIdentity(false); idBtn.focus(); }); }
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
    first && first.from.iso ? t('station.checkedIn', { time: hmz(first.from.iso) }) : '',
    p.call !== p.base && p.base ? t('station.base', { base: p.base }) : '',
  ].filter(Boolean).join(' · ');
  setText($('#station-sub'), sub);
  const links = stationLinks(p.call);
  const lsig = `${links.map(l => l.href).join('|')}|${app.lang()}`;
  const lbox = $('#station-links');
  if (lbox.dataset.sig !== lsig) {
    lbox.dataset.sig = lsig;
    fill(lbox, links.length ? [el('span', { class: 'hint' }, t('station.lookup')), ' ',
      links.map(l => [el('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': t('station.lookupLabel', { site: l.label, call: callText(p) }) }, `${l.label} ↗`), ' '])] : []);
  }
  lbox.hidden = !links.length;

  const status = $('#station-status');
  if (status.options.length !== STATUSES.length || status.dataset.lang !== app.lang()) {
    fill(status, STATUSES.map(s => el('option', { value: s }, statusLabel(s))));
    status.dataset.lang = app.lang();
  }
  if (document.activeElement !== status) status.value = p.status;
  status.disabled = app.readOnly;

  for (const [box, list] of [[$('#station-flags'), FLAGS]]) {
    if (box.childElementCount !== list.length || box.dataset.lang !== app.lang()) {
      fill(box, list.map(f => el('button', { type: 'button', class: 'flag', 'data-flag': f }, t(`flag.${f}`))));
      box.dataset.lang = app.lang();
    }
    for (const b of box.children) {
      setAttr(b, 'aria-pressed', String(!!p.flags[b.dataset.flag]));
      b.disabled = app.readOnly;
    }
  }
  $('#btn-edit-identity').disabled = app.readOnly;
  const isNcs = app.s && app.s.ncsId === p.id;
  setAttr($('#btn-ncs'), 'aria-pressed', String(!!isNcs));
  setText($('#btn-ncs'), t(isNcs ? 'station.isNcs' : 'station.ncs'));
  $('#btn-ncs').disabled = app.readOnly;
  $('#btn-profile').disabled = app.readOnly;
  $('#btn-remove-station').disabled = app.readOnly;
  $('#own-turn').hidden = !isOwn(app, p);
  const prof = p.profileId && app.data.profiles.find(x => x.id === p.profileId && live(x));
  setText($('#profile-state'), prof ? t('station.profileLinked') : '');

  const details = $('#station-details');
  // the edit panel belongs to one station; another one opens closed
  const editing = app.ui.detailsOpen === p.id;
  $('#station-edit').hidden = !editing;
  $('#btn-edit-identity').setAttribute('aria-expanded', String(editing));
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
      from: iv.from && iv.from.iso ? hm(iv.from.iso) : '?',
      to: iv.to ? (iv.to.iso ? hm(iv.to.iso) : '?') : t('station.now'),
      zone: zone(iv.from && iv.from.iso),
    })),
  });
}
