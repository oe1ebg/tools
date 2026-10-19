// Callsign lists in "Backup and data": the shared callsign store
// (shared/js/callsign-store.js) in Netlog. Import a PoLo-notes or CSV file
// as a source of its own, replace it (undoable), reorder, switch on/off
// (the Austrian list too), delete (soft) or erase. Netlog reads the merged
// view (app.data.directory) for check-in suggestions and the info line.
// Nothing here makes a request.

import { $, el } from '../../shared/js/dom.js';
import { t } from './i18n.js';
import { keyedList, setText } from './keyed.js';
import { buildCallsignDirectory, CALLSIGN_BUILTIN_ID } from '../../shared/js/callsign-merge.js';
import {
  openCallsignStorage, ensureBuiltinSource, loadCallsignStore, importCallsignSource, swapCallsignGeneration,
  setCallsignSourceEnabled, deleteCallsignSource, restoreCallsignSource, moveCallsignSource, eraseCallsignSource,
} from '../../shared/js/callsign-store.js';
import { parseCallsignFile } from '../../shared/js/callsign-import.js';

function listsSay(text, kind = '') {
  const m = $('#lists-msg');
  m.className = `data-msg ${kind}`;
  setText(m, text);
}

// The merged directory from the stored sources and the bundled list;
// without the store (no IndexedDB) just the bundled list.
export function rebuildCallsignDirectory(app) {
  const cs = app.callsigns;
  app.data.directory = buildCallsignDirectory({
    sources: cs ? cs.sources.map(s => (s.id === CALLSIGN_BUILTIN_ID ? { ...s, name: t('lists.builtin') } : s))
      : [{ id: CALLSIGN_BUILTIN_ID, kind: 'builtin', name: t('lists.builtin'), enabled: true, rank: 1000, gen: 1 }],
    records: cs ? cs.records : [],
    callbook: app.data.callbook,
  });
  if (app.onCallbook) app.onCallbook();
}

async function listsReload(app) {
  Object.assign(app.callsigns, await loadCallsignStore(app.callsigns.store));
  rebuildCallsignDirectory(app);
  renderLists(app);
}

// Opens the store; failing is not fatal (the bundled list keeps working).
export async function initCallsigns(app) {
  try {
    const store = await openCallsignStorage();
    if (!store) throw new Error('no IndexedDB');
    await ensureBuiltinSource(store, t('lists.builtin'));
    app.callsigns = { store, ...(await loadCallsignStore(store)) };
  } catch (e) {
    console.warn('Rufzeichenlisten nicht verfügbar', e);
    app.callsigns = null;
  }
  rebuildCallsignDirectory(app);
  renderLists(app);
}

const listsDateOf = iso => (iso ? String(iso).slice(0, 10) : '');
const listsSourceName = s => (s.id === CALLSIGN_BUILTIN_ID ? t('lists.builtin') : s.name);

async function listsImportInto(app, file, replaceId = null) {
  if (!file) return;
  if (!app.callsigns) { listsSay(t('lists.unavailable'), 'err'); return; }
  const parsed = parseCallsignFile(file.name, await file.text());
  if (parsed.error) { listsSay(t(`lists.${parsed.error}`), 'err'); return; }
  if (!parsed.rows.length) { listsSay(t('lists.empty', { name: file.name }), 'err'); return; }
  const base = file.name.replace(/\.[^.]+$/, '');
  const name = parsed.title || base;
  try {
    const src = await importCallsignSource(app.callsigns.store, { kind: parsed.kind, name, fileName: file.name, rows: parsed.rows, replaceId });
    await listsReload(app);
    const skipped = Object.values(parsed.skipped || {}).reduce((a, b) => a + b, 0);
    listsSay(t(replaceId ? 'lists.replaced' : 'lists.imported', { name: src.name, n: parsed.rows.length, skipped }), 'ok');
  } catch (e) {
    console.warn(e);
    listsSay(t('lists.failed', { error: String(e.message || e) }), 'err');
  }
}

export function initCallsignLists(app) {
  const file = $('#list-file');
  let replaceId = null;
  $('#btn-list-import').addEventListener('click', () => { replaceId = null; file.click(); });
  file.addEventListener('change', async ev => {
    const f = ev.target.files[0];
    ev.target.value = '';
    const id = replaceId;
    replaceId = null;
    await listsImportInto(app, f, id);
  });
  const list = $('#lists-list');
  list.addEventListener('change', async ev => {
    const box = ev.target.closest('input[data-act=enable]');
    if (!box || !app.callsigns) return;
    await setCallsignSourceEnabled(app.callsigns.store, box.dataset.id, box.checked);
    await listsReload(app);
  });
  list.addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b || !app.callsigns) return;
    const id = b.dataset.id;
    const s = app.callsigns.sources.find(x => x.id === id);
    if (!s) return;
    const store = app.callsigns.store;
    const act = b.dataset.act;
    try {
      if (act === 'up' || act === 'down') {
        await moveCallsignSource(store, id, act === 'up' ? -1 : 1);
        await listsReload(app);
        const again = list.querySelector(`button[data-act=${act}][data-id="${CSS.escape(id)}"]`);
        if (again && !again.disabled) again.focus();
        return;
      }
      if (act === 'replace') { replaceId = id; file.click(); return; }
      if (act === 'undo') {
        await swapCallsignGeneration(store, id);
        await listsReload(app);
        listsSay(t('lists.undone', { name: listsSourceName(s) }), 'ok');
        return;
      }
      if (act === 'delete') {
        await deleteCallsignSource(store, id);
        await listsReload(app);
        listsSay(t('lists.deleted', { name: listsSourceName(s) }), 'ok');
        return;
      }
      if (act === 'restore') {
        await restoreCallsignSource(store, id);
        await listsReload(app);
        listsSay(t('lists.restored', { name: listsSourceName(s) }), 'ok');
        return;
      }
      if (act === 'erase') {
        if (!globalThis.confirm(t('lists.eraseConfirm', { name: listsSourceName(s) }))) return;
        await eraseCallsignSource(store, id);
        await listsReload(app);
        listsSay(t('lists.erased', { name: listsSourceName(s) }), 'ok');
      }
    } catch (e) {
      console.warn(e);
      listsSay(t('lists.failed', { error: String(e.message || e) }), 'err');
    }
  });
}

function listsButton(act, extra = '') {
  return el('button', { type: 'button', class: `mini${extra}`, 'data-act': act });
}

export function renderLists(app) {
  const cs = app.callsigns;
  const list = $('#lists-list');
  $('#btn-list-import').disabled = !cs;
  if (!cs) {
    keyedList(list, [], { key: s => s.id, create: () => el('li'), update: () => {} });
    list.append(el('li', { class: 'hint', 'data-key': '' }, t('lists.unavailable')));
    return;
  }
  const sorted = cs.sources.slice().sort((a, b) => (a.deleted - b.deleted) || (a.rank - b.rank));
  const visible = sorted.filter(s => !s.deleted);
  keyedList(list, sorted, {
    key: s => s.id,
    create: () => el('li', { class: 'profile-row list-row' },
      el('label', { class: 'list-name' }, el('input', { type: 'checkbox', 'data-act': 'enable' }), ' ', el('span')),
      ' ', el('small', { class: 'list-meta' }), ' ',
      listsButton('up'), ' ', listsButton('down'), ' ', listsButton('replace'), ' ', listsButton('undo'), ' ',
      listsButton('delete', ' danger'), listsButton('restore'), ' ', listsButton('erase', ' danger')),
    update: (li, s) => {
      const builtin = s.id === CALLSIGN_BUILTIN_ID;
      const box = li.querySelector('input');
      box.dataset.id = s.id;
      box.checked = s.enabled !== false;
      box.disabled = !!s.deleted;
      setText(li.querySelector('.list-name span'), listsSourceName(s));
      const meta = builtin ? t('lists.builtinMeta') : t('lists.meta', { n: s.count, date: listsDateOf(s.importedAt), kind: t(`lists.kind.${s.kind}`) });
      setText(li.querySelector('.list-meta'), s.deleted ? `${meta} · ${t('lists.isDeleted')}` : meta);
      const idx = visible.indexOf(s);
      const show = (act, on, label, aria) => {
        const b = li.querySelector(`button[data-act=${act}]`);
        b.hidden = !on;
        b.dataset.id = s.id;
        setText(b, label);
        b.setAttribute('aria-label', `${aria} – ${listsSourceName(s)}`);
        return b;
      };
      show('up', !s.deleted, '↑', t('lists.up')).disabled = idx <= 0;
      show('down', !s.deleted, '↓', t('lists.down')).disabled = idx < 0 || idx >= visible.length - 1;
      show('replace', !s.deleted && !builtin, t('lists.replace'), t('lists.replaceLabel'));
      show('undo', !s.deleted && !builtin && s.prevGen != null, t('lists.undo'), t('lists.undoLabel'));
      show('delete', !s.deleted && !builtin, t('common.delete'), t('lists.deleteLabel'));
      show('restore', !!s.deleted, t('common.restore'), t('lists.restoreLabel'));
      show('erase', !!s.deleted && !builtin, t('lists.erase'), t('lists.eraseLabel'));
    },
  });
}
