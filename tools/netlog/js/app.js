// Netlog: page controller. Loads the data, routes (#/ = sessions & series,
// #/s/<session>/<view>), renders the workspaces and runs every change
// through ops.js (one transaction each), the save chip following the
// commit. Design and data model: ../README.md.

import { $, el, fill } from '../../shared/js/dom.js';
import { initOffline, setOfflineText } from '../../shared/js/offline.js';
import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { openStorageWithNotices } from '../../shared/js/storageui.js';
import { requestPersistence, StorageClosedError } from '../../shared/js/storage.js';
import { repoLink, trackOnline, extLink, DATA_SOURCES } from '../../shared/js/sources.js';
import { loadDataFile } from '../../shared/js/data.js';
import { loadRepeaterIndex } from '../../shared/js/repeaterui.js';
import { newId } from '../../shared/js/time.js';
import { t, initLang, setLang, lang, applyI18n } from './i18n.js';
import { openNetlogStorage, NETLOG_STORES, SESSION_STORES } from './db.js';
import { memoryStore } from './memstore.js';
import { LeaseError, UndoConflictError } from './ops.js';
import { createSessionLock, CHANNEL_NAME } from './lock.js';
import { createSaveState } from './status.js';
import { setText, setAttr } from './keyed.js';
import { ncsFirst, sessionLabel, live, rosterSorted, isUnresolved, openQueueCount, FLAGS, speakingState } from './model.js';
import { initRoster, renderRoster, renderStation, flushDetails, callText, rosterRows, isOwn, STATUS_MARK } from './roster.js';
import { initSessions, renderSessions } from './sessions.js';
import { initControl, renderControl } from './control.js';
import { initKeys, loadEditBindings, registerEditCommand, EDIT_COMMANDS } from './keys.js';
import { initHelp, bindingText } from './help.js';
import { createDrafts } from './drafts.js';
import { timeMode, setTimeMode, hm, zone, localChoiceText } from './clock.js';
import { initNotes, renderNotes, focusNoteEditor, flagNote } from './notes.js';
import { initTurn, renderTurn, enterTurn, turnRows, focusedTurnItem, completeItem } from './myturn.js';
import { createNav } from './nav.js';
import { initLog, renderLog, logRows } from './clog.js';
import { initSearch } from './searchui.js';
import { initSpeak, renderSpeak, nextSpeaker } from './speak.js';
import { initHistory, renderHistory, historyStale } from './historyui.js';
import { initData, renderData, exportBackup } from './dataui.js';
import { initCallsigns } from './callsignui.js';
import { undo, undoStep, setStatus } from './ops.js';

const VIEWS = ['live', 'turn', 'log', 'control', 'series'];
const UI_PREF = 'oe1ebg-netlog-ui';

const app = {
  store: null,
  tab: newId(),
  readOnly: false,
  data: { series: [], sessions: [], profiles: [], knownCalls: [], participantCount: {} },
  s: null, // the open session
  sd: { participants: [], rounds: [], notes: [], items: [], contributions: [], turns: [], events: [] },
  ui: { view: 'series', selected: null, detailsOpen: null, roundOpen: {}, composeFlag: false },
  langHooks: [],
};
globalThis.NETLOG_APP = app; // the browser tests read state through this

app.lang = lang;
app.onLang = fn => app.langHooks.push(fn);
app.sessionId = () => (app.s ? app.s.id : null);
app.ctx = () => ({ sessionId: app.sessionId(), tab: app.tab });
app.participant = id => app.sd.participants.find(p => p.id === id && live(p)) || null;

const saveState = createSaveState(() => renderSaveChip());
app.saveState = saveState;
app.drafts = createDrafts(app);
app.nav = createNav(app);
const EMPTY_SD = () => ({ participants: [], rounds: [], notes: [], items: [], contributions: [], turns: [], events: [] });

// ---------- running changes ----------

// Run one op (ops.js) against the store: the chip shows "saving" until the
// commit and "saved" after it; then the data is reloaded and every
// workspace re-rendered, and the other tabs are told. Resolves to the op's
// result, or undefined when it failed (the reason is shown).
app.act = async (op, { global = false, quiet = false } = {}) => {
  if (app.readOnly && !global) {
    app.announce(t('lock.readOnlyNoChange'));
    return undefined;
  }
  let result;
  try {
    result = await saveState.track(op(app.store));
  } catch (e) {
    handleWriteError(e, quiet);
    return undefined;
  }
  await reload();
  broadcast();
  return result;
};

app.writeFailed = (e, quiet) => handleWriteError(e, quiet);

function handleWriteError(e, quiet) {
  // an undo refused on purpose is no error of the page
  // as text: every browser prints it the same ("QuotaExceededError: …")
  if (e instanceof UndoConflictError) console.warn(e);
  else console.error(`Netlog: write failed: ${(e && e.name) || 'Error'}: ${(e && e.message) || e}`);
  if (e instanceof LeaseError) {
    setReadOnly(true, 'taken');
    showBanner(t('lock.lostWrite'), 'warn');
    return;
  }
  if (e instanceof UndoConflictError) {
    app.announce(t('undo.conflict'));
    showBanner(t('undo.conflict'), 'warn');
    return;
  }
  if (e instanceof StorageClosedError) {
    showBanner(t('storage.closed'), 'err', [el('button', { type: 'button', onclick: () => location.reload() }, t('common.reload'))]);
    return;
  }
  if (!quiet) {
    const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message)));
    showBanner(t(quota ? 'save.quota' : 'save.failedBanner', { error: String((e && (e.message || e.name)) || e) }), 'err');
  }
}

function showBanner(text, kind = 'err', buttons = []) {
  const b = $('#banner');
  b.className = `banner ${kind}`;
  fill(b, text, ' ', buttons);
  b.hidden = false;
}
app.showBanner = showBanner;
app.hideBanner = () => { $('#banner').hidden = true; };

// Polite announcements for screen readers (one live region, rewritten
// only when the text changes; the save chip itself is not announced on
// every autosave).
app.announce = text => {
  const n = $('#announce');
  if (n.textContent === text) n.textContent = '';
  setTimeout(() => { n.textContent = text; }, 20);
};

// ---------- loading ----------

async function loadGlobal() {
  const [series, sessions, profiles, participants, meta] = await Promise.all(
    ['series', 'sessions', 'profiles', 'participants', 'meta'].map(s => app.store.getAll(s)));
  app.data.backups = new Map(meta.filter(m => m.id.startsWith('backup:')).map(m => [m.id.slice(7), m.at]));
  app.data.series = series;
  app.data.sessions = sessions;
  app.data.profiles = profiles;
  const count = {};
  for (const p of participants) if (live(p)) count[p.eventId] = (count[p.eventId] || 0) + 1;
  app.data.participantCount = count;
  // identities from other sessions, for check-in suggestions (by recency)
  app.data.knownCalls = participants.filter(p => live(p) && p.eventId !== app.sessionId() && p.call && !isUnresolved(p.call))
    .sort((a, b) => (a.created < b.created ? -1 : 1));
}

async function loadSession(id) {
  const out = {};
  await Promise.all(SESSION_STORES.filter(s => !['revisions', 'undo', 'drafts'].includes(s)).map(async s => {
    out[s] = await app.store.getByEvent(s, id);
  }));
  app.sd = out;
  app.s = app.data.sessions.find(s => s.id === id) || (await app.store.get('sessions', id)) || null;
}

async function reload() {
  historyStale();
  await loadGlobal();
  if (app.s) await loadSession(app.s.id);
  render();
}
app.reload = reload;

// ---------- routing ----------

function parseHash() {
  const m = /^#\/s\/([^/]+)(?:\/(\w+))?/.exec(location.hash);
  if (!m) return { sessionId: null, view: 'series' };
  return { sessionId: decodeURIComponent(m[1]), view: VIEWS.includes(m[2]) ? m[2] : 'live' };
}

app.go = (sessionId, view = 'live') => {
  const h = sessionId ? `#/s/${encodeURIComponent(sessionId)}/${view}` : '#/';
  if (location.hash === h) route();
  else location.hash = h;
};

app.setView = view => app.go(app.sessionId(), view);

async function route() {
  const { sessionId, view } = parseHash();
  await app.flush();
  if (sessionId !== app.sessionId()) await openSession(sessionId);
  const before = app.ui.view;
  app.ui.view = app.s ? view : 'series';
  if (app.ui.view === 'turn' && before !== 'turn') await enterTurn(app);
  render();
  saveUi();
}

// Open another session directly (Back across sessions), without a route.
app.openSessionNow = async (id, view) => {
  await openSession(id);
  app.ui.view = app.s ? view : 'series';
};

// The address follows the workspace without a new history entry.
app.syncHash = () => {
  const h = app.s ? `#/s/${encodeURIComponent(app.s.id)}/${app.ui.view}` : '#/';
  if (location.hash !== h) history.replaceState(null, '', h);
};

async function openSession(id) {
  lock.release();
  app.s = null;
  app.sd = EMPTY_SD();
  app.ui.roundOpen = {};
  await app.drafts.load(null);
  if (id) {
    const s = await app.store.get('sessions', id);
    if (!s || s.deleted) {
      app.announce(t('session.notFound'));
      history.replaceState(null, '', '#/');
    } else {
      app.s = s;
      await loadGlobal();
      await loadSession(id);
      const ui = loadUi(id);
      app.ui.selected = app.participant(ui.selected) ? ui.selected : (rosterSorted(app.sd.participants)[0] || {}).id || null;
      // the station whose edit panel is open (older state: a boolean)
      app.ui.detailsOpen = typeof ui.detailsOpen === 'string' ? ui.detailsOpen : null;
      setReadOnly(false, null);
      if (app.store.kind !== 'memory') await lock.acquire(id);
      await app.drafts.load(id);
      await reload();
    }
  }
}

// What each session's workspace looked like (selected station, …), per
// browser.
function loadUi(sessionId) {
  try { return (JSON.parse(localPref(UI_PREF) || '{}')[sessionId]) || {}; } catch { return {}; }
}
function saveUi() {
  if (!app.s) return;
  let all = {};
  try { all = JSON.parse(localPref(UI_PREF) || '{}') || {}; } catch { all = {}; }
  all[app.s.id] = { selected: app.ui.selected, detailsOpen: app.ui.detailsOpen, view: app.ui.view };
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k];
  localPref(UI_PREF, JSON.stringify(all));
}
const localPref = (k, v) => (v === undefined ? prefGet(k) : prefSet(k, v));

// ---------- selection and navigation ----------

app.select = (id, { focus = false } = {}) => {
  if (!app.participant(id)) return;
  if (id !== app.ui.selected) {
    app.ui.selected = id;
    // the selected station decides between Live Notes and My Turn: me ->
    // My Turn, anyone else -> their notes (the same for a click and j/k)
    const own = isOwn(app, app.participant(id));
    if (own && app.ui.view === 'live') switchView('turn');
    else if (!own && app.ui.view === 'turn') switchView('live');
    renderRoster(app);
    renderSpeak(app); // free-form: the button names the selected station
    if (app.ui.view === 'live') { renderStation(app); renderHistory(app); renderNotes(app); }
    saveUi();
  }
  if (focus) focusRosterRow(id);
};

function switchView(view) {
  app.ui.view = view;
  app.syncHash();
  if (view === 'turn') enterTurn(app);
  render();
}

// Set the selected station's status (keys a / p / l); pressing p or l
// again on that status brings the station back to active.
function setSelectedStatus(status) {
  const p = app.participant(app.ui.selected);
  if (!p || app.readOnly) return false;
  const to = p.status === status && status !== 'active' ? 'active' : status;
  if (to === p.status) return true;
  app.act(store => setStatus(store, app.ctx(), p.id, to)).then(() => app.announce(t('station.statusSet', { call: callText(p), status: t(`status.${to}`) })));
  return true;
}

// Move the selection one station along the net order (skipping paused,
// monitoring and checked-out ones); nothing is recorded.
function stepSelection(dir) {
  if (!app.s || $('#sidebar').hidden) return false;
  const st = speakingState({ session: app.s, participants: app.sd.participants, contributions: app.sd.contributions });
  // the list order, the NCS included (it is skipped by nobody)
  const order = ncsFirst(rosterSorted(app.sd.participants).filter(p => ['active', 'unconfirmed'].includes(p.status)), app.s.ncsId);
  if (!order.length) return false;
  let at = order.findIndex(p => p.id === app.ui.selected);
  if (at < 0 && st.onAir) at = order.findIndex(p => p.id === st.onAir.id);
  const p = order[Math.min(order.length - 1, Math.max(0, (at < 0 ? (dir < 0 ? order.length : -1) : at) + dir))];
  if (!p) return false;
  app.select(p.id);
  if (app.ui.view !== 'live' && !isOwn(app, p)) { app.ui.view = 'live'; app.syncHash(); render(); }
  focusRosterRow(p.id);
  return true;
}

function focusRosterRow(id) {
  const b = $('#roster').querySelector(`li[data-key="${CSS.escape(id)}"] button.person`);
  if (b) b.focus();
}

// Open a station's notes at its current-round editing position (roster
// click/Enter).
app.openStation = async id => {
  // my own station: no notes about myself, My Turn instead
  if (isOwn(app, app.participant(id))) {
    app.select(id);
    if (app.ui.view !== 'turn') { app.nav.push(); app.ui.view = 'turn'; app.syncHash(); await enterTurn(app); render(); }
    $('#turn-title').focus();
    return;
  }
  app.select(id);
  if (app.ui.view !== 'live') {
    app.ui.view = 'live';
    app.syncHash();
    render();
  }
  // navigation mode: the note field is entered with a click or i
  focusRosterRow(id);
};

// Jump to a station from another workspace (My Turn, Net Control, later
// the log and search): the origin is remembered for Back; the source
// round is expanded and the source note focused and highlighted. Never
// completes or changes anything.
app.openFrom = async (pid, { noteId = null, roundId = null, field = 'text' } = {}) => {
  if (!app.participant(pid)) return;
  app.nav.push();
  const note = noteId ? app.sd.notes.find(n => n.id === noteId) : null;
  const rid = note ? note.roundId : roundId;
  if (rid) app.ui.roundOpen[rid] = true;
  app.ui.selected = pid;
  app.ui.view = 'live';
  app.syncHash();
  render();
  saveUi();
  if (note) focusNoteEditor(app, note.id, { field, select: field === 'row' });
  else if (rid && rid !== app.s.currentRoundId) {
    const sec = $('#station-rounds').querySelector(`section.round[data-key="${CSS.escape(rid)}"] button.round-toggle`);
    if (sec) { sec.focus(); sec.scrollIntoView({ block: 'nearest' }); }
  } else focusRosterRow(pid);
};

// The source of a My Turn item.
app.openSource = id => {
  const item = app.sd.items.find(i => i.id === id);
  const note = item && item.noteId ? app.sd.notes.find(n => n.id === item.noteId) : null;
  if (note) app.openFrom(note.participantId, { noteId: note.id, field: 'row' });
};

// Jumps and Back run one after the other: a Back pressed while a jump
// still opens its session waits for it (and vice versa).
let navChain = Promise.resolve();
app.navigate = fn => {
  const p = navChain.then(fn, fn);
  navChain = p.catch(e => console.error(e));
  return p;
};

// Back to the origin of the last jump, else to `fallback`.
app.back = (fallback = null) => app.navigate(() => backNow(fallback));
async function backNow(fallback) {
  if (await app.nav.back()) return true;
  if (fallback && app.s) { app.ui.view = fallback; app.syncHash(); render(); if (fallback === 'live' && app.ui.selected) focusRosterRow(app.ui.selected); }
  return false;
}

app.editKeyText = name => (EDIT_COMMANDS[name] ? bindingText(EDIT_COMMANDS[name].binding) : '');

// Badges of a roster row / the station head: NCS, open responses, flags.
app.rowBadges = (p, long = false) => {
  const out = [];
  for (const f of FLAGS) {
    if (p.flags && p.flags[f]) out.push({ text: t(`flag.${f}.short`), title: t(`flag.${f}`), cls: '' });
  }
  if (app.s && app.s.ncsId === p.id) out.unshift({ text: 'NCS', title: t('ncs.current'), cls: 'ncs' });
  if (app.s && app.s.own && app.s.own.base && p.base === app.s.own.base) out.unshift({ text: t('own.badge'), title: t('own.title'), cls: 'own' });
  const notes = new Set(app.sd.notes.filter(n => live(n) && n.participantId === p.id).map(n => n.id));
  const open = app.sd.items.filter(i => live(i) && i.kind === 'response' && i.active !== false && i.state !== 'done' && notes.has(i.noteId)).length;
  if (open) out.push({ text: `↩ ${open}`, title: t('roster.openResponses', { n: open }) });
  if (isUnresolved(p.call)) out.push({ text: '?', title: t('station.unresolved'), cls: 'warn' });
  if (long && p.status !== 'active') out.push({ text: t(`status.${p.status}`), title: t(`status.${p.status}`) });
  else if (!long && p.status !== 'active' && p.status !== 'unconfirmed') out.unshift({ text: STATUS_MARK[p.status], title: t(`status.${p.status}`), cls: `st ${p.status}` });
  // only who is on air is marked; who follows is the next row in the list
  if (app.speak && app.speak.onAir && app.speak.onAir.id === p.id) out.unshift({ text: t('turn.short.onAir'), title: t('turn.badge.onAir'), cls: 'on-air' });
  return out;
};

app.helpEditRows = () => [
  el('tr', {}, el('td', {}, el('kbd', {}, 'Enter')), el('td', {}, t('keys.enterSaves'))),
  el('tr', {}, el('td', {}, el('kbd', {}, 'Ctrl/⌘+Enter')), el('td', {}, t('keys.ctrlEnter'))),
  el('tr', {}, el('td', {}, el('kbd', {}, 'Shift+Enter')), el('td', {}, t('keys.shiftEnter'))),
];

// ---------- read-only (another tab writes this session) ----------

function setReadOnly(ro, reason) {
  app.readOnly = ro;
  saveState.set('readOnly', ro);
  const b = $('#lock-banner');
  b.hidden = !ro;
  if (ro) setText($('#lock-text'), t(reason === 'taken' ? 'lock.taken' : 'lock.otherTab'));
  document.documentElement.classList.toggle('read-only', ro);
  render();
}

let lock = { release() {}, acquire: async () => true, onMessage() {} };
let channel = null;
function broadcast() {
  try { channel && channel.postMessage({ type: 'changed', sessionId: app.sessionId(), tab: app.tab }); } catch { /* closed */ }
}

// ---------- rendering ----------

function render() {
  const view = app.ui.view;
  const inSession = !!app.s;
  $('#sidebar').hidden = !inSession || view === 'series';
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  for (const a of $('#view-tabs').querySelectorAll('a[data-view]')) {
    const v = a.dataset.view;
    const href = v === 'series' ? (inSession ? `#/s/${encodeURIComponent(app.s.id)}/series` : '#/') : (inSession ? `#/s/${encodeURIComponent(app.s.id)}/${v}` : '#/');
    setAttr(a, 'href', href);
    // the sessions screen is not a workspace: it is left to and entered
    // from the back link, not part of the tabs
    a.hidden = v === 'series';
    setAttr(a, 'aria-current', v === view ? 'page' : null);
  }
  // the sessions screen has no workspace bar (tabs, search, undo, round): it belongs to a session's work
  $('.viewbar').hidden = view === 'series';
  const back = $('#btn-sessions');
  back.hidden = !inSession || view === 'series';
  setAttr(back, 'href', inSession ? `#/s/${encodeURIComponent(app.s.id)}/series` : '#/');
  renderHeader();
  if (inSession) {
    renderSpeak(app);
    renderRoster(app);
    if (view === 'live') { renderStation(app); renderHistory(app); renderNotes(app); }
    if (view === 'turn') renderTurn(app);
    if (view === 'log') renderLog(app);
    if (view === 'control') renderControl(app);
    const open = openQueueCount(app.sd.items, app.sd.notes);
    setText($('#tab-turn-count'), open ? ` · ${open}` : '');
  }
  $('#btn-new-round').hidden = !inSession || view === 'series';
  renderUndo();
  if (view === 'series') { renderSessions(app); renderData(app); }
  renderKeysLine();
}
app.render = render;

function renderHeader() {
  const s = app.s;
  const series = s && s.seriesId ? app.data.series.find(x => x.id === s.seriesId) : null;
  setText($('#session-line'), s ? [sessionLabel(s, series) || t('session.untitled'), s.date, s.own.call ? t('session.ownShort', { call: s.own.call }) : ''].filter(Boolean).join(' · ') : '');
  for (const b of $('#lang-toggle').querySelectorAll('button')) setAttr(b, 'aria-pressed', String(b.dataset.lang === lang()));
  for (const b of $('#time-toggle').querySelectorAll('button')) setAttr(b, 'aria-pressed', String(b.dataset.time === timeMode()));
  tick();
  const round = s && app.sd.rounds.find(r => r.id === s.currentRoundId);
  setText($('#round-indicator'), round ? t('round.indicator', { n: round.number }) : '');
  renderSaveChip();
  renderBackupChip();
}

// How current the last backup (JSON) of the open session is, like
// Notfunk's chip: notes saved or changed since its download started. No
// green "ok": a started download is no verified backup. A click downloads
// a new one.
function renderBackupChip() {
  const chip = $('#st-backup');
  if (!app.s) { chip.hidden = true; return; }
  const at = app.data.backups && app.data.backups.get(app.s.id);
  const since = app.sd.notes.filter(n => !at || n.updated > at).length;
  chip.hidden = !at && !since;
  chip.className = `chip chip-btn${since ? ' warn' : ''}`;
  setText(chip, at
    ? `${t('backup.started', { time: hm(at) + ' ' + zone(at) })} · ${since ? t('backup.since', { n: since }) : t('backup.nothingSince')}`
    : t('backup.none', { n: since }));
}

function renderSaveChip() {
  const [key, vars, cls] = saveState.view();
  const chip = $('#st-save');
  const text = t(key, vars);
  setText(chip, text);
  chip.title = text; // the chip has a fixed width; the whole text on hover
  chip.className = `chip${cls ? ` ${cls}` : ''}`;
}

// The undo/redo buttons name the step they would undo (async: the
// history is in the store).
let undoSeq = 0;
async function renderUndo() {
  const seq = ++undoSeq;
  const sid = app.sessionId();
  const [u, r] = sid ? await Promise.all([undoStep(app.store, sid), undoStep(app.store, sid, true)]) : [null, null];
  if (seq !== undoSeq) return;
  for (const [b, step, key] of [[$('#btn-undo'), u, 'undo.buttonLabel'], [$('#btn-redo'), r, 'undo.redoLabel']]) {
    b.disabled = !step || app.readOnly;
    b.hidden = !sid;
    const label = step ? t(key, { what: t(step.label) }) : t(key === 'undo.buttonLabel' ? 'undo.button' : 'undo.redoButton');
    setAttr(b, 'aria-label', label);
    b.title = label;
  }
}

// Undo (or redo) the last step of this session: refused, with nothing
// changed, when a record it touched was changed since.
app.undo = async (redo = false) => {
  if (!app.s || app.readOnly) return false;
  await app.flush();
  const step = await app.act(store => undo(store, { sessionId: app.s.id, tab: app.tab, redo }));
  if (step) app.announce(t(redo ? 'undo.redone' : 'undo.undone', { what: t(step.label) }));
  else if (step === null) app.announce(t(redo ? 'undo.nothingRedo' : 'undo.nothing'));
  return !!step;
};

function renderKeysLine() {
  const v = app.ui.view;
  setText($('#keys-line'), t(v === 'live' ? 'keysLine.live' : v === 'turn' ? 'keysLine.turn' : v === 'log' ? 'keysLine.log' : 'keysLine.other'));
}

function renderMode(mode) {
  const n = $('#mode-indicator');
  setText(n, t(mode === 'edit' ? 'mode.edit' : 'mode.nav'));
  n.classList.toggle('editing', mode === 'edit');
}

// ---------- keyboard ----------

// The rows j/k move through: in Live Notes the notes when the focus is in
// them, else the roster; in My Turn the checklist and the summary notes.
// The list j/k move through follows the focus: inside My Turn its items,
// inside the log or a station's notes their rows, everywhere else the
// roster (so the stations can always be switched).
function navList() {
  const a = document.activeElement;
  const inside = sel => a && a.closest && a.closest(sel);
  if (inside('#view-turn')) return turnRows();
  if (inside('#view-log')) return logRows();
  if (inside('#station-rounds')) return [...$('#station-rounds').querySelectorAll('.round-body:not([hidden]) li.note')];
  // every station, the skipped ones too (a brings them back)
  return [...$('#roster').querySelectorAll('button.person')];
}

function moveFocus(dir) {
  const list = navList();
  if (!list.length) return false;
  const i = list.indexOf(document.activeElement);
  const cur = i >= 0 ? i : list.findIndex(b => b.getAttribute('aria-current') === 'true');
  // past the last one: the first again, and the other way round
  const n = list.length;
  const next = list[cur < 0 ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n];
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
  return true;
}

// The note a command acts on: the focused note row (Live Notes) or summary
// note (My Turn).
function focusedNoteId() {
  const a = document.activeElement;
  const li = a && a.closest && a.closest('li.note, li.sum-note');
  if (li) return li.dataset.key;
  const ti = a && a.closest && a.closest('#turn-items > li');
  if (ti) { const it = app.sd.items.find(i => i.id === ti.dataset.key); return it && it.noteId; }
  return null;
}

// Enter on a row that is not a button: edit the note, open the source.
function openFocused() {
  const a = document.activeElement;
  if (!a || !a.closest) return false;
  const note = a.closest('li.note');
  if (note && a === note) { note.querySelector('textarea.note-text')?.focus(); return true; }
  const ti = a.closest('#turn-items > li');
  if (ti && a === ti) {
    const it = app.sd.items.find(i => i.id === ti.dataset.key);
    if (it && it.noteId) app.openSource(it.id); else ti.querySelector('textarea')?.focus();
    return true;
  }
  const sn = a.closest('li.sum-note');
  if (sn && a === sn) {
    const n = app.sd.notes.find(x => x.id === sn.dataset.key);
    if (n) app.openFrom(n.participantId, { noteId: n.id, field: 'row' });
    return true;
  }
  return false;
}

function initKeyboard(help) {
  loadEditBindings();
  initKeys({
    onMode: m => renderMode(m),
    commands: {
      next: ev => (ev.target.closest('select, [role=radiogroup]') ? false : (app.s && !$('#sidebar').hidden ? moveFocus(1) : false)),
      prev: ev => (ev.target.closest('select, [role=radiogroup]') ? false : (app.s && !$('#sidebar').hidden ? moveFocus(-1) : false)),
      open: () => openFocused(),
      help: () => { help.open(); return true; },
      newNote: () => {
        if (!app.s || app.readOnly) return false;
        if (!app.ui.selected) { $('#checkin-call').focus(); return true; }
        app.openStation(app.ui.selected).then(() => focusNoteEditor(app));
        return true;
      },
      // i: into the note field of the selected station (vim insert)
      insert: () => {
        if (!app.s || app.readOnly || app.ui.view !== 'live' || !app.ui.selected) return false;
        return focusNoteEditor(app);
      },
      // , one station back in the net order (navigation only)
      prevSpeaker: () => stepSelection(-1),
      stActive: () => setSelectedStatus('active'),
      stPaused: () => setSelectedStatus('paused'),
      stListening: () => setSelectedStatus('listening'),
      flag: () => {
        const id = focusedNoteId();
        if (!id || app.readOnly) return false;
        flagNote(app, id);
        return true;
      },
      myTurn: () => {
        if (!app.s) return false;
        if (app.ui.view !== 'turn') { app.nav.push(); app.setView('turn'); }
        return true;
      },
      // the next speaker in the net (j/k only move in the list)
      // on the station that is on air (or when nobody is): hand over; on
      // any other station: only move the selection one forward
      nextSpeaker: () => {
        if (!app.s || $('#sidebar').hidden) return false;
        const st = speakingState({ session: app.s, participants: app.sd.participants, contributions: app.sd.contributions });
        const sel = app.ui.selected;
        if (!st.free && st.onAir && sel && st.onAir.id !== sel && app.participant(sel) && ['active', 'unconfirmed'].includes(app.participant(sel).status)) return stepSelection(1);
        if (app.readOnly || $('#btn-next').disabled) return false;
        nextSpeaker(app);
        return true;
      },
      complete: () => {
        if (app.ui.view !== 'turn' || app.readOnly) return false;
        const id = focusedTurnItem();
        if (!id) return false;
        completeItem(app, id, null);
        return true;
      },
      back: () => { app.back(app.ui.view === 'turn' ? 'live' : null); return true; },
      search: () => { app.openSearch(); return true; },
      // Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z (or Ctrl+Y) redo, outside text fields
      modified: ev => {
        const k = ev.key.toLowerCase();
        if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && k === 'z') { app.undo(ev.shiftKey); return true; }
        if (ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey && k === 'y') { app.undo(true); return true; }
        return false;
      },
      escape: () => false,
      // Esc in a field: leave editing, the input stays (drafts)
      leaveEditing: ev => {
        const f = ev.target;
        // forms with their own Esc (cancel) stop the event before this
        f.blur();
        if (!$('#sidebar').hidden) {
          const id = app.ui.selected || (rosterRows(app)[0] || {}).id;
          if (id) focusRosterRow(id);
        }
        return true;
      },
    },
    edit: {
      // in a note: toggle its on-air flag; in the composer: save the next
      // note flagged
      flag: ev => {
        const ta = ev.target;
        const li = ta.closest && ta.closest('li.note');
        if (li && !app.readOnly) { flagNote(app, li.dataset.key); return true; }
        if (ta.classList && ta.classList.contains('composer-text')) {
          app.ui.composeFlag = !app.ui.composeFlag;
          renderNotes(app);
          app.announce(t(app.ui.composeFlag ? 'note.willFlag' : 'note.willNotFlag'));
          return true;
        }
        return false;
      },
    },
  });
}
registerEditCommand('flag', 'Ctrl+Shift+Enter', 'keys.flagEdit');

// ---------- saving before leaving / updating ----------

// Commit what is being typed (detail fields; later the note editors).
// Resolves true when nothing typed is at risk.
app.flushers = [() => flushDetails(app), () => app.drafts.flush()];
app.flush = async () => {
  let ok = true;
  for (const f of app.flushers) {
    try {
      if ((await f()) !== true) ok = false;
    } catch (e) {
      console.error(e);
      ok = false;
    }
  }
  return ok;
};

async function beforeReload() {
  if (!saveState.state.durable) {
    return { message: t('update.memory'), discards: t('update.memoryDiscards'), actions: [{ label: t('data.exportAll'), run: async () => (await exportBackup(app)) || false }] };
  }
  const ok = await app.flush();
  if (ok && !saveState.state.failed) return true;
  return { message: t('update.unsaved') };
}

// ---------- start ----------

function initHeader() {
  $('#lang-toggle').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-lang]');
    if (!b) return;
    const before = offlineStrings();
    setLang(b.dataset.lang);
    applyI18n(document);
    retranslateOffline(before);
    for (const fn of app.langHooks) fn();
    tick();
    render();
    renderMode(isEditableActive() ? 'edit' : 'nav');
    b.focus();
    app.announce(t('header.langChanged'));
  });
  $('#time-toggle').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-time]');
    if (!b) return;
    setTimeMode(b.dataset.time);
    render();
    b.focus();
    app.announce(t('header.timeChanged', { zone: zone() }));
  });
  tick();
  setInterval(tick, 5000);
}
// The header clock in the chosen mode, with its zone.
function tick() {
  const now = new Date().toISOString();
  setText($('#clock-utc'), hm(now));
  setText($('#clock-zone'), zone(now));
  setAttr($('#clock'), 'aria-label', t('header.clockLabel', { zone: zone(now) }));
  // the switch names the device's zone and its offset now
  const local = $('#time-toggle button[data-time=local]');
  const text = localChoiceText(t('header.local'), now);
  setText(local, text);
  setAttr(local, 'aria-label', t('header.localLabel', { zone: text }));
}

const isEditableActive = () => {
  const a = document.activeElement;
  return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && a.type !== 'checkbox'));
};

async function initPersistence() {
  const chip = $('#st-storage');
  if (app.store.kind === 'memory') {
    setText(chip, t('storage.memory'));
    chip.className = 'chip err';
    return;
  }
  const r = await requestPersistence();
  setText(chip, t(r === 'persisted' ? 'storage.persisted' : 'storage.notPersisted'));
  chip.className = `chip ${r === 'persisted' ? 'ok' : 'warn'}`;
  chip.title = t(r === 'persisted' ? 'storage.persistedTitle' : 'storage.notPersistedTitle');
}

function initChannel() {
  if (!globalThis.BroadcastChannel) return null;
  const ch = new BroadcastChannel(CHANNEL_NAME);
  ch.addEventListener('message', ev => {
    const d = ev.data || {};
    if (d.tab === app.tab) return;
    lock.onMessage(d);
    if (d.type === 'changed') reload().catch(e => console.warn(e));
  });
  return ch;
}

async function main() {
  globalThis.NETLOG_STARTED = true;
  initLang();
  applyI18n(document);
  // the chips' first text, in the page's language (later ones come from
  // offline.js and initPersistence())
  setText($('#st-offline'), t('offline.checking'));
  setText($('#st-storage'), t('storage.checking'));
  document.body.append(el('div', { id: 'announce', class: 'sr-only', 'aria-live': 'polite' }));
  let unavailable = null;
  app.store = await openStorageWithNotices(openNetlogStorage, $('#banner'), {
    blocked: t('storage.blocked'), closed: t('storage.closed'), reload: t('common.reload'),
  }, { onUnavailable: e => { unavailable = e; } });
  if (!app.store) {
    // no IndexedDB: work in memory, and say so everywhere
    app.store = memoryStore(NETLOG_STORES);
    saveState.set('durable', false);
    const b = $('#storage-banner');
    // a newer Netlog changed the database: it is left alone (not opened,
    // not replaced), and this version says so
    const newer = unavailable && unavailable.name === 'VersionError';
    fill(b, t(newer ? 'storage.newerVersion' : 'storage.unavailable', { reason: String((unavailable && (unavailable.message || unavailable.name)) || '') }), ' ',
      el('button', { type: 'button', id: 'btn-memory-export', onclick: () => exportBackup(app) }, t('data.exportAll')));
    b.className = 'banner err';
    b.hidden = false;
  }
  setText($('#st-backend'), app.store.kind === 'memory' ? t('storage.memoryShort') : 'IndexedDB');
  channel = initChannel();
  lock = createSessionLock({ store: app.store, tab: app.tab, channel, onChange: (ro, reason) => setReadOnly(ro, reason) });
  $('#btn-edit-here').addEventListener('click', async () => {
    if (!app.s) return;
    const ok = await lock.acquire(app.s.id, true);
    if (ok) { app.hideBanner(); await reload(); app.announce(t('lock.nowWriting')); }
  });
  initHeader();
  trackOnline();
  initRoster(app);
  initSessions(app);
  initControl(app);
  initNotes(app);
  initTurn(app);
  initLog(app);
  initSpeak(app);
  initSearch(app);
  initHistory(app);
  initData(app);
  $('#btn-undo').addEventListener('click', () => app.undo(false));
  $('#st-backup').addEventListener('click', () => { if (app.s) exportBackup(app, app.s.id); });
  $('#btn-redo').addEventListener('click', () => app.undo(true));
  const help = initHelp(app);
  initKeyboard(help);
  globalThis.addEventListener('hashchange', () => route().catch(e => console.error(e)));
  globalThis.addEventListener('pagehide', () => { app.flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') app.flush(); });
  initPersistence().catch(e => console.warn(e));
  initOffline({
    build: globalThis.NETLOG_BUILD,
    beforeReload,
    strings: offlineStrings(),
    fileHidden: ['#offline-file-link', '#offline-card', '#home-link'],
  });
  fill($('#st-source'), ' · ', repoLink(t('footer.source'), 'tools/netlog'));
  loadCallbook();
  loadRepeaterIndex(); // ready before the first search
  await loadGlobal();
  await route();
  // everything is wired: the browser tests (and nothing else) wait for this
  globalThis.NETLOG_READY = true;
}

// The callsign lookup (shared callsign service): the Austrian list (shared
// data, offline, precached) and the user's own lists. Fills name and QTH at
// check-in and suggests callsigns.
async function loadCallbook() {
  app.calls = null;
  const done = initCallsigns(app);
  app.calls.onChange(renderCallbookSource);
  await done;
}
function renderCallbookSource() {
  const book = app.calls && app.calls.callbook();
  const src = DATA_SOURCES.callsigns;
  fill($('#st-callbook'), book
    ? [t('footer.callbook', { n: book.calls.length, stand: book.stand || '?' }), ' (', extLink(src.url, t('footer.callbookSource')), ')']
    : t('footer.noCallbook'));
}
app.onLang(() => renderCallbookSource());

// The offline/update chips show a text of the old language: the same
// message in the new one.
function retranslateOffline(before) {
  const now = offlineStrings();
  setOfflineText(now);
  for (const id of ['#st-offline', '#st-update', '#btn-update']) {
    const n = $(id);
    if (!n) continue;
    const k = Object.keys(before).find(key => typeof before[key] === 'string' && before[key] === n.textContent);
    if (k) n.textContent = now[k];
    const tk = Object.keys(before).find(key => typeof before[key] === 'string' && n.title && before[key] === n.title);
    if (tk) n.title = now[tk];
  }
}

// The shared update/offline texts in the current language (offline.js).
function offlineStrings() {
  const keys = ['ready', 'incomplete', 'incompleteTitle', 'dev', 'devTitle', 'broken', 'brokenTitle', 'noAnswer', 'file', 'unsupported',
    'setupFailed', 'setupFailedTitle', 'loading', 'repairing', 'newer', 'repairFailed', 'updateFailed', 'updateFailedTitle', 'checkFailed',
    'checkFailedTitle', 'copyLabel', 'actionFailed', 'update', 'updateReady', 'useNow', 'later', 'reload', 'saveFailed', 'keepInput', 'retry', 'anyway', 'discardsDefault',
    'waiting', 'reloadIntro', 'updateIntro', 'oldRemoved', 'ok'];
  const out = Object.fromEntries(keys.map(k => [k, t(`offline.${k}`)]));
  out.notDone = what => t('offline.notDone', { what });
  out.anywayConfirm = discards => t('offline.anywayConfirm', { discards });
  return out;
}

main().catch(e => {
  console.error(e);
  showBanner(t('app.startFailed', { error: String((e && e.message) || e) }));
});
