// Runs a long job in slices so the page stays responsive, and lets it be
// cancelled or superseded. A job is a generator (function*) that yields
// now and then (a progress value, or nothing) and returns its result: the
// pure ADIF code (parseADIFSteps, validateAdifSteps, ...) is written that
// way, and its synchronous twins run the very same generator to the end.
// Pure apart from the timers: no DOM, node-testable.
//
// A job never applies anything itself: it returns a value, and whoever
// started it decides what to do with it once it is finished. That is what
// makes a cancelled or failed job leave no partial state behind.

// "Give the event loop a turn": a macrotask, as short as the browser
// allows. MessageChannel is not clamped to 4 ms like nested timeouts and
// not throttled to once a second in a background tab; requestIdleCallback
// would not do (not in Safari, and it only schedules, it cannot interrupt).
// Outside a page (node tests) setTimeout is used: a MessageChannel there
// would keep the process alive.
let chunkedChannel = null;
const chunkedWaiting = [];
export function chunkedTick() {
  if (typeof MessageChannel === 'undefined' || typeof document === 'undefined') {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  if (!chunkedChannel) {
    chunkedChannel = new MessageChannel();
    chunkedChannel.port1.onmessage = () => { const next = chunkedWaiting.shift(); if (next) next(); };
  }
  return new Promise(resolve => { chunkedWaiting.push(resolve); chunkedChannel.port2.postMessage(0); });
}

export function chunkedAbortError() {
  const e = new Error('cancelled');
  e.name = 'AbortError';
  return e;
}

export function chunkedIsAbort(e) {
  return !!e && e.name === 'AbortError';
}

// Runs `gen` in slices of about `budget` ms, then hands the thread back
// (opts.tick, default chunkedTick) and goes on. onProgress(value) gets the
// last value the job yielded in each slice. opts.signal (AbortSignal-like:
// an object with `aborted`) stops it at the next slice: the returned
// promise rejects with an AbortError, the generator is closed, and nothing
// of it is returned. Resolves with the generator's return value.
export async function chunkedRun(gen, opts = {}) {
  const { budget = 12, onProgress, signal } = opts;
  const tick = opts.tick || chunkedTick;
  try {
    for (;;) {
      if (signal && signal.aborted) throw chunkedAbortError();
      const t0 = performance.now();
      let last;
      for (;;) {
        const r = gen.next();
        if (r.done) return r.value;
        if (r.value !== undefined) last = r.value;
        if (performance.now() - t0 >= budget) break;
      }
      if (onProgress && last !== undefined) onProgress(last);
      await tick();
    }
  } finally {
    gen.return(undefined); // closes a job that was cancelled or threw
  }
}

// One job at a time, the newest wins: start() cancels the one running
// (its promise rejects with an AbortError, which chunkedIsAbort() tells
// from a real failure) and runs the new one.
export class ChunkedSlot {
  constructor() {
    this.controller = null;
  }

  get running() {
    return this.controller !== null;
  }

  cancel() {
    if (this.controller) this.controller.aborted = true;
    this.controller = null;
  }

  start(gen, opts = {}) {
    this.cancel();
    const mine = { aborted: false };
    this.controller = mine;
    return chunkedRun(gen, { ...opts, signal: mine }).finally(() => {
      if (this.controller === mine) this.controller = null;
    });
  }
}
