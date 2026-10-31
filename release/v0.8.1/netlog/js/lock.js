// One writing tab per session. With Web Locks the tab that opens a session
// takes the lock `oe1ebg-netlog-session-<id>`; another tab opening the same
// session gets none and is read-only until the user picks "Edit here"
// (which steals the lock; the first tab then turns read-only). Without Web
// Locks (plain http://) a BroadcastChannel claim does the same for tabs
// that can hear each other. Either way the writer also stores its tab id
// in the session (ops.js claimSession), and every write checks it, so a
// tab that missed the handover cannot overwrite: it gets a LeaseError.

import { claimSession } from './ops.js';

export const CHANNEL_NAME = 'oe1ebg-netlog';
const LOCK_PREFIX = 'oe1ebg-netlog-session-';

// opts: store, tab (this tab's id), onChange(readOnly, reason) with reason
// 'other-tab' (opened elsewhere), 'taken' (another tab took over), or null.
export function createSessionLock({ store, tab, onChange, channel }) {
  let held = null; // { sessionId, release }
  let wanted = null;
  const locks = globalThis.navigator && globalThis.navigator.locks;

  const writable = async sessionId => {
    await claimSession(store, sessionId, tab);
    if (wanted === sessionId) onChange(false, null);
  };

  async function acquire(sessionId, steal = false) {
    release();
    wanted = sessionId;
    if (locks) {
      return new Promise(resolve => {
        locks.request(LOCK_PREFIX + sessionId, steal ? { steal: true } : { ifAvailable: true }, lock => {
          if (wanted !== sessionId) return undefined;
          if (!lock) {
            onChange(true, 'other-tab');
            resolve(false);
            return undefined;
          }
          return new Promise(rel => {
            held = { sessionId, release: rel };
            writable(sessionId).then(() => resolve(true), e => { console.warn(e); onChange(true, 'taken'); resolve(false); });
          });
        }).catch(() => {
          // stolen by another tab
          if (held && held.sessionId === sessionId) held = null;
          if (wanted === sessionId) onChange(true, 'taken');
        });
      });
    }
    // no Web Locks: ask the other tabs (if they can hear us)
    if (channel && !steal) {
      const busy = await new Promise(resolve => {
        const timer = setTimeout(() => { channel.removeEventListener('message', on); resolve(false); }, 300);
        function on(ev) {
          const d = ev.data || {};
          if (d.type === 'held' && d.sessionId === sessionId && d.tab !== tab) {
            clearTimeout(timer);
            channel.removeEventListener('message', on);
            resolve(true);
          }
        }
        channel.addEventListener('message', on);
        channel.postMessage({ type: 'claim', sessionId, tab });
      });
      if (busy) { onChange(true, 'other-tab'); return false; }
    }
    if (channel && steal) channel.postMessage({ type: 'takeover', sessionId, tab });
    held = { sessionId, release: () => {} };
    try {
      await writable(sessionId);
      return true;
    } catch (e) {
      console.warn(e);
      onChange(true, 'taken');
      return false;
    }
  }

  function release() {
    if (held) {
      held.release();
      held = null;
    }
    wanted = null;
  }

  // Messages of other tabs (no Web Locks): answer claims, give way to a
  // takeover.
  function onMessage(d) {
    if (locks || !held || d.tab === tab || d.sessionId !== held.sessionId) return;
    if (d.type === 'claim') channel.postMessage({ type: 'held', sessionId: d.sessionId, tab });
    if (d.type === 'takeover') {
      held = null;
      onChange(true, 'taken');
    }
  }

  return { acquire, release, onMessage, hasWebLocks: !!locks, holds: id => !!held && held.sessionId === id };
}
