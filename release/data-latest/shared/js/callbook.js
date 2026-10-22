// Austrian callsign list (tools/shared/data/callsigns-oe.json, built by
// scripts/fetch_callsigns.py from the Fernmeldebüro's Rufzeichenliste).
// Pure functions — unit-tested in oe1ebg/tests/.

export function buildCallbook(data) {
  if (!data || !Array.isArray(data.calls)) return null;
  const calls = data.calls.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const byCall = new Map(calls.map(c => [c[0], c]));
  // Suffix (the part after "OE<digit>") -> calls, for "ABC" / "1ABC" input.
  const bySuffix = new Map();
  for (const c of calls) {
    const m = /^OE\d([A-Z0-9]+)$/.exec(c[0]);
    if (!m) continue;
    if (!bySuffix.has(m[1])) bySuffix.set(m[1], []);
    bySuffix.get(m[1]).push(c);
  }
  return { stand: data.stand || '', source: data.source || '', calls, byCall, bySuffix };
}

// "OE1EBG/P" -> "OE1EBG", "HB9/OE1EBG" -> "OE1EBG", "DL/OE1EBG/M" -> "OE1EBG".
// For non-OE calls returns the longest segment (the actual callsign).
export function baseCall(call) {
  const parts = String(call || '').toUpperCase().replace(/\s+/g, '').split('/').filter(Boolean);
  const oe = parts.find(p => /^OE\d/.test(p));
  if (oe) return oe;
  return parts.reduce((a, b) => (b.length > a.length ? b : a), '');
}

export function isOECall(call) {
  return /^OE\d[A-Z0-9]*[A-Z]$/.test(baseCall(call));
}

// { entry: [call, name, location] | null, base, isOE }
export function lookupCall(book, call) {
  const base = baseCall(call);
  return { entry: book ? book.byCall.get(base) || null : null, base, isOE: isOECall(call) };
}

// Damerau-Levenshtein distance <= 1 (one substitution, insertion, deletion
// or adjacent transposition) — the typical callsign typo.
export function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function lowerBound(calls, key) {
  let lo = 0, hi = calls.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (calls[mid][0] < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Suggestions for a partial, abbreviated or mistyped callsign, best first:
//   "1ABC" -> OE1ABC, then OE<any digit>ABC; "ABC" -> OE<any digit>ABC;
//   then calls whose suffix starts with the letters, prefix matches, and
//   one-edit-away matches. Excludes an exact match.
export function suggestCalls(book, partial, max = 8) {
  const q = baseCall(partial);
  if (!book || q.length < 2) return [];
  const out = [];
  const seen = new Set([q]);
  const add = c => {
    if (c && !seen.has(c[0]) && out.length < max) { seen.add(c[0]); out.push(c); }
  };
  const short = /^(\d)?([A-Z][A-Z0-9]{0,4})$/.exec(q);
  if (short && !q.startsWith('OE')) {
    const [, digit, suffix] = short;
    if (digit) add(book.byCall.get(`OE${q}`));
    for (const c of book.bySuffix.get(suffix) || []) add(c);
    if (suffix.length >= 2) {
      const wanted = digit ? `OE${q}` : null;
      for (let i = wanted ? lowerBound(book.calls, wanted) : 0; i < book.calls.length && out.length < max; i++) {
        const c = book.calls[i];
        if (wanted ? !c[0].startsWith(wanted) : false) break;
        const m = /^OE\d(.*)$/.exec(c[0]);
        if (m && m[1].startsWith(suffix)) add(c);
      }
    }
  }
  if (q.length < 3) return out;
  for (let i = lowerBound(book.calls, q); i < book.calls.length && out.length < max; i++) {
    const c = book.calls[i];
    if (!c[0].startsWith(q)) break;
    add(c);
  }
  if (q.length >= 4) {
    for (const c of book.calls) {
      if (out.length >= max) break;
      if (withinOneEdit(q, c[0])) add(c);
    }
  }
  return out;
}

// Name/place text for searching: lower case, without accents.
function callbookFold(text) {
  return String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Entries for what someone types into a callsign field: part of a callsign
// ("OE1EB", "1ABC", "ABC"), a name or a place. Best first: the exact call,
// calls starting with the input, abbreviated/mistyped forms
// (suggestCalls()), then names and places containing it (3+ letters).
export function searchCallbook(book, query, max = 8) {
  const q = String(query ?? '').trim();
  if (!book || q.length < 2) return [];
  const out = [];
  const seen = new Set();
  const add = c => {
    if (c && !seen.has(c[0]) && out.length < max) { seen.add(c[0]); out.push(c); }
  };
  if (/^[A-Za-z0-9/]+$/.test(q)) {
    const call = baseCall(q);
    add(book.byCall.get(call));
    for (let i = lowerBound(book.calls, call); i < book.calls.length && book.calls[i][0].startsWith(call); i++) add(book.calls[i]);
    for (const c of suggestCalls(book, q, max)) add(c);
  }
  if (q.length >= 3 && /[A-Za-zÄÖÜäöüß]/.test(q)) {
    const needle = callbookFold(q);
    for (const c of book.calls) {
      if (out.length >= max) break;
      if (callbookFold(c[1]).includes(needle) || callbookFold(c[2]).includes(needle)) add(c);
    }
  }
  return out;
}

// Callsign as typed -> canonical form (upper case, no spaces or stray
// characters).
export function normalizeCall(raw) {
  return String(raw ?? '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9/]/g, '');
}

// Loose amateur callsign check (optional prefix/ and /suffix). Only used for a
// soft warning — logging is never blocked by it.
const CALL_RE = /^(?:[A-Z0-9]{1,4}\/)?[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](?:\/[A-Z0-9]{1,4})?$/;

export function isPlausibleCall(call) {
  return CALL_RE.test(call);
}
