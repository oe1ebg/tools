// Fuzzy matching over the compact search vocabulary (~25k keys: street
// names, places, aliases, districts) — never over individual addresses.
// Candidate generation by trigram overlap (Dice), refined by an
// optimal-string-alignment (Damerau-Levenshtein) similarity.

function trigramsOf(key) {
  const s = `  ${key} `;
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

export function buildTrigramIndex(keys) {
  const grams = new Map();
  const sizes = new Uint16Array(keys.length);
  keys.forEach((k, id) => {
    const g = trigramsOf(k);
    sizes[id] = g.size;
    for (const t of g) {
      let list = grams.get(t);
      if (!list) grams.set(t, (list = []));
      list.push(id);
    }
  });
  return { keys, grams, sizes };
}

// Top `limit` key ids by Dice coefficient of trigram sets.
export function trigramCandidates(index, query, limit = 200) {
  const qg = trigramsOf(query);
  const counts = new Map();
  for (const t of qg) {
    const list = index.grams.get(t);
    if (!list) continue;
    for (const id of list) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const scored = [];
  for (const [id, c] of counts) scored.push([id, (2 * c) / (qg.size + index.sizes[id])]);
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, limit);
}

export function osaDistance(a, b) {
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  let prev2 = null, prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
    }
    [prev2, prev, cur] = [prev, cur, prev2 || new Array(lb + 1)];
  }
  return prev[lb];
}

// 0..1, 1 = identical.
export function nameSimilarity(a, b) {
  const m = Math.max(a.length, b.length);
  return m ? 1 - osaDistance(a, b) / m : 1;
}
