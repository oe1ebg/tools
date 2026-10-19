# AGENTS.md — Wavelog import

Apply the root `AGENTS.md`; read `tools/wavelog-import/README.md` and, for the
store, `tools/shared/README.md` ("Callsign store"). Paths are relative to the
repository root. This is an online-only page.

## Request policy

- Requests only in `tools/wavelog-import/js/wavelog.js` (the deploy test
  fails on any other file with `fetch`), only from a click, never on page
  load. Keep the inventory in the README in step with endpoints and
  safeguards: deadlines, abort, `Retry-After`, the page limit.
- The token is never stored: not in IndexedDB, localStorage, prefs, URLs,
  logs, or a backup. Keep it out of error messages. Read-only scopes
  (`logbook:read`, `qso:read`); nothing is ever written to Wavelog.
- The CSP for this page is the only one with `connect-src https:`; keep it
  in both deploy examples and the header test.

## Data

- The store schema lives in `tools/shared/js/callsign-store.js`; a change is
  a version bump with a data-preserving `upgrade()`. Network imports stay
  out of backups. Re-imports upsert by the Wavelog id; a failed or
  cancelled import keeps what was stored and rebuilds the summary from it.
- Tests stub every request (the e2e fixture fails on foreign requests);
  synthetic callsigns (`OE0QX…`) and fictitious names only.
