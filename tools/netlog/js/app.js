// Netlog: page controller. Loads the data, routes (#/ = sessions & series,
// #/s/<session>/<view>), renders the workspaces and runs every change
// through ops.js (one transaction each), the save chip following the
// commit. Design and data model: ../README.md.

import { $, el, fill } from '../../shared/js/dom.js';
import { initOffline, setOfflineText } from '../../shared/js/offline.js';
import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { openStorageWithNotices } from '../../shared/js/storageui.js';
import { requestPersistence, StorageClosedError } from '../../shared/js/storage.js';
import { repoLink, trackOnline } from '../../shared/js/sources.js';
import { newId } from '../../shared/js/time.js';
import { t, initLang, setLang, lang, applyI18n } from './i18n.js';
import { openNetlogStorage, NETLOG_STORES, SESSION_STORES } from './db.js';
import { memoryStore } from './memstore.js';
import { LeaseError, UndoConflictError } from './ops.js';
import { createSessionLock, CHANNEL_NAME } from './lock.js';
import { createSaveState } from './status.js';
import { setText, setAttr } from './keyed.js';
import { sessionLabel, live, rosterSorted, isUnresolved } from './model.js';
import { initRoster, renderRoster, renderStation, flushDetails, callText, rosterRows } from './roster.js';
import { initSessions, renderSessions } from './sessions.js';
import { initControl, renderControl } from './control.js';
import { initKeys, loadEditBindings } from './keys.js';
import { initHelp } from './help.js';

const VIEWS = ['live', 'control', 'series'];
const UI_PREF = 'oe1ebg-netlog-ui';

const app = {
  store: null,
  tab: newId(),
  readOnly: false,
  data: { series: [], sessions: [], profiles: [], knownCalls: [], participantCount: {} },
  s: null, // the open session
  sd: { participants: [], rounds: [] },
  ui: { view: 'series', selected: null, detailsOpen: false },
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

function handleWriteError(e, quiet) {
  console.error(e);
  if (e instanceof LeaseError) {
    setReadOnly(true, 'taken');
    showBanner(t('lock.lostWrite'), 'warn');
    return;
  }
  if (e instanceof UndoConflictError) {
    app.announce(t('undo.conflict'));
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
  const [series, sessions, profiles, participants] = await Promise.all(
    ['series', 'sessions', 'profiles', 'participants'].map(s => app.store.getAll(s)));
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
  app.ui.view = app.s ? view : 'series';
  render();
  saveUi();
}

async function openSession(id) {
  lock.release();
  app.s = null;
  app.sd = { participants: [], rounds: [] };
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
      app.ui.detailsOpen = !!ui.detailsOpen;
      setReadOnly(false, null);
      if (app.store.kind !== 'memory') await lock.acquire(id);
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
    renderRoster(app);
    renderStation(app);
    saveUi();
  }
  if (focus) focusRosterRow(id);
};

function focusRosterRow(id) {
  const b = $('#roster').querySelector(`li[data-key="${CSS.escape(id)}"] button.person`);
  if (b) b.focus();
}

// Open a station's notes (roster click/Enter, links from other views).
app.openStation = async id => {
  await app.flush();
  app.select(id);
  if (app.ui.view !== 'live') app.setView('live');
  $('#station-call').focus?.();
};

// Badges of a roster row / the station head: NCS, open responses, flags.
app.rowBadges = (p, long = false) => {
  const out = [];
  for (const f of ['speak', 'priority', 'short', 'reception']) {
    if (p.flags && p.flags[f]) out.push({ text: t(`flag.${f}.short`), title: t(`flag.${f}`), cls: f === 'priority' ? 'warn' : '' });
  }
  if (isUnresolved(p.call)) out.push({ text: '?', title: t('station.unresolved'), cls: 'warn' });
  if (long && p.status !== 'active') out.push({ text: t(`status.${p.status}`), title: t(`status.${p.status}`) });
  return out;
};

app.helpEditRows = () => [];

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
    a.hidden = !inSession && v !== 'series';
    setAttr(a, 'aria-current', v === view ? 'page' : null);
  }
  renderHeader();
  if (inSession) {
    renderRoster(app);
    if (view === 'live') renderStation(app);
    if (view === 'control') renderControl(app);
  }
  if (view === 'series') renderSessions(app);
  renderKeysLine();
}
app.render = render;

function renderHeader() {
  const s = app.s;
  const series = s && s.seriesId ? app.data.series.find(x => x.id === s.seriesId) : null;
  setText($('#session-line'), s ? [sessionLabel(s, series) || t('session.untitled'), s.date, s.own.call ? t('session.ownShort', { call: s.own.call }) : ''].filter(Boolean).join(' · ') : '');
  for (const b of $('#lang-toggle').querySelectorAll('button')) setAttr(b, 'aria-pressed', String(b.dataset.lang === lang()));
  const round = s && app.sd.rounds.find(r => r.id === s.currentRoundId);
  setText($('#round-indicator'), round ? t('round.indicator', { n: round.number }) : '');
  renderSaveChip();
}

function renderSaveChip() {
  const [key, vars, cls] = saveState.view();
  const chip = $('#st-save');
  setText(chip, t(key, vars));
  chip.className = `chip${cls ? ` ${cls}` : ''}`;
}

function renderKeysLine() {
  setText($('#keys-line'), t(app.ui.view === 'live' ? 'keysLine.live' : 'keysLine.other'));
}

function renderMode(mode) {
  const n = $('#mode-indicator');
  setText(n, t(mode === 'edit' ? 'mode.edit' : 'mode.nav'));
  n.classList.toggle('editing', mode === 'edit');
}

// ---------- keyboard ----------

function navList() {
  // the roster: the station rows in order
  return [...$('#roster').querySelectorAll('button.person')];
}

function moveFocus(dir) {
  const list = navList();
  if (!list.length) return false;
  const i = list.indexOf(document.activeElement);
  const cur = i >= 0 ? i : list.findIndex(b => b.getAttribute('aria-current') === 'true');
  const next = list[Math.max(0, Math.min(list.length - 1, (cur < 0 ? (dir > 0 ? -1 : list.length) : cur) + dir))];
  next.focus();
  return true;
}

function initKeyboard(help) {
  loadEditBindings();
  initKeys({
    onMode: m => renderMode(m),
    commands: {
      next: ev => (ev.target.closest('select, [role=radiogroup]') ? false : (app.s && !$('#sidebar').hidden ? moveFocus(1) : false)),
      prev: ev => (ev.target.closest('select, [role=radiogroup]') ? false : (app.s && !$('#sidebar').hidden ? moveFocus(-1) : false)),
      open: () => false,
      help: () => { help.open(); return true; },
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
    edit: {},
  });
}

// ---------- saving before leaving / updating ----------

// Commit what is being typed (detail fields; later the note editors).
// Resolves true when nothing typed is at risk.
app.flushers = [() => flushDetails(app)];
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
  if (!saveState.state.durable) return { message: t('update.memory'), discards: t('update.memoryDiscards') };
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
    render();
    renderMode(isEditableActive() ? 'edit' : 'nav');
    b.focus();
    app.announce(t('header.langChanged'));
  });
  const tick = () => setText($('#clock-utc'), new Date().toISOString().slice(11, 16));
  tick();
  setInterval(tick, 5000);
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
    setText(b, t('storage.unavailable', { reason: String((unavailable && (unavailable.message || unavailable.name)) || '') }));
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
  });
  fill($('#st-source'), ' · ', repoLink(t('footer.source'), 'tools/netlog'));
  await loadGlobal();
  await route();
  // everything is wired: the browser tests (and nothing else) wait for this
  globalThis.NETLOG_READY = true;
}

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
    'checkFailedTitle', 'copyLabel', 'actionFailed', 'update', 'reload', 'saveFailed', 'keepInput', 'retry', 'anyway', 'discardsDefault',
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
