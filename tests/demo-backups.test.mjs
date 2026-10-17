// The downloadable examples must remain usable backups, not just valid JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { memoryStore } from '../tools/netlog/js/memstore.js';
import { NETLOG_STORES } from '../tools/netlog/js/db.js';
import { checkBackup, toBackup, BACKUP_STORES } from '../tools/netlog/js/backup.js';
import { importBackup, readAll } from '../tools/netlog/js/ops.js';
import { validateBackup, planBackupImport } from '../tools/confirm/js/backup.js';
import { STORES } from '../tools/confirm/js/db.js';
import { parseBackup } from '../tools/notfunk/js/export.js';
import { applyBackup } from '../tools/notfunk/js/ops.js';
import { counterAfterImport, nextSeq } from '../tools/notfunk/js/numbering.js';

const load = async name => JSON.parse(await readFile(new URL(`../examples/backups/${name}.json`, import.meta.url), 'utf8'));
const sorted = records => [...records].sort((a, b) => a.id.localeCompare(b.id));

for (const size of ['example', 'full']) {
  test(`Netlog ${size}: restore preserves every store and repeated import skips unchanged sessions`, async () => {
    const data = await load(`netlog-${size}`);
    assert.deepEqual(checkBackup(data), { ok: true });
    const store = memoryStore(NETLOG_STORES);
    const first = await importBackup(store, data);
    assert.equal(first.sessions, size === 'full' ? 12 : 1);
    assert.equal(first.copies, 0);
    const all = await readAll(store);
    for (const name of BACKUP_STORES) assert.deepEqual(sorted(all[name]), sorted(data.stores[name]), name);
    assert.deepEqual(checkBackup(toBackup(all)), { ok: true });
    const again = await importBackup(store, data);
    assert.equal(again.identical, first.sessions);
    assert.equal(again.sessions, 0);
    assert.deepEqual(await readAll(store), all);
    // A note must refer to a station, round and contribution in its own session.
    for (const note of all.notes) {
      for (const [name, id] of [['participants', note.participantId], ['rounds', note.roundId], ['contributions', note.contributionId]]) {
        if (id) assert.equal(all[name].find(r => r.id === id)?.eventId, note.eventId, `${name}: ${id}`);
      }
    }
  });

  test(`Confirm ${size}: warning-free import and a second import preserves the original logs`, async () => {
    const data = await load(`confirm-${size}`);
    assert.deepEqual(validateBackup(data), { ok: true, errors: [], warnings: [] });
    const store = memoryStore(STORES);
    const existing = async () => Object.fromEntries(await Promise.all(['events', 'entries', 'revisions'].map(async name => [name, new Set((await store.getAll(name)).map(r => r.id))])));
    let id = 0;
    const plan = planBackupImport(data, await existing(), () => `demo-copy-${++id}`);
    await store.tx(plan.puts.map(p => ({ store: p.store, put: p.value })));
    assert.equal(plan.imported, size === 'full' ? 4 : 1);
    assert.equal(plan.copies, 0);
    for (const item of data.events) {
      assert.deepEqual(await store.get('events', item.event.id), item.event);
      assert.deepEqual(sorted(await store.getByEvent('entries', item.event.id)), sorted(item.entries));
    }
    const copies = planBackupImport(data, await existing(), () => `demo-copy-${++id}`);
    assert.equal(copies.copies, data.events.length);
    await store.tx(copies.puts.map(p => ({ store: p.store, put: p.value })));
    assert.equal((await store.getAll('events')).length, data.events.length * 2);
    for (const item of data.events) assert.deepEqual(await store.get('events', item.event.id), item.event);
    for (const e of await store.getAll('entries')) assert.ok(await store.get('events', e.eventId));
  });

  test(`Notfunk ${size}: lossless restore, linked replies and the next unused message number`, async () => {
    const data = parseBackup(JSON.stringify(await load(`notfunk-${size}`)));
    assert.deepEqual(data.dropped, []);
    const schema = Object.fromEntries(['operations', 'messages', 'revisions', 'counters'].map(name => [name, { keyPath: 'id' }]));
    const store = memoryStore(schema);
    const report = await applyBackup(store, data);
    assert.equal(report.added, size === 'full' ? 30 : 6);
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.unlinked, []);
    assert.deepEqual(await store.get('operations', data.operation.id), data.operation);
    assert.deepEqual(sorted(await store.getAll('messages')), sorted(data.messages));
    assert.deepEqual(sorted(await store.getAll('counters')), sorted(data.counters));
    assert.deepEqual(data.counters, counterAfterImport([], data.messages, data.operation.id));
    assert.equal(nextSeq(data.counters[0], data.messages, 'D1'), size === 'full' ? 31 : 7);
    for (const m of data.messages) {
      assert.match(m.text, /ÜBUNG – KEIN REALEINSATZ/);
      if (m.replyTo) assert.equal(data.messages.find(r => r.id === m.replyTo)?.number, m.refNumber);
    }
    const again = await applyBackup(store, data);
    assert.equal(again.added, 0);
    assert.equal(again.updated, 0);
    assert.deepEqual(sorted(await store.getAll('messages')), sorted(data.messages));
  });
}

test('demo identities are fictional and consistent across tools and profile snapshots', async () => {
  const identities = new Map();
  const remember = (call, name, qth) => {
    assert.match(call, /^OE0QX[A-N]$/);
    assert.ok(name);
    assert.match(qth, /\(fiktiv\)$/);
    const identity = { name, qth };
    if (identities.has(call)) assert.deepEqual(identity, identities.get(call), call);
    else identities.set(call, identity);
  };
  const netlog = await load('netlog-full');
  for (const p of [...netlog.stores.profiles, ...netlog.stores.participants]) remember(p.call, p.name, p.qth);
  for (const p of netlog.stores.participants) {
    assert.equal(netlog.stores.profiles.find(r => r.id === p.profileId)?.call, p.call);
  }
  const confirm = await load('confirm-full');
  for (const { event, entries } of confirm.events) for (const e of entries) {
    if (e.kind) continue;
    const identity = identities.get(e.call);
    assert.ok(identity, e.call);
    if (event.template === 'rst') remember(e.call, e.fields.name, e.fields.qth);
    else assert.equal(e.fields.address, identity.qth);
    assert.equal(e.loc, null);
  }
  const notfunk = await load('notfunk-full');
  for (const m of notfunk.messages) for (const party of [m.from, m.to]) {
    assert.equal(party.name, `${identities.get(party.call)?.name} / Übungsstation`);
    assert.equal(party.contact, '');
  }
});
