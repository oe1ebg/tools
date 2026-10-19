// Wavelog import page: the only place of the tools that talks to a Wavelog
// instance. Nothing is stored here but QSOs and their per-callsign summary
// in the shared callsign store; the token lives in the input field only.
// Every request is made by wavelog.js (AGENTS.md, "API call inventory").

import { $, el, fill } from '../../shared/js/dom.js';
import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { tx, uiLang, i18nInit, i18nApply, i18nToggle } from '../../shared/js/i18n.js';
import { createCallsignLists } from '../../shared/js/callsignlists.js';
import { callsignQsoFromWavelog, summarizeCallsignQsos } from '../../shared/js/callsign-qsos.js';
import {
  openCallsignStorage, ensureBuiltinSource, loadCallsignStore, upsertCallsignQsos, loadCallsignQsos,
  writeCallsignSummary, eraseCallsignSource,
} from '../../shared/js/callsign-store.js';
import { wavelogBase, wavelogLogbooks, wavelogTokenScopes, wavelogQsos, WavelogError } from './wavelog.js';

const LANG_PREF = 'oe1ebg-wavelog-import-lang';
// The address Netlog already keeps for its Wavelog link (a stable key).
const URL_PREF = 'oe1ebg-netlog-wavelog';

let storage = null;
let logbooks = [];
let base = '';
let running = null;   // AbortController of the import in progress
// the shared dialog of the lists (order, switches, erase), as in every tool
const lists = createCallsignLists({ getLang: uiLang });

i18nInit(LANG_PREF);

const status = (text, kind = '') => {
  const m = $('#wl-status');
  m.className = `status ${kind}`;
  m.textContent = text;
};

const fieldError = (id, text) => {
  $(`#${id}`).textContent = text;
  const input = $(id === 'wl-url-err' ? '#wl-url' : '#wl-token');
  if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
};

function errorText(e) {
  let code = e instanceof WavelogError ? e.code : 'network';
  if (e instanceof WavelogError && e.status === 401) code = 'http-401';
  switch (code) {
    case 'insufficient_scope': return tx(`The token lacks the scope ${e.required || ''}. Create a v2 token with logbook:read and qso:read.`, `Dem Token fehlt das Recht ${e.required || ''}. Ein v2-Token mit logbook:read und qso:read anlegen.`);
    case 'http-401': case 'http-403': case 'unauthorized': case 'invalid_token': case 'token_expired':
      return tx('Wavelog refused the token (wrong, expired or not a v2 token wl2_…). Create a new one.', 'Wavelog hat das Token abgelehnt (falsch, abgelaufen oder kein v2-Token wl2_…). Ein neues anlegen.');
    case 'http-404': return tx('No Wavelog API found at this address. Is it the instance address, and Wavelog 3.1.0 or later?', 'Unter dieser Adresse gibt es keine Wavelog-API. Stimmt die Adresse, und ist es Wavelog ab 3.1.0?');
    case 'rate_limited': case 'http-429': return tx('Wavelog limits the requests. Wait a moment and try again.', 'Wavelog begrenzt die Abfragen. Kurz warten und noch einmal versuchen.');
    case 'timeout': return tx('Wavelog did not answer in time.', 'Wavelog hat nicht rechtzeitig geantwortet.');
    case 'bad-response': return tx('That answer is not from the Wavelog API.', 'Diese Antwort stammt nicht von der Wavelog-API.');
    case 'too-many-pages': return tx('Too many QSOs for one import (limit 2 million).', 'Zu viele QSOs für einen Import (höchstens 2 Millionen).');
    case 'network': return tx('No connection to Wavelog. Check the address, your internet, and that the instance allows cross-origin requests (CORS) and uses https.', 'Keine Verbindung zu Wavelog. Adresse und Internet prüfen; die Instanz muss https verwenden und Anfragen von anderen Seiten (CORS) erlauben.');
    default: return tx(`Wavelog answered with an error (${code}).`, `Wavelog meldet einen Fehler (${code}).`);
  }
}

const sourceId = (b, logbookId) => `wavelog:${b.replace(/^https?:\/\//, '').replace(/\/$/, '')}:${logbookId}`;

async function renderSources() {
  const list = $('#wl-sources');
  if (!storage) {
    fill(list, el('li', { class: 'hint' }, tx('The callsign store needs IndexedDB, which this browser does not offer.', 'Der Rufzeichen-Speicher braucht IndexedDB, das dieser Browser nicht bietet.')));
    return;
  }
  const { sources } = await loadCallsignStore(storage);
  const mine = sources.filter(s => s.kind === 'wavelog' && !s.deleted);
  if (!mine.length) { fill(list, el('li', { class: 'hint' }, tx('Nothing imported yet.', 'Noch nichts importiert.'))); return; }
  fill(list, ...mine.map(s => el('li', { class: 'profile-row src-row' },
    el('b', {}, s.name), el('small', {}, tx(`${s.count} callsigns · ${String(s.importedAt || '').slice(0, 10)}`, `${s.count} Rufzeichen · ${String(s.importedAt || '').slice(0, 10)}`)),
    el('button', {
      type: 'button', class: 'mini danger', 'data-erase': s.id,
      'aria-label': tx(`Erase ${s.name} permanently`, `${s.name} endgültig löschen`),
    }, tx('Erase permanently', 'Endgültig löschen')))));
}

async function loadLogbooks(ev) {
  ev.preventDefault();
  fieldError('wl-url-err', '');
  fieldError('wl-token-err', '');
  const b = wavelogBase($('#wl-url').value);
  if (!b) { fieldError('wl-url-err', tx('That is no usable address (https://…, http:// only for localhost, no user name or password).', 'Das ist keine brauchbare Adresse (https://…, http:// nur für localhost, ohne Benutzername oder Passwort).')); $('#wl-url').focus(); return; }
  const token = $('#wl-token').value.trim();
  if (!token) { fieldError('wl-token-err', tx('Enter the API token.', 'Das API-Token eintragen.')); $('#wl-token').focus(); return; }
  prefSet(URL_PREF, b);
  $('#btn-logbooks').disabled = true;
  status(tx('Loading logbooks…', 'Logbücher werden geladen…'));
  try {
    logbooks = await wavelogLogbooks(b, { token });
    base = b;
    const scopes = await wavelogTokenScopes(b, { token });
    if (!logbooks.length) { status(tx('This Wavelog has no logbook.', 'Dieses Wavelog hat kein Logbuch.'), 'err'); $('#import-card').hidden = true; return; }
    fill($('#wl-logbook'), ...logbooks.map(l => el('option', { value: String(l.id) }, l.name)));
    $('#import-card').hidden = false;
    showStations();
    const missing = scopes ? ['qso:read', 'logbook:read'].filter(s => !scopes.includes(s)) : [];
    status(missing.length
      ? tx(`Logbooks loaded, but the token lacks ${missing.join(', ')}.`, `Logbücher geladen, aber dem Token fehlt ${missing.join(', ')}.`)
      : tx(`${logbooks.length} logbook(s) found.`, `${logbooks.length} Logbuch/Logbücher gefunden.`), missing.length ? 'err' : 'ok');
    $('#wl-logbook').focus();
  } catch (e) {
    $('#import-card').hidden = true;
    if (e instanceof WavelogError && (e.status === 401 || e.status === 403)) fieldError('wl-token-err', errorText(e));
    else if (e instanceof WavelogError && e.status === 404) fieldError('wl-url-err', errorText(e));
    else status(errorText(e), 'err');
  } finally {
    $('#btn-logbooks').disabled = false;
  }
}

const selected = () => logbooks.find(l => String(l.id) === $('#wl-logbook').value);

function showStations() {
  const l = selected();
  $('#wl-stations').textContent = l ? tx(`Station locations: ${l.stationIds.join(', ') || '–'}`, `Stationsstandorte: ${l.stationIds.join(', ') || '–'}`) : '';
}

function setRunning(on) {
  $('#btn-import').disabled = on;
  $('#btn-logbooks').disabled = on;
  $('#btn-cancel').hidden = !on;
  $('#wl-progress').hidden = !on;
  $('#wl-logbook').disabled = on;
}

async function runImport() {
  const l = selected();
  if (!l) return;
  if (!storage) { status(tx('The callsign store needs IndexedDB, which this browser does not offer.', 'Der Rufzeichen-Speicher braucht IndexedDB, das dieser Browser nicht bietet.'), 'err'); return; }
  if (!l.stationIds.length) { status(tx('This logbook has no station location.', 'Dieses Logbuch hat keinen Stationsstandort.'), 'err'); return; }
  const token = $('#wl-token').value.trim();
  const sid = sourceId(base, l.id);
  const name = `Wavelog ${base.replace(/^https?:\/\//, '').replace(/\/$/, '')} – ${l.name}`;
  running = new AbortController();
  setRunning(true);
  const bar = $('#wl-progress');
  bar.removeAttribute('value');
  let stored = 0;
  let failure = null;
  try {
    await wavelogQsos(base, l.stationIds, {
      token,
      signal: running.signal,
      onWait: s => status(tx(`Wavelog asks to wait ${s} s…`, `Wavelog bittet um ${s} s Wartezeit…`)),
      onPage: async (qsos, meta) => {
        const rows = qsos.map(q => callsignQsoFromWavelog(q, sid)).filter(Boolean);
        await upsertCallsignQsos(storage, rows);
        stored += rows.length;
        bar.max = Math.max(meta.total, 1);
        bar.value = Math.min(stored, bar.max);
        status(tx(`${stored} of ${meta.total} QSOs stored…`, `${stored} von ${meta.total} QSOs gespeichert…`));
      },
    });
  } catch (e) {
    failure = e;
  }
  // whatever was stored is summarised, so the lookup matches the QSOs
  let count = 0;
  try {
    const all = await loadCallsignQsos(storage, sid);
    if (all.length) {
      const src = await writeCallsignSummary(storage, { sourceId: sid, name, rows: summarizeCallsignQsos(all) });
      count = src.count;
    }
  } catch (e) {
    console.warn(e);
    failure = failure || e;
  }
  running = null;
  setRunning(false);
  if (!failure) {
    $('#wl-token').value = '';
    status(tx(`Done: ${stored} QSOs, ${count} callsigns. The token was cleared from the field.`, `Fertig: ${stored} QSOs, ${count} Rufzeichen. Das Token wurde aus dem Feld gelöscht.`), 'ok');
  } else if (failure instanceof WavelogError && failure.code === 'aborted') {
    status(tx(`Cancelled. ${stored} QSOs were stored and are in use; run the import again to complete it.`, `Abgebrochen. ${stored} QSOs sind gespeichert und in Gebrauch; den Import noch einmal starten, um ihn zu vervollständigen.`), 'err');
  } else {
    status(`${errorText(failure)} ${tx(`${stored} QSOs were stored; run the import again to complete it.`, `${stored} QSOs sind gespeichert; den Import noch einmal starten, um ihn zu vervollständigen.`)}`, 'err');
  }
  await renderSources();
  await lists.refresh();
}

async function init() {
  i18nApply();
  i18nToggle(LANG_PREF, () => { i18nApply(); showStations(); renderSources(); lists.relabel(); });
  $('#btn-lists').addEventListener('click', ev => lists.open(ev.currentTarget));
  $('#wl-url').value = String(prefGet(URL_PREF, '') || '');
  $('#conn-form').addEventListener('submit', loadLogbooks);
  // The address is also what Netlog's "Wavelog" station link opens
  // (the stored key stays oe1ebg-netlog-wavelog): saved as soon as it is
  // valid, removed when emptied.
  $('#wl-url').addEventListener('input', () => fieldError('wl-url-err', ''));
  // An error is not cleared when the field loses focus: the controls below
  // would move under the pointer and swallow the click on the button.
  $('#wl-url').addEventListener('change', () => {
    const v = $('#wl-url').value.trim();
    const b = wavelogBase(v);
    if (!v) { prefSet(URL_PREF, ''); return; }
    if (b) { prefSet(URL_PREF, b); $('#wl-url').value = b; } else fieldError('wl-url-err', tx('That is no usable address (https://…, http:// only for localhost, no user name or password).', 'Das ist keine brauchbare Adresse (https://…, http:// nur für localhost, ohne Benutzername oder Passwort).'));
  });
  $('#wl-logbook').addEventListener('change', showStations);
  $('#btn-import').addEventListener('click', runImport);
  $('#btn-cancel').addEventListener('click', () => { if (running) running.abort(); });
  $('#wl-sources').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-erase]');
    if (!b || !storage) return;
    const { sources } = await loadCallsignStore(storage);
    const s = sources.find(x => x.id === b.dataset.erase);
    if (!s || !globalThis.confirm(tx(`Erase "${s.name}" from this device for good, with all its QSOs? This cannot be undone; Wavelog is not touched.`, `„${s.name}“ mit allen QSOs endgültig von diesem Gerät löschen? Das lässt sich nicht rückgängig machen; Wavelog bleibt unberührt.`))) return;
    await eraseCallsignSource(storage, s.id);
    status(tx(`"${s.name}" erased.`, `„${s.name}“ gelöscht.`), 'ok');
    await renderSources();
    await lists.refresh();
  });
  try {
    storage = await openCallsignStorage();
    if (storage) await ensureBuiltinSource(storage, 'Österreichische Rufzeichenliste (Fernmeldebüro)');
  } catch (e) {
    console.warn(e);
    storage = null;
  }
  await lists.init();
  await renderSources();
  globalThis.WAVELOG_IMPORT_READY = true;
}

init();
