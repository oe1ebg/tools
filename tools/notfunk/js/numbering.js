// Message numbers: "<station prefix>-<running number>", e.g. "W1-007".
//
// Rules (issue #31): per operation and station prefix the numbers are
// gapless and monotonic, and a number is never reused — not after a delete
// (deletes are soft, the record keeps its number), an edit (the number is
// part of the record, never recomputed) or a restore (see
// counterAfterImport()). Several devices in one operation each use their
// own prefix, so their numbers can't collide and their logs merge cleanly.
//
// A number is taken only when the message is saved, in the same storage
// transaction that writes the message and the counter (saveNumbered()), so
// a failed save consumes no number and two tabs can't take the same one
// (IndexedDB: one readwrite transaction; localStorage fallback: the
// cross-tab write lock and an all-or-nothing batch, see the storage
// contract in tools/shared/README.md). The next number is the higher of the
// counter and the highest stored number + 1, so a lost counter never makes
// a number come round again.

export const PREFIX_RE = /^[A-Z0-9]{1,6}$/;

export function normalizePrefix(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function formatNumber(prefix, seq) {
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

// "W1-007" -> { prefix: 'W1', seq: 7 }; null for anything else.
export function parseNumber(text) {
  const m = /^([A-Z0-9]{1,6})-(\d{1,6})$/.exec(String(text ?? '').trim().toUpperCase());
  return m ? { prefix: m[1], seq: Number(m[2]) } : null;
}

export function counterKey(opId, prefix) {
  return `${opId}:${prefix}`;
}

// The next running number for prefix, given the stored counter (or
// undefined) and all records of the operation (deleted ones included).
export function nextSeq(counter, records, prefix) {
  let last = counter?.last || 0;
  for (const r of records) if (r.prefix === prefix && r.seq > last) last = r.seq;
  return last + 1;
}

// Saves a new numbered record in one transaction: build({ prefix, seq,
// number }) returns the record (it must carry eventId = opId, prefix, seq).
// Resolves to the saved record. stores: [recordStore, 'counters'].
export function saveNumbered(store, { opId, prefix, recordStore }, build) {
  if (!PREFIX_RE.test(prefix)) return Promise.reject(new Error(`Ungültiges Stationskürzel: ${prefix}`));
  return store.atomic([recordStore, 'counters'], async ({ get, getByEvent, put }) => {
    const key = counterKey(opId, prefix);
    const counter = await get('counters', key);
    const records = await getByEvent(recordStore, opId);
    const seq = nextSeq(counter, records, prefix);
    const rec = build({ prefix, seq, number: formatNumber(prefix, seq) });
    if (rec.eventId !== opId || rec.prefix !== prefix || rec.seq !== seq) throw new Error('build() must keep eventId, prefix and seq');
    put(recordStore, rec);
    put('counters', { id: key, eventId: opId, prefix, last: seq });
    return rec;
  });
}

// Counters to store after importing records (a backup restore or another
// device's export): per prefix the highest number seen — never lower than
// an existing counter, so numbers handed out after the backup was taken are
// not reused either.
export function counterAfterImport(existingCounters, records, opId) {
  const byPrefix = new Map();
  for (const c of existingCounters) if (c.eventId === opId) byPrefix.set(c.prefix, c.last);
  for (const r of records) {
    if (r.eventId !== opId) continue;
    if (!byPrefix.has(r.prefix) || r.seq > byPrefix.get(r.prefix)) byPrefix.set(r.prefix, r.seq);
  }
  return [...byPrefix].map(([prefix, last]) => ({ id: counterKey(opId, prefix), eventId: opId, prefix, last }));
}

// Gaps in the stored numbers per prefix (should never happen; shown as a
// warning in the message book and checked by the tests).
export function numberGaps(records) {
  const seen = new Map();
  for (const r of records) {
    if (!seen.has(r.prefix)) seen.set(r.prefix, new Set());
    seen.get(r.prefix).add(r.seq);
  }
  const gaps = [];
  for (const [prefix, set] of seen) {
    const max = Math.max(...set);
    for (let i = 1; i <= max; i++) if (!set.has(i)) gaps.push(formatNumber(prefix, i));
  }
  return gaps;
}
