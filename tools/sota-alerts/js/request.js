// Request deadlines and "latest wins" cancellation for every fetch of the
// tool (api.js). Pure (AbortController + setTimeout only), node-tested.
//
// AbortSignal.timeout() and AbortSignal.any() would do this, but they are
// not on the whole browser floor (Safari 15.4 / Firefox 115 / Chrome 109,
// tools/shared/README.md), so the caller's signal and the timeout are
// combined by hand.

// Deadlines (ms). The SOTA API answers in well under a second when it is
// up; these only stop a hung request from stalling the page forever.
// The same-origin data files are large (summit-lookup.json ~9.8MB,
// summits.json ~17.7MB uncompressed) and may legitimately take minutes on
// a slow mobile link, so they get no total deadline, only a stall timeout:
// DATA_STALL_MS without a single byte arriving.
export const ALERTS_TIMEOUT_MS = 20_000;
export const SUMMIT_TIMEOUT_MS = 15_000;
export const SEARCH_TIMEOUT_MS = 15_000;
export const DATA_STALL_MS = 30_000;

export class TimeoutError extends Error {
  constructor(ms, stalled = false){
    super(stalled ? `no data for ${Math.round(ms / 1000)} s` : `timed out after ${Math.round(ms / 1000)} s`);
    this.name = 'TimeoutError';
  }
}

export function abortError(){
  return new DOMException('The operation was aborted.', 'AbortError');
}

export const isAbort = err => !!err && err.name === 'AbortError';

// run(signal, touch) -> Promise. Settles with run's result, or rejects
// with a TimeoutError once `ms` have passed, or with an AbortError as soon
// as the caller's `signal` aborts — whichever comes first, even if run()
// ignores the signal. The signal handed to run() aborts in both cases, so
// a fetch (and the reading of its body) is cancelled with it.
// touch() restarts the timer: called on progress (readJson() below), `ms`
// is a stall timeout instead of a total deadline (`stall: true` only
// changes the error message).
export function withDeadline(ms, signal, run, { setTimer = setTimeout, clearTimer = clearTimeout, stall = false } = {}){
  if (signal && signal.aborted) return Promise.reject(abortError());
  const controller = new AbortController();
  let timer = null;
  let onCallerAbort = null;
  let onTimeout = null;
  let settled = false;
  const stopped = new Promise((resolve, reject) => {
    onTimeout = () => { reject(new TimeoutError(ms, stall)); controller.abort(); };
    timer = setTimer(onTimeout, ms);
    if (signal){
      onCallerAbort = () => { reject(abortError()); controller.abort(); };
      signal.addEventListener('abort', onCallerAbort);
    }
  });
  const touch = () => {
    if (settled) return;
    clearTimer(timer);
    timer = setTimer(onTimeout, ms);
  };
  let work;
  try { work = Promise.resolve(run(controller.signal, touch)); }
  catch (err) { work = Promise.reject(err); }
  // whichever loses the race must not become an unhandled rejection
  work.catch(() => {});
  stopped.catch(() => {});
  return Promise.race([work, stopped]).finally(() => {
    settled = true;
    clearTimer(timer);
    if (onCallerAbort) signal.removeEventListener('abort', onCallerAbort);
  });
}

// A fetch Response's JSON body, read chunk by chunk with touch() on every
// chunk (withDeadline's stall timeout). Without a readable body stream:
// res.json().
export async function readJson(res, touch = () => {}){
  if (!res.body || typeof res.body.getReader !== 'function') return res.json();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;){
    const { done, value } = await reader.read();
    if (done) break;
    touch();
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
}

// "Latest wins" for one kind of request (the summit search): begin()
// aborts whatever the previous begin() started and returns a token whose
// isCurrent() is false from then on; cancel() does the same without
// starting anything. Check isCurrent() after every await before touching
// shared state — the abort alone doesn't cover a result that already
// arrived, or work that doesn't take a signal.
export function createLatest(){
  let current = null;
  return {
    begin(){
      if (current) current.abort();
      const controller = new AbortController();
      current = controller;
      return { signal: controller.signal, isCurrent: () => current === controller };
    },
    cancel(){
      if (current) current.abort();
      current = null;
    },
  };
}

// A one-at-a-time guard for user-triggered operations (the two refresh
// buttons, start-up): run(task) runs task() unless one is already running,
// in which case it returns null without starting anything. onBusy(bool)
// is called when the guard is taken and released (also after an error),
// so the controls can be disabled and are always re-enabled.
export function createExclusive(onBusy = () => {}){
  let running = false;
  return {
    busy: () => running,
    async run(task){
      if (running) return null;
      running = true;
      onBusy(true);
      try { return await task(); }
      finally {
        running = false;
        onBusy(false);
      }
    },
  };
}
