// Backup and data (Sessions & series): JSON export of everything or one
// session, import of a backup (checked as a whole first, applied in one
// transaction, copies on clashes), station profiles, the Wavelog address,
// permanent erasure. A started download is not proof that a backup was
// kept: the message says to check the file.

import { $, el, fill } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { keyedList, setText, setValue } from './keyed.js';
import { toBackup, backupText, checkBackup, BACKUP_MAX_BYTES } from './backup.js';
import { readAll, importBackup, eraseSession, eraseProfile, eraseAll, markBackup } from './ops.js';
import { liveOf, cmp, sessionLabel } from './model.js';
import { getWavelog, setWavelog } from './links.js';

// msg: where to say it (a series card's own line), else the data section.
function say(text, kind = '', msg = null) {
  const m = msg || $('#data-msg');
  m.className = `${msg ? 'card-msg ' : ''}data-msg ${kind}`;
  setText(m, text);
}

export function download(text, name, type = 'application/json;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

// File names like Confirm's: <date>_<name>_<backup>.json
function slug(text) {
  return String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// Back up everything, one series (opts.seriesId) or one session. Refused
// (nothing downloaded) beyond the restore limits.
export async function exportBackup(app, sessionId = null, { seriesId = null, msg = null } = {}) {
  await app.flush();
  let all;
  try {
    all = await readAll(app.store);
  } catch (e) {
    say(t('data.readFailed', { error: String(e.message || e) }), 'err', msg);
    return false;
  }
  const data = toBackup(all, { sessionId, seriesId });
  const r = backupText(data);
  if (r.error) {
    say(t(`data.${r.error}`, { mb: Math.round(BACKUP_MAX_BYTES / 1048576) }), 'err', msg);
    return false;
  }
  const s = sessionId ? all.sessions.find(x => x.id === sessionId) : null;
  const series = s && s.seriesId ? all.series.find(x => x.id === s.seriesId) : null;
  const ser = !s && seriesId ? all.series.find(x => x.id === seriesId) : null;
  const word = t('data.fileWord');
  const name = s ? `${s.date || stamp()}_${slug(sessionLabel(s, series)) || 'netlog'}_${word}.json`
    : ser ? `${stamp()}_${slug(ser.name) || 'serie'}_${t('data.seriesWord')}_${word}.json`
      : `${stamp()}_netlog_${word}.json`;
  download(r.text, name);
  say(t('data.exported', { name }), 'ok', msg);
  // when it was started (not that it arrived): the header chip
  try {
    await markBackup(app.store, sessionId ? [sessionId] : (data.stores.sessions || all.sessions).filter(x => !x.deleted).map(x => x.id));
    await app.reload();
  } catch (e) {
    console.warn(e);
  }
  return true;
}

// Restore a backup file. seriesId: from a series card, only a backup of
// that series is accepted (anything else is refused before any write).
export async function importFile(app, file, { seriesId = null, msg = null } = {}) {
  if (!file) return;
  if (file.size > BACKUP_MAX_BYTES) { say(t('data.tooLargeImport', { mb: Math.round(BACKUP_MAX_BYTES / 1048576) }), 'err', msg); return; }
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    say(t('data.notJson'), 'err', msg);
    return;
  }
  const chk = checkBackup(data);
  if (!chk.ok) { say(t(`data.bad.${chk.error}`, { detail: chk.detail }), 'err', msg); return; }
  if (seriesId) {
    const st = data.stores || {};
    const ok = data.scope === 'series' && data.seriesId === seriesId
      && (st.series || []).some(s => s.id === seriesId) && (st.sessions || []).every(s => s.seriesId === seriesId);
    if (!ok) { say(t('data.notThisSeries'), 'err', msg); return; }
  }
  const report = await app.act(store => importBackup(store, data, { copySuffix: t('data.copySuffix') }), { global: true });
  if (!report) { say(t('data.importFailed'), 'err', msg); return; }
  say(t('data.imported', report), 'ok', msg);
}

export function initData(app) {
  $('#btn-export-all').addEventListener('click', () => exportBackup(app));
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async ev => {
    const f = ev.target.files[0];
    ev.target.value = '';
    await importFile(app, f);
  });
  const wl = $('#wavelog-url');
  wl.value = getWavelog();
  wl.addEventListener('change', () => {
    const u = setWavelog(wl.value);
    if (wl.value.trim() && !u) { wl.setAttribute('aria-invalid', 'true'); say(t('data.wavelogBad'), 'err'); return; }
    wl.removeAttribute('aria-invalid');
    wl.value = u;
    say(u ? t('data.wavelogSaved') : t('data.wavelogCleared'), 'ok');
    app.render();
  });
  $('#profile-list').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-act=erase-profile]');
    if (!b) return;
    const p = app.data.profiles.find(x => x.id === b.dataset.id);
    if (!p || !globalThis.confirm(t('data.eraseProfileConfirm', { call: p.call }))) return;
    const r = await app.act(store => eraseProfile(store, p.id), { global: true });
    if (r) say(t('data.profileErased', { call: p.call }), 'ok');
  });
  $('#btn-erase-all').addEventListener('click', async () => {
    if (!globalThis.confirm(t('data.eraseAllConfirm'))) return;
    if (!globalThis.confirm(t('data.eraseAllConfirm2'))) return;
    const r = await app.act(store => eraseAll(store), { global: true });
    if (r) { app.go(null); say(t('data.allErased'), 'ok'); }
  });
}

// From the session list: export one session; erase a deleted one.
export async function sessionAction(app, act, id) {
  const s = app.data.sessions.find(x => x.id === id);
  if (!s) return;
  if (act === 'export') return exportBackup(app, id);
  if (act === 'erase') {
    if (!globalThis.confirm(t('data.eraseSessionConfirm', { name: sessionLabel(s, null) || s.date }))) return;
    if (app.sessionId() === id) app.go(null);
    const r = await app.act(store => eraseSession(store, id), { global: true });
    if (r) say(t('data.sessionErased'), 'ok');
  }
}

export function renderData(app) {
  const profiles = liveOf(app.data.profiles).sort((a, b) => cmp(a.call, b.call));
  keyedList($('#profile-list'), profiles, {
    key: p => p.id,
    create: () => el('li', { class: 'profile-row' }, el('span', {}), ' ', el('button', { type: 'button', class: 'mini danger', 'data-act': 'erase-profile' })),
    update: (li, p) => {
      setText(li.firstChild, [p.call, p.name, p.qth, p.locator].filter(Boolean).join(' · '));
      const b = li.lastChild;
      b.dataset.id = p.id;
      setText(b, t('data.eraseProfile'));
      b.setAttribute('aria-label', t('data.eraseProfileLabel', { call: p.call }));
    },
  });
  if (!profiles.length) fill($('#profile-list'), el('li', { class: 'hint', 'data-key': '' }, t('data.noProfiles')));
  setValue($('#wavelog-url'), getWavelog());
}
