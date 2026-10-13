// Backups beyond the import limits (issue #15 review): the tools' own export
// must always be restorable, so it is written in parts that are imported
// together, losslessly and in one atomic write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitToFit, PART_MAX_BYTES, PART_MAX_RECORDS, PARTS_MAX_COUNT, PARTS_MAX_TOTAL_BYTES, PARTS_MAX_TOTAL_RECORDS, groupParts, partFileName, utf8Length } from '../tools/shared/js/backup-parts.js';
import { BACKUP_FORMAT, BACKUP_MAX_BYTES, BACKUP_MAX_RECORDS, validateBackup, planBackupImport, backupTexts, combineBackupParts } from '../tools/confirm/js/backup.js';
import { toBackup, toBackupTexts, parseBackup, combineBackupParts as nfCombine, mergeBackup, BACKUP_MAX_BYTES as NF_BYTES, BACKUP_MAX_RECORDS as NF_RECORDS } from '../tools/notfunk/js/export.js';
import { newMessage, editMessage, MESSAGE_TEXT_MAX, messageFields } from '../tools/notfunk/js/model.js';
import { formatNumber, counterKey } from '../tools/notfunk/js/numbering.js';

const T = '2026-10-04T16:00:00.000Z';
const named = texts => texts.map((text, i) => ({ name: partFileName('x', i + 1, texts.length), data: JSON.parse(text) }));

test('part files: names, grouping, missing and mixed parts', () => {
  assert.equal(partFileName('a_sicherung', 2, 3), 'a_sicherung_teil-2-von-3.json');
  const f = (set, n, of) => ({ name: `f${set}${n}`, data: { part: { set, n, of } } });
  const single = { name: 's', data: { format: 'x' } };
  const g = groupParts([f('A', 2, 2), single, f('A', 1, 2)]);
  assert.deepEqual(g.sets.map(s => s.files.map(x => x.part.n)), [[1, 2]]);
  assert.equal(g.singles.length, 1);
  assert.deepEqual(g.errors, []);
  const miss = groupParts([f('A', 2, 3), f('A', 1, 3)]);
  assert.equal(miss.sets.length, 0);
  assert.match(miss.errors[0], /fehlen die Teile 3/);
  assert.match(groupParts([f('A', 1, 2), f('A', 1, 2)]).errors[0], /mehrfach/);
  assert.match(groupParts([{ name: 'k', data: { part: { set: 'A', n: 5, of: 2 } } }]).errors[0], /ungültige Teil-Angabe/);
});

// ---- Notfunk: 1100 messages of 50000 characters (a valid, normally saved log) = ~56 MB
const OP = { id: 'op1', name: 'Übung', prefix: 'W1', created: T, updated: T };
const fields = text => messageFields({
  direction: 'in', ts: T, channel: 'funk', radio: { freq: '145.500' }, peer: 'OE1ABC',
  from: { name: 'Lichtinsel 3' }, to: { name: 'Stab' }, subject: 'Wasser', text,
});
const msg = (i, text) => newMessage(fields(text), { prefix: 'W1', seq: i, number: formatNumber('W1', i) }, { id: `b${i}`, opId: 'op1', operator: 'OE1EBG', stationCall: 'OE1XKS', now: T });

test('notfunk: a backup of 1100 messages x 50000 characters is exported in parts and restores completely', () => {
  const messages = [];
  const revisions = [];
  for (let i = 1; i <= 1100; i++) {
    let m = msg(i, 'x'.repeat(MESSAGE_TEXT_MAX));
    if (i % 100 === 0) {
      const e = editMessage(m, { staffRef: `GZ ${i}` }, { revisionId: `r${i}`, operator: 'OE1EBG', now: '2026-10-04T17:00:00.000Z' });
      m = e.next;
      revisions.push(e.revision);
    }
    messages.push(m);
  }
  const data = { operation: OP, messages, revisions, counters: [{ id: counterKey('op1', 'W1'), eventId: 'op1', prefix: 'W1', last: 1100 }] };
  assert.ok(utf8Length(toBackup(data, T)) > NF_BYTES, 'the single file is beyond the import limit');
  const texts = toBackupTexts(data, T, 'set-1');
  assert.ok(texts.length >= 2);
  for (const t of texts) {
    assert.ok(utf8Length(t) <= NF_BYTES);
    assert.doesNotThrow(() => parseBackup(t)); // each part is a valid file of its own
  }
  const g = groupParts(named(texts));
  assert.deepEqual(g.errors, []);
  assert.equal(g.sets.length, 1);
  const back = nfCombine(g.sets[0].files.map(f => f.data));
  assert.equal(back.messages.length, 1100);
  assert.equal(back.revisions.length, 11);
  assert.deepEqual(back.dropped, []);
  assert.deepEqual(back.counters.map(c => c.last), [1100]);
  const r = mergeBackup(back, { operation: null, messages: [], revisions: [], counters: [] });
  assert.equal(r.added, 1100);
  assert.deepEqual(r.conflicts.concat(r.unlinked), []);
  assert.equal(r.ops.filter(o => o.store === 'revisions').length, 11);
  assert.equal(r.ops.find(o => o.store === 'counters').put.last, 1100);
  // ids and content are exactly the exported ones
  const put = new Map(r.ops.filter(o => o.store === 'messages').map(o => [o.put.id, o.put]));
  assert.deepEqual(messages.map(m => put.get(m.id)), messages);
  // a missing part is an error, nothing is combined
  assert.match(groupParts(named(texts).slice(1)).errors[0], /fehlen die Teile 1/);
  // a small backup stays one file without `part`
  const small = toBackupTexts({ ...data, messages: messages.slice(0, 3), revisions: [] }, T, 's');
  assert.equal(small.length, 1);
  assert.equal(JSON.parse(small[0]).part, undefined);
});

test('notfunk: more records than one file accepts are split and restored', () => {
  const base = msg(1, 'Kein Wasser.');
  const revisions = Array.from({ length: NF_RECORDS + 1 }, (_, i) => ({ id: `r${i}`, eventId: 'op1', messageId: 'b1', at: T, by: 'X', old: base }));
  const data = { operation: OP, messages: [base], revisions, counters: [{ id: counterKey('op1', 'W1'), eventId: 'op1', prefix: 'W1', last: 1 }] };
  assert.throws(() => parseBackup(toBackup(data, T)), /nicht importiert/);
  const texts = toBackupTexts(data, T, 's');
  assert.ok(texts.length >= 2);
  const back = nfCombine(named(texts).map(f => f.data));
  assert.equal(back.revisions.length, NF_RECORDS + 1);
  assert.equal(back.messages.length, 1);
  assert.deepEqual(back.dropped, []);
});

// ---- Confirm
const entry = (id, seq, extra = {}) => ({ id, eventId: 'e1', seq, call: `OE1A${seq}`, ts: T, created: T, updated: T, deleted: null, ...extra });
const ev = { id: 'e1', title: 'Netz', created: T, updated: T, nextSeq: 0 };

test('confirm: a log beyond the record limit is exported in parts and restored with all ids and revisions', () => {
  const entries = Array.from({ length: BACKUP_MAX_RECORDS + 1 }, (_, i) => entry(`a${i}`, i + 1));
  const revisions = [{ id: 'r1', eventId: 'e1', entryId: 'a0', savedAt: T, reason: 'edit', data: entries[0] }];
  const ev2 = { event: { id: 'e2', title: 'Leer', created: T, updated: T }, entries: [], revisions: [] };
  const events = [{ event: { ...ev, nextSeq: entries.length + 1 }, entries, revisions }, ev2];
  const texts = backupTexts(events, T, 'set-2');
  assert.ok(texts.length >= 2);
  for (const t of texts) assert.ok(validateBackup(JSON.parse(t), 20, { fileOnly: true }).ok);
  const g = groupParts(named(texts));
  assert.deepEqual(g.errors, []);
  const c = combineBackupParts(g.sets[0].files.map(f => f.data));
  assert.equal(c.errors, undefined);
  assert.equal(c.data.part, undefined);
  assert.equal(c.data.events.length, 2);
  const check = validateBackup(c.data, 20, { combined: true });
  assert.equal(check.ok, true);
  assert.deepEqual(check.warnings, []);
  assert.equal(validateBackup(c.data).ok, false); // as one file it would still be refused
  let n = 0;
  const plan = planBackupImport(c.data, { events: new Set(), entries: new Set(), revisions: new Set() }, () => `n${n++}`);
  assert.equal(plan.puts.filter(p => p.store === 'entries').length, entries.length);
  assert.equal(plan.puts.filter(p => p.store === 'revisions').length, 1);
  assert.equal(plan.copies, 0); // same ids as exported
  assert.deepEqual(plan.puts.filter(p => p.store === 'entries').map(p => p.value.id), entries.map(e => e.id));
  assert.equal(plan.puts.find(p => p.store === 'events' && p.value.id === 'e1').value.nextSeq, entries.length + 1);
});

test('confirm: notes beyond the file size limit are split; a small backup stays one file', () => {
  const entries = Array.from({ length: 130 }, (_, i) => entry(`a${i}`, i + 1, { note: 'n'.repeat(400000) }));
  const texts = backupTexts([{ event: ev, entries, revisions: [] }], T, 'set-3');
  assert.ok(texts.length >= 2);
  for (const t of texts) assert.ok(utf8Length(t) <= BACKUP_MAX_BYTES);
  const c = combineBackupParts(named(texts).map(f => f.data));
  assert.deepEqual(c.data.events[0].entries.map(e => e.id), entries.map(e => e.id));
  assert.equal(c.data.events[0].entries[5].note, entries[5].note);
  const small = backupTexts([{ event: ev, entries: entries.slice(0, 2), revisions: [] }], T, 's');
  assert.equal(small.length, 1);
  assert.equal(JSON.parse(small[0]).format, BACKUP_FORMAT);
  assert.equal(JSON.parse(small[0]).part, undefined);
  // a part of another format is refused
  assert.ok(combineBackupParts([{ format: 'x', events: [] }, { format: 'x', events: [] }]).errors);
});

// Review: a set of parts is bounded as a whole.
test('a set of parts is refused beyond the total limits (nothing combined)', async () => {
  const { partsTooLarge, partsTooManyRecords, PARTS_MAX_TOTAL_BYTES, PARTS_MAX_COUNT } = await import('../tools/shared/js/backup-parts.js');
  assert.equal(partsTooLarge(PARTS_MAX_TOTAL_BYTES), '');
  assert.match(partsTooLarge(PARTS_MAX_TOTAL_BYTES + 1), /nicht gemeinsam importiert.*nichts importiert/);
  assert.match(partsTooManyRecords(1000001), /nichts importiert/);
  assert.equal(partsTooManyRecords(1000000), '');
  // `of` is bounded
  assert.equal(groupParts([{ name: 'a', data: { part: { set: 's', n: 1, of: PARTS_MAX_COUNT + 1 } } }]).errors.length, 1);
  // six parts of 200000 records each (valid per file) are beyond 1000000 in total
  const six = Array.from({ length: 6 }, (_, i) => ({ format: BACKUP_FORMAT, version: 1, part: { set: 's', n: i + 1, of: 6 }, events: [{ event: ev, entries: new Array(BACKUP_MAX_RECORDS).fill(null), revisions: [] }] }));
  assert.match(combineBackupParts(six).errors[0], /nichts importiert/);
  const nf = Array.from({ length: 6 }, () => ({ format: 'oe1ebg-notfunk-backup', version: 1, operation: OP, messages: [], revisions: new Array(NF_RECORDS).fill(null), counters: [] }));
  assert.throws(() => nfCombine(nf), /nichts importiert/);
});

// Review: every split the exporter produces must be restorable; what cannot
// be is refused BEFORE anything is written, never a partial set.
test('the part limits are consistent: a full set of full parts is within the set limits', () => {
  assert.ok(PART_MAX_RECORDS * PARTS_MAX_COUNT <= PARTS_MAX_TOTAL_RECORDS);
  assert.ok(PART_MAX_BYTES * PARTS_MAX_COUNT <= PARTS_MAX_TOTAL_BYTES);
});

test('splitToFit: the largest supported set splits and restores, one more is refused', () => {
  const lim = { maxRecords: 10, maxBytes: 1e9, maxParts: 4, maxTotalRecords: 40, tooLarge: 'zu groß' };
  const build = (slice, part) => JSON.stringify({ part, items: slice });
  const items = n => Array.from({ length: n }, (_, i) => i);
  const parts = splitToFit(items(40), build, () => 1, lim);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.flat(), items(40)); // nothing left out, in order
  assert.throws(() => splitToFit(items(41), build, () => 1, lim), /zu groß/);
  // more bytes than the set allows: refused too
  assert.throws(() => splitToFit(items(40), build, () => 1, { ...lim, maxTotalBytes: 100 }), /zu groß/);
  // sets that fit in fewer parts do not use more (neighbouring slices are joined)
  assert.equal(splitToFit(items(31), build, () => 1, lim).length, 4);
  assert.equal(splitToFit(items(20), build, () => 1, lim).length, 2);
});

// The search for the longest prefix that fits (#36) must find exactly what a
// plain scan finds, for any sizes of the items: even, random, skewed (a few
// large ones among small ones), one item just at the limit; and it must
// need only a few builds per part for even sizes.
test('splitToFit: each part is the longest prefix that fits, the same as a plain scan', () => {
  const build = (slice, part) => JSON.stringify({ part, items: slice });
  const probe = { set: '0'.repeat(36), n: 9999, of: 9999 };
  const scan = (items, maxBytes, maxRecords) => {
    const out = [];
    for (let i = 0; i < items.length;) {
      let end = i + 1;
      while (end < items.length && end + 1 - i <= maxRecords && utf8Length(build(items.slice(i, end + 1), probe)) <= maxBytes) end++;
      out.push(items.slice(i, end));
      i = end;
    }
    return out;
  };
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const shapes = {
    even: i => 'x'.repeat(20),
    random: () => 'y'.repeat(1 + Math.floor(rnd() * 80)),
    skewed: i => (i % 37 === 0 ? 'z'.repeat(600) : 'a'),
    umlauts: () => 'äöü€'.repeat(1 + Math.floor(rnd() * 20)),
  };
  for (const [name, text] of Object.entries(shapes)) {
    for (const maxBytes of [700, 1500, 4000]) {
      for (const maxRecords of [7, 50, 1000]) {
        const items = Array.from({ length: 300 }, (_, i) => text(i));
        const lim = { maxBytes, maxRecords, maxParts: 1000, maxTotalBytes: 1e9, maxTotalRecords: 1e9 };
        let got;
        try { got = splitToFit(items, build, () => 1, lim); } catch (e) { got = e.message; }
        let want;
        try {
          if (items.some(x => utf8Length(build([x], probe)) > maxBytes)) throw new Error('one item too large');
          want = scan(items, maxBytes, maxRecords);
        } catch (e) { want = e.message; }
        if (typeof want === 'string') assert.equal(typeof got, 'string', `${name} ${maxBytes} ${maxRecords}`);
        else assert.deepEqual(got, want, `${name} ${maxBytes} ${maxRecords}`);
      }
    }
  }
  // even sizes: a handful of builds per part, not one per halving of 20000
  let builds = 0;
  const counting = (slice, part) => { builds++; return build(slice, part); };
  const many = Array.from({ length: 20000 }, () => 'x'.repeat(20));
  const parts = splitToFit(many, counting, () => 1, { maxBytes: 100000, maxRecords: 20000, maxParts: 1000, maxTotalBytes: 1e9, maxTotalRecords: 1e9 });
  assert.deepEqual(parts.flat(), many);
  assert.ok(builds <= 4 * parts.length + 2, `${builds} builds for ${parts.length} parts`);
});

test('exports at the real largest size are split into restorable sets, beyond it they are refused in both tools', () => {
  const MAX = PART_MAX_RECORDS * PARTS_MAX_COUNT;
  const mk = n => Array.from({ length: n }, (_, i) => ({ id: `a${i}` }));
  // Confirm
  const ok = backupTexts([{ event: ev, entries: mk(MAX), revisions: [] }], T, 'big');
  assert.equal(ok.length, PARTS_MAX_COUNT);
  const c = combineBackupParts(named(ok).map(f => f.data));
  assert.equal(c.errors, undefined);
  assert.equal(c.data.events[0].entries.length, MAX);
  assert.throws(() => backupTexts([{ event: ev, entries: mk(MAX + 1), revisions: [] }], T, 'big'), e => e.tooLarge && /nichts heruntergeladen/.test(e.message) && /einzelnen Logs/.test(e.message));
  // Notfunk
  const nfData = n => ({ operation: OP, messages: [], revisions: mk(n), counters: [] });
  const nfOk = toBackupTexts(nfData(MAX), T, 'big');
  assert.equal(nfOk.length, PARTS_MAX_COUNT);
  assert.equal(nfOk.reduce((n, t) => n + JSON.parse(t).revisions.length, 0), MAX); // every record is in some part
  assert.throws(() => toBackupTexts(nfData(MAX + 1), T, 'big'), e => e.tooLarge && /nichts heruntergeladen/.test(e.message) && /neuen Einsatz/.test(e.message));
});

// Review: one record whose text is beyond the per-file limit is split into
// chunks across the parts and put together again, byte-identical.
const MiB = 1048576;
const chunksOf = texts => texts.flatMap(t => JSON.parse(t).chunks || []);

test('confirm: a note, a comment and a revision text over 50 MiB are chunked across parts and restore byte-identical', () => {
  const big = 'x'.repeat(52 * MiB);
  const mixed = 'ä€😀z'.repeat(400000) + 'end'; // multi-byte and surrogate pairs at chunk edges
  const entries = [
    entry('a1', 1, { note: big }),
    { id: 'c1', eventId: 'e1', kind: 'comment', ts: T, created: T, updated: T, deleted: null, text: mixed },
    entry('a2', 2, { note: 'klein' }),
  ];
  const revisions = [{ id: 'r1', eventId: 'e1', entryId: 'a1', savedAt: T, reason: 'edit', data: { ...entries[0], note: big + 'alt' } }];
  const texts = backupTexts([{ event: { ...ev, nextSeq: 3 }, entries, revisions }], T, 'big-note');
  assert.ok(texts.length >= 2);
  for (const t of texts) assert.ok(utf8Length(t) <= BACKUP_MAX_BYTES, 'each part is within the per-file limit');
  assert.ok(chunksOf(texts).length >= 100);
  const g = groupParts(named(texts));
  const c = combineBackupParts(g.sets[0].files.map(f => f.data));
  assert.equal(c.errors, undefined);
  assert.equal(c.data.chunks, undefined);
  const check = validateBackup(c.data, 20, { combined: true });
  assert.equal(check.ok, true);
  assert.deepEqual(check.warnings, []);
  const e = c.data.events[0];
  assert.equal(e.entries.length, 3);
  assert.ok(e.entries.find(x => x.id === 'a1').note === big);
  assert.ok(e.entries.find(x => x.id === 'c1').text === mixed);
  assert.ok(e.revisions[0].data.note === big + 'alt');
  let n = 0;
  const plan = planBackupImport(c.data, { events: new Set(), entries: new Set(), revisions: new Set() }, () => `n${n++}`);
  assert.equal(plan.copies, 0);
  assert.ok(plan.puts.find(p => p.store === 'entries' && p.value.id === 'a1').value.note === big);
  assert.equal(plan.puts.find(p => p.store === 'events').value.nextSeq, 3);
});

test('confirm: missing, duplicated, inconsistent and shuffled chunks', () => {
  const big = 'abc'.repeat(2 * MiB); // 6 million characters: chunks, one part would do with a lower limit
  const texts = backupTexts([{ event: ev, entries: [entry('a1', 1, { note: big })], revisions: [] }], T, 's', { maxBytes: 2000000 });
  assert.ok(texts.length >= 2);
  const parts = () => texts.map(t => JSON.parse(t));
  const withChunks = ps => ps.map((p, i) => ({ p, i })).filter(x => (x.p.chunks || []).length);
  // shuffled order inside and across parts: still byte-identical
  const sh = parts();
  for (const p of sh) if (p.chunks) p.chunks.reverse();
  assert.ok(combineBackupParts(sh).data.events[0].entries[0].note === big);
  // a missing chunk
  const miss = parts();
  withChunks(miss)[0].p.chunks.pop();
  assert.match(combineBackupParts(miss).errors[0], /Textblock|fehl/);
  // a duplicated chunk
  const dup = parts();
  const w = withChunks(dup)[0].p;
  w.chunks.push(w.chunks[0]);
  assert.match(combineBackupParts(dup).errors[0], /doppelt/);
  // inconsistent count
  const inc = parts();
  withChunks(inc)[0].p.chunks[0].of += 1;
  assert.ok(combineBackupParts(inc).errors[0]);
  // a chunk for a record that is not there
  const ghost = parts();
  withChunks(ghost)[0].p.chunks[0].rid = 'nope';
  assert.ok(combineBackupParts(ghost).errors[0]);
});

test('notfunk: an imported Inhalt over 50 MiB (and its revision) is chunked and restored byte-identical', () => {
  const big = 'y'.repeat(52 * MiB);
  const m = msg(1, 'kurz');
  m.text = big; // as a lenient import keeps it
  const rev = { id: 'r1', eventId: 'op1', messageId: 'b1', at: T, by: 'X', old: { ...m, text: big + '!' } };
  const data = { operation: OP, messages: [m, msg(2, 'Kein Wasser.')], revisions: [rev], counters: [{ id: counterKey('op1', 'W1'), eventId: 'op1', prefix: 'W1', last: 2 }] };
  const texts = toBackupTexts(data, T, 'nf-big');
  assert.ok(texts.length >= 2);
  for (const t of texts) assert.ok(utf8Length(t) <= NF_BYTES);
  const back = nfCombine(named(texts).map(f => f.data));
  assert.deepEqual(back.dropped, []);
  assert.ok(back.messages.find(x => x.id === 'b1').text === big);
  assert.ok(back.revisions[0].old.text === big + '!');
  const r = mergeBackup(back, { operation: null, messages: [], revisions: [], counters: [] });
  assert.equal(r.added, 2);
  assert.equal(r.ops.find(o => o.store === 'counters').put.last, 2);
  // a missing chunk is refused
  const ps = named(texts).map(f => f.data);
  ps.find(p => p.chunks?.length).chunks.pop();
  assert.throws(() => nfCombine(ps), /Textblock|fehl/);
});

test('a record that cannot be split (many strings below the chunk size) is refused before any download', () => {
  const rec = { id: 'a1', eventId: 'e1', seq: 1, a: 'x'.repeat(400000), b: 'y'.repeat(400000), c: 'z'.repeat(400000) };
  assert.throws(() => backupTexts([{ event: ev, entries: [rec, entry('a2', 2)], revisions: [] }], T, 's', { maxBytes: 1000000 }), e => e.tooLarge && /nichts heruntergeladen/.test(e.message));
});

// Review of the chunk reassembly: tampered chunks are refused cleanly ("nichts importiert"), never an uncaught error.
const chunked = () => {
  const note = 'abc'.repeat(2 * MiB);
  const texts = backupTexts([{ event: ev, entries: [entry('a1', 1, { note })], revisions: [] }], T, 's', { maxBytes: 2000000 });
  return { note, parts: () => texts.map(t => JSON.parse(t)) };
};
const firstChunk = ps => ps.find(p => p.chunks?.length).chunks[0];
const allChunks = ps => ps.flatMap(p => p.chunks || []); // one group: a consistent tampering touches them all
const refused = r => { assert.ok(r.errors?.length, 'refused'); assert.match(r.errors[0], /nichts importiert/); };

test('chunks: a tampered kind, path or field is refused with a German message, in both tools', () => {
  const { parts } = chunked();
  for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope', 5]) {
    const ps = parts();
    for (const c of allChunks(ps)) c.kind = kind;
    let r;
    assert.doesNotThrow(() => { r = combineBackupParts(ps); }, `kind ${String(kind)}`);
    refused(r);
  }
  for (const path of [['__proto__', 'note'], ['constructor', 'prototype'], ['note', '__proto__'], ['prototype'], [1.5], [-1], [null], [{}], [[]], [true], []]) {
    const ps = parts();
    for (const c of allChunks(ps)) c.path = path;
    let r;
    assert.doesNotThrow(() => { r = combineBackupParts(ps); }, JSON.stringify(path));
    refused(r);
  }
  for (const patch of [{ path: 'note' }, { rid: 7 }, { n: '1' }, { n: 1.5 }, { of: 'x' }, { data: 5 }, { data: null }, { n: 0 }, { of: 1e9 }]) {
    const ps = parts();
    Object.assign(firstChunk(ps), patch);
    let r;
    assert.doesNotThrow(() => { r = combineBackupParts(ps); }, JSON.stringify(patch));
    refused(r);
  }
  const bad = parts();
  bad[0].chunks = [null];
  refused(combineBackupParts(bad));
  // the same for Notfunk (throws a plain German Error)
  const m = msg(1, 'kurz');
  m.text = 'y'.repeat(3 * MiB);
  const texts = toBackupTexts({ operation: OP, messages: [m], revisions: [], counters: [] }, T, 'n', { maxBytes: 2000000 });
  const nf = () => texts.map(t => JSON.parse(t));
  for (const patch of [{ kind: '__proto__' }, { kind: 'constructor' }, { path: ['__proto__', 'text'] }, { path: ['text', 'constructor'] }, { path: [1.5] }, { rid: 3 }]) {
    const ps = nf();
    for (const c of allChunks(ps)) Object.assign(c, patch);
    assert.throws(() => nfCombine(ps), e => e instanceof Error && /nichts importiert/.test(e.message), JSON.stringify(patch));
  }
});

test('chunks: a chunk may only fill the empty placeholder of its record', () => {
  const { parts } = chunked();
  const ps = parts();
  const c = firstChunk(ps);
  const e = ps.flatMap(p => p.events).flatMap(x => x.entries).find(x => x.id === c.rid);
  e[c.path[0]] = 'schon belegt'; // the placeholder is gone: the field holds text
  refused(combineBackupParts(ps));
  const ps2 = parts();
  for (const c of allChunks(ps2)) c.path = ['seq']; // a non-string target
  refused(combineBackupParts(ps2));
  const ps3 = parts(); // the same chunk group twice
  const holder = ps3.find(p => p.chunks?.length);
  holder.chunks.push(...holder.chunks.map(x => ({ ...x })));
  refused(combineBackupParts(ps3));
});

test('chunks: lone and split surrogates at a chunk boundary survive exactly', () => {
  for (const at of [999, 1000, 1001, 1999, 2000]) {
    const base = Array.from({ length: 3000 }, () => 'a');
    base[at] = '\ud83d'; // a high surrogate right at / around a boundary
    base[at + 1] = '\ude00'; // its low half: a pair split across chunks when at = 999 or 1999
    const note = base.join('') + '\ud83d'; // and a lone one at the very end
    const texts = backupTexts([{ event: ev, entries: [entry('a1', 1, { note })], revisions: [] }], T, 's', { maxBytes: 1700, chunkChars: 1000 });
    assert.ok(texts.length >= 2);
    const c = combineBackupParts(named(texts).map(f => f.data));
    assert.ok(c.data.events[0].entries[0].note === note, `at ${at}`);
  }
  const lone = '\ude00' + 'b'.repeat(2999);
  const texts = backupTexts([{ event: ev, entries: [entry('a1', 1, { note: lone })], revisions: [] }], T, 's', { maxBytes: 1700, chunkChars: 1000 });
  assert.ok(combineBackupParts(named(texts).map(f => f.data)).data.events[0].entries[0].note === lone);
});

test('chunks: a part may hold only chunks', () => {
  const { note, parts } = chunked();
  const ps = parts();
  assert.ok(ps.some(p => (p.chunks || []).length && p.events.every(e => !e.entries.length && !e.revisions.length)));
  assert.ok(combineBackupParts(ps).data.events[0].entries[0].note === note);
});
