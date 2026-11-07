// The Wavelog API v2 client of the import page: every network request of
// this tool is made here (see AGENTS.md, "API call inventory"). The token
// is passed in per call and never stored. fetch, sleep and the deadline
// are injectable for the node tests; no AbortSignal.timeout()/any() (not on
// the browser floor, tools/shared/README.md).

export const WAVELOG_TIMEOUT_MS = 30000;
export const WAVELOG_PER_PAGE = 1000;       // the API allows up to 5000
export const WAVELOG_MAX_PAGES = 2000;      // 2 million QSOs: stop, not loop
export const WAVELOG_MAX_RETRY_WAIT_S = 60;
const WAVELOG_RETRIES = 3;

export class WavelogError extends Error {
  // code: the API's error code, or network | timeout | aborted | bad-response
  constructor(code, status = 0, extra = {}) {
    super(code);
    this.name = 'WavelogError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// The address the user typed -> "https://host/path/" (http only for
// localhost), no user/password, no query; '' when it is none.
export function wavelogBase(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (u.username || u.password) return '';
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return '';
  u.search = '';
  u.hash = '';
  let href = u.href.replace(/\/api(\/v2)?\/?$/, '/');
  if (!href.endsWith('/')) href += '/';
  return href;
}

export const wavelogDefaultSleep = ms => new Promise(r => setTimeout(r, ms));

// One GET with a deadline and the caller's abort signal; resolves to the
// parsed JSON body. 429 waits Retry-After (capped) and tries again.
export async function wavelogGet(base, path, {
  token, params = {}, signal = null, fetchFn = globalThis.fetch.bind(globalThis),
  sleep = wavelogDefaultSleep, timeoutMs = WAVELOG_TIMEOUT_MS, onWait = null,
} = {}) {
  const url = new URL(`api/v2/${path}`, base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    if (signal && signal.aborted) throw new WavelogError('aborted');
    const ctl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    let res;
    try {
      res = await fetchFn(url.href, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: ctl.signal,
      });
      if (res.status === 429 && attempt < WAVELOG_RETRIES) {
        const wait = Math.min(WAVELOG_MAX_RETRY_WAIT_S, Math.max(1, Number(res.headers && res.headers.get && res.headers.get('Retry-After')) || 5));
        if (onWait) onWait(wait);
        await sleep(wait * 1000);
        continue;
      }
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) {
        const err = body && body.error;
        throw new WavelogError((err && err.code) || `http-${res.status}`, res.status, { required: err && err.details && err.details.required_scope });
      }
      if (!body || typeof body !== 'object') throw new WavelogError('bad-response', res.status);
      return body;
    } catch (e) {
      if (e instanceof WavelogError) throw e;
      if (timedOut) throw new WavelogError('timeout');
      if (signal && signal.aborted) throw new WavelogError('aborted');
      throw new WavelogError('network');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

// [{ id, name, stationIds }] (GET /api/v2/logbook, scope logbook:read)
export async function wavelogLogbooks(base, opts) {
  const body = await wavelogGet(base, 'logbook', opts);
  if (!Array.isArray(body.data)) throw new WavelogError('bad-response');
  return body.data.filter(l => l && l.id != null).map(l => ({
    id: l.id,
    name: String(l.name ?? l.id),
    stationIds: Array.isArray(l.station_ids) ? l.station_ids.filter(x => x != null) : [],
  }));
}

// The scopes of the token (GET /api/v2/token), or null when unreadable.
export async function wavelogTokenScopes(base, opts) {
  try {
    const body = await wavelogGet(base, 'token', opts);
    const d = body.data || {};
    const scopes = d.scopes || d.scope;
    return Array.isArray(scopes) ? scopes.map(String) : (typeof scopes === 'string' ? scopes.split(/[\s,]+/).filter(Boolean) : null);
  } catch {
    return null;
  }
}

// All QSOs of the stations, page after page (newest first), handing every
// page to onPage(qsos, { page, total }). Resolves to the number fetched.
// perPage is clamped to 1..5000.
export async function wavelogQsos(base, stationIds, { perPage = WAVELOG_PER_PAGE, onPage = null, ...opts } = {}) {
  const per = Math.min(5000, Math.max(1, Math.floor(perPage)));
  let fetched = 0;
  for (let page = 1; page <= WAVELOG_MAX_PAGES; page++) {
    const body = await wavelogGet(base, 'qso', { ...opts, params: { station_id: stationIds.join(','), page, per_page: per, format: 'json' } });
    if (!Array.isArray(body.data)) throw new WavelogError('bad-response');
    const meta = body.meta || {};
    fetched += body.data.length;
    if (onPage) await onPage(body.data, { page, total: Number(meta.total) || fetched });
    if (!meta.has_more || !body.data.length) return fetched;
  }
  throw new WavelogError('too-many-pages');
}
