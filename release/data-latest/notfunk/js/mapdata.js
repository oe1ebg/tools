// Which messages the Notfunk map shows and where (pure, node-tested in
// tests/notfunk-map.test.mjs). A message's place is its Ort (`location`, the
// snapshot the location field stored when it was resolved); a message
// that has only the text of an Ort is placed when that text resolves
// confidently now (`resolved`: Map text -> location or null, filled by the
// caller from the offline index). Deleted messages are never on the map.

const placeOf = loc => (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon) ? loc : null);

// msgs: the messages to show (the book's current list); resolved: Map.
// -> { placed: [{ msg, loc, fromText }], unplaced: [msg] (an Ort that
// doesn't resolve), noPlace: n (messages without any Ort) }
export function messagesForMap(msgs, resolved = new Map()) {
  const placed = [], unplaced = [];
  let noPlace = 0;
  for (const msg of msgs) {
    if (msg.deleted) continue;
    const stored = placeOf(msg.location);
    if (stored) { placed.push({ msg, loc: stored, fromText: false }); continue; }
    const text = String(msg.locationText || '').trim();
    if (!text) { noPlace++; continue; }
    const loc = placeOf(resolved.get(text));
    if (loc) placed.push({ msg, loc, fromText: true });
    else unplaced.push(msg);
  }
  return { placed, unplaced, noPlace };
}

// The texts still to look up (the caller resolves each once).
export function placeTextsToResolve(msgs, resolved = new Map()) {
  const out = new Set();
  for (const msg of msgs) {
    if (msg.deleted || placeOf(msg.location)) continue;
    const text = String(msg.locationText || '').trim();
    if (text && !resolved.has(text)) out.add(text);
  }
  return [...out];
}

// Several messages at one place share one pin (a number on it), newest
// first in its card. -> [{ loc, items: [{ msg, fromText }] }]
export function groupByPlace(placed) {
  const groups = new Map();
  for (const p of placed) {
    const key = `${p.loc.lat.toFixed(5)},${p.loc.lon.toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, { loc: p.loc, items: [] });
    groups.get(key).items.push({ msg: p.msg, fromText: p.fromText });
  }
  for (const g of groups.values()) g.items.sort((a, b) => (a.msg.ts < b.msg.ts ? 1 : -1));
  return [...groups.values()];
}

// The most pressing priority of a pin's messages: its colour.
// model.js PRIORITIES: routine, priority ("Dringend"), emergency ("Notfall")
const PRIORITY_RANK = { emergency: 3, priority: 2, routine: 1 };
export function pinPriority(items) {
  let best = 'routine';
  for (const { msg } of items) if ((PRIORITY_RANK[msg.priority] || 0) > PRIORITY_RANK[best]) best = msg.priority;
  return best;
}
