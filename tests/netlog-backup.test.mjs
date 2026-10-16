// Netlog's JSON backup (tools/netlog/js/backup.js, ops.js importBackup)
// and permanent erasure: lossless round trip (relationships, history,
// response state and order, drafts), copies with every reference remapped
// on id clashes, invalid/unsupported/oversized files rejected before any
// write, the size limits at export. Synthetic callsigns only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../tools/netlog/js/memstore.js';
import { NETLOG_STORES } from '../tools/netlog/js/db.js';
import {
  toBackup, backupText, checkBackup, planImport, utf8Bytes, BACKUP_FORMAT, BACKUP_MAX_BYTES, BACKUP_MAX_RECORDS, BACKUP_STORES,
} from '../tools/netlog/js/backup.js';
import {
  createSeries, createSession, addParticipant, createNote, setItemText, addPoint, moveItem, setItemDone, startTurn, setNcs,
  createRound, addContribution, toggleTask, writeDraft, importBackup, readAll, eraseSession, eraseParticipant, eraseProfile,
  eraseAll, saveProfile, updateNote, undoStep,
} from '../tools/netlog/js/ops.js';

const TAB = 'tab-1';

// A session with a bit of everything.
async function sample() {
  const store = memoryStore(NETLOG_STORES);
  const series = await createSeries(store, { tab: TAB }, { name: 'Evening net' });
  const s = await createSession(store, { tab: TAB }, { seriesId: series.id, own: 'OE0QXA' });
  const ctx = { sessionId: s.id, tab: TAB };
  const a = await addParticipant(store, ctx, { call: 'OE0QXA', name: 'Mira' });
  const b = await addParticipant(store, ctx, { call: 'OE0QXB', name: 'Jonas' });
  await saveProfile(store, ctx, b.id);
  await setNcs(store, ctx, a.id);
  await addContribution(store, ctx, b.id);
  const n = await createNote(store, ctx, { participantId: b.id, text: 'Interference persists.', flagged: true });
  await updateNote(store, ctx, n.id, 'Interference persists after the change.');
  const items = await store.getByEvent('items', s.id);
  await setItemText(store, ctx, items[0].id, 'Ask about common-mode current.');
  await toggleTask(store, ctx, n.id);
  await addPoint(store, ctx, 'Mention the portable test.');
  await moveItem(store, ctx, items[0].id, 1);
  await startTurn(store, ctx);
  await setItemDone(store, ctx, items[0].id, true);
  await createRound(store, ctx, { topic: 'antennas' });
  await writeDraft(store, ctx, `new:${b.id}`, { text: 'half typed', selStart: 4, selEnd: 4 });
  return { store, s, ctx, a, b, n, series };
}

const strip = all => Object.fromEntries(BACKUP_STORES.map(s => [s, [...all[s]].sort((x, y) => (x.id < y.id ? -1 : 1))]));

test('round trip: everything comes back exactly, the backup checks clean', async () => {
  const { store } = await sample();
  const before = await readAll(store);
  const data = toBackup(before);
  assert.equal(data.format, BACKUP_FORMAT);
  assert.deepEqual(checkBackup(JSON.parse(backupText(data).text)), { ok: true });
  const fresh = memoryStore(NETLOG_STORES);
  const report = await importBackup(fresh, JSON.parse(backupText(data).text));
  assert.equal(report.sessions, 1);
  assert.equal(report.copies, 0);
  assert.deepEqual(strip(await readAll(fresh)), strip(before));
});

test('importing the same backup again changes nothing; a changed local session gets an imported copy', async () => {
  const { store, s, ctx, n } = await sample();
  const data = JSON.parse(backupText(toBackup(await readAll(store))).text);
  let report = await importBackup(store, data);
  assert.equal(report.identical, 1);
  assert.equal(report.sessions, 0);
  // the local session moves on; the backup is now a different state of it
  await updateNote(store, ctx, n.id, 'edited locally');
  const local = await readAll(store);
  report = await importBackup(store, data, { copySuffix: ' (import)' });
  assert.equal(report.copies, 1);
  const all = await readAll(store);
  assert.equal(all.sessions.length, 2);
  const copy = all.sessions.find(x => x.id !== s.id);
  assert.match(copy.name, /\(import\)$/);
  // nothing local was overwritten
  assert.equal(all.notes.find(x => x.id === n.id).text, 'edited locally');
  for (const st of BACKUP_STORES) for (const r of local[st]) assert.deepEqual(all[st].find(x => x.id === r.id), r, `${st} ${r.id} unchanged`);
  // the copy is consistent: every reference points into the copy
  const own = st => all[st].filter(r => r.eventId === copy.id);
  const ids = st => new Set(own(st).map(r => r.id));
  assert.ok(ids('rounds').has(copy.currentRoundId));
  assert.ok(ids('participants').has(copy.ncsId));
  for (const note of own('notes')) {
    assert.ok(ids('participants').has(note.participantId));
    assert.ok(ids('rounds').has(note.roundId));
    assert.ok(!note.contributionId || ids('contributions').has(note.contributionId));
  }
  for (const it of own('items')) if (it.noteId) assert.ok(ids('notes').has(it.noteId));
  for (const it of own('items')) if (it.doneTurnId) assert.ok(ids('turns').has(it.doneTurnId));
  for (const r of own('revisions')) assert.ok(ids(r.store).has(r.recordId) || r.store === 'sessions');
  for (const d of own('drafts')) {
    assert.equal(d.id, `${copy.id}|${d.key}`);
    assert.ok(ids('participants').has(d.key.split(':')[1]));
  }
  assert.equal(own('undo').length, 0, 'the copy has no undo history (it refers to other states)');
  assert.equal(all.notes.filter(x => x.eventId === copy.id && x.text === 'Interference persists after the change.').length, 1);
});

test('response state and order, the open turn and drafts survive the trip', async () => {
  const { store, s } = await sample();
  const fresh = memoryStore(NETLOG_STORES);
  await importBackup(fresh, toBackup(await readAll(store)));
  const items = await fresh.getByEvent('items', s.id);
  const resp = items.find(i => i.kind === 'response');
  assert.equal(resp.state, 'done');
  assert.equal(resp.text, 'Ask about common-mode current.');
  assert.deepEqual(resp.history.map(h => h.state), ['open', 'done']);
  assert.ok(items.find(i => i.kind === 'task'));
  assert.equal((await fresh.getByEvent('turns', s.id)).filter(t => !t.ended).length, 1);
  assert.equal((await fresh.getByEvent('drafts', s.id))[0].text, 'half typed');
  assert.ok(await undoStep(fresh, s.id), 'the undo history came over');
});

test('one session: with its series and the profiles it uses, restorable on its own', async () => {
  const { store, s } = await sample();
  const other = await createSession(store, { tab: TAB }, {});
  await addParticipant(store, { sessionId: other.id, tab: TAB }, { call: 'OE0QXC' });
  const data = toBackup(await readAll(store), { sessionId: s.id });
  assert.equal(data.scope, 'session');
  assert.deepEqual(data.stores.sessions.map(x => x.id), [s.id]);
  assert.equal(data.stores.series.length, 1);
  assert.equal(data.stores.profiles.length, 1);
  assert.ok(data.stores.participants.every(p => p.eventId === s.id));
  assert.deepEqual(checkBackup(data), { ok: true });
  const fresh = memoryStore(NETLOG_STORES);
  await importBackup(fresh, data);
  assert.equal((await fresh.getAll('sessions')).length, 1);
});

test('rejected before any write: not a backup, other version, newer schema, broken references, duplicates', async () => {
  const { store } = await sample();
  const good = toBackup(await readAll(store));
  const cases = [
    [null, 'notBackup'], [[], 'notBackup'], [{ format: 'oe1ebg-confirm-backup' }, 'notBackup'],
    [{ ...good, version: 2 }, 'version'], [{ ...good, schema: 99 }, 'newer'],
    [{ ...good, stores: { ...good.stores, bogus: [] } }, 'malformed'],
    [{ ...good, stores: { ...good.stores, notes: [...good.stores.notes, { ...good.stores.notes[0] }] } }, 'malformed'],
    [{ ...good, stores: { ...good.stores, notes: [{ ...good.stores.notes[0], participantId: 'nobody' }] } }, 'malformed'],
    [{ ...good, stores: { ...good.stores, items: [{ ...good.stores.items[0], kind: 'x' }] } }, 'malformed'],
    [{ ...good, stores: { ...good.stores, participants: [{ ...good.stores.participants[0], id: '../evil' }] } }, 'malformed'],
    [{ ...good, stores: { ...good.stores, rounds: [] } }, 'malformed'],
  ];
  for (const [data, error] of cases) assert.equal(checkBackup(data).error, error, JSON.stringify(data && data.version));
  // a record set over the limit
  const many = { ...good, stores: { ...good.stores, revisions: Array.from({ length: BACKUP_MAX_RECORDS + 1 }, (_, i) => ({ id: `r${i}`, eventId: good.stores.sessions[0].id, store: 'notes', recordId: 'x' })) } };
  assert.equal(checkBackup(many).error, 'tooManyRecords');
});

test('size limits at export: below and above refuse nothing / everything; UTF-8 bytes counted', () => {
  assert.equal(utf8Bytes('aä€😀'), 1 + 2 + 3 + 4);
  const sid = 's1';
  const base = { sessions: [{ id: sid, currentRoundId: 'r1', seriesId: null, ncsId: null }], rounds: [{ id: 'r1', eventId: sid }] };
  const small = toBackup({ ...base, notes: [] });
  assert.ok(backupText(small).text);
  // just above the byte limit: refused, nothing to download
  const big = toBackup({ ...base, participants: [{ id: 'p', eventId: sid }], notes: [{ id: 'n', eventId: sid, participantId: 'p', roundId: 'r1', text: 'x'.repeat(BACKUP_MAX_BYTES) }] });
  assert.deepEqual(backupText(big), { error: 'tooLarge' });
  // multi-byte text counts by bytes: half the limit in 3-byte characters is over it
  const wide = toBackup({ ...base, participants: [{ id: 'p', eventId: sid }], notes: [{ id: 'n', eventId: sid, participantId: 'p', roundId: 'r1', text: '€'.repeat(Math.ceil(BACKUP_MAX_BYTES / 2)) }] });
  assert.deepEqual(backupText(wide), { error: 'tooLarge' });
  const many = toBackup({ ...base, revisions: Array.from({ length: BACKUP_MAX_RECORDS }, (_, i) => ({ id: `r${i}`, eventId: sid })) });
  assert.deepEqual(backupText(many), { error: 'tooManyRecords' }, 'rounds + revisions are one over the limit');
});

test('an import that fails midway leaves storage unchanged', async () => {
  const { store } = await sample();
  const data = toBackup(await readAll(store));
  const target = memoryStore(NETLOG_STORES);
  const before = await readAll(target);
  target.failWrites = s => (s === 'notes' ? Object.assign(new Error('quota'), { name: 'QuotaExceededError' }) : null);
  await assert.rejects(importBackup(target, data));
  target.failWrites = null;
  assert.deepEqual(await readAll(target), before);
});

test('series and profiles: identical skipped, different imported as copies', () => {
  const data = { stores: { series: [{ id: 'S', name: 'Net' }], profiles: [{ id: 'P', call: 'OE0QXB' }], sessions: [{ id: 's', seriesId: 'S' }], participants: [{ id: 'p', eventId: 's', profileId: 'P' }] } };
  const existing = Object.fromEntries(BACKUP_STORES.map(s => [s, new Map()]));
  existing.series.set('S', { id: 'S', name: 'Net (local edit)' });
  existing.profiles.set('P', { id: 'P', call: 'OE0QXB' });
  let n = 0;
  const { puts, report } = planImport(data, existing, () => `new${++n}`, ' (import)');
  const series = puts.filter(p => p.store === 'series');
  assert.deepEqual(series.map(p => [p.value.id, p.value.name]), [['new1', 'Net (import)']]);
  assert.equal(puts.filter(p => p.store === 'profiles').length, 0);
  assert.equal(puts.find(p => p.store === 'sessions').value.seriesId, 'new1');
  assert.equal(puts.find(p => p.store === 'participants').value.profileId, 'P');
  assert.equal(report.series, 1);
});

test('erasure: a station with its notes, revisions and drafts; the session keeps the rest', async () => {
  const { store, s, ctx, a, b, n } = await sample();
  await eraseParticipant(store, ctx, b.id);
  const all = await readAll(store);
  assert.equal(all.participants.find(p => p.id === b.id), undefined);
  assert.equal(all.notes.find(x => x.id === n.id), undefined);
  assert.ok(!all.items.some(i => i.noteId === n.id));
  assert.ok(!all.revisions.some(r => r.recordId === n.id || r.recordId === b.id));
  assert.ok(!all.drafts.some(d => d.key === `new:${b.id}`));
  assert.ok(!all.contributions.some(c => c.participantId === b.id));
  assert.equal(all.undo.filter(u => u.eventId === s.id).length, 0, 'the undo history is cleared');
  assert.ok(all.participants.find(p => p.id === a.id));
  assert.ok(all.items.some(i => i.kind === 'point'), 'the talking point stays');
  // the profile saved from it stays (a separate record), until erased
  assert.equal(all.profiles.length, 1);
  await eraseProfile(store, all.profiles[0].id);
  assert.equal((await store.getAll('profiles')).length, 0);
});

test('erasure: a session with everything it owns (also the lease); all data', async () => {
  const { store, s } = await sample();
  await eraseSession(store, s.id);
  const all = await readAll(store);
  for (const st of BACKUP_STORES) if (st !== 'series' && st !== 'profiles' && st !== 'undo') assert.equal(all[st].length, 0, st);
  assert.equal(await store.get('meta', `lease:${s.id}`), undefined);
  assert.equal(all.series.length, 1, 'the series stays');
  await eraseAll(store);
  for (const st of Object.keys(NETLOG_STORES)) assert.equal((await store.getAll(st)).length, 0, st);
});
