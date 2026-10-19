# Wavelog import

Brings the QSOs of one [Wavelog](https://www.wavelog.org/) logbook onto this
device, into the shared callsign store (`tools/shared/README.md`, "Callsign
store"), so that Netlog can offer name, QTH, grid and "already worked"
offline. **Online only**: the one tool, besides the SOTA Alerts Map, that
makes requests, and only when you start an import. Confirm, Notfunk and
Netlog stay offline. Nothing is written to Wavelog.

## Using it

1. In Wavelog: user menu → API → create a **v2 token** with exactly the
   scopes `logbook:read` and `qso:read` and an expiry. Wavelog 3.1.0 or
   later (older v1 keys are not accepted by the v2 API).
2. Open the page, enter the address of your instance (https; http only for
   localhost, no user name or password) and the token, "Load logbooks".
3. Choose a logbook, "Import". A cancelled or failed import keeps what was
   stored; run it again to complete it (the same QSO replaces its record).
4. In Netlog, "Backup and data" → "Callsign lists" shows the import as a
   list of its own; order, switching off and erasing work like for any list.

The token lives in its input field only: it is not written to IndexedDB,
localStorage or any backup, and is cleared after a successful import. The
address is remembered (the key Netlog uses for its Wavelog link).

## What is stored

In `oe1ebg-callsigns` (schema version 2, added the `qsos` store; version 1
data is kept):

- `qsos`: one record per QSO (`wavelog:<instance>:<logbook>:<Wavelog id>`):
  callsign, ISO date and time (UTC), band, mode (submode first), name, QTH,
  grid. Re-importing upserts by the Wavelog id. QSOs deleted in Wavelog are
  not removed here; erasing the list removes them all.
- a summary per callsign as an ordinary source (kind `wavelog`): name, QTH
  and grid of the most recent QSO that has them, and a note "N QSO, date of
  the last". This is what the merged lookup reads.

Network imports are **not part of any backup**. A net check-in is not a QSO
and nothing is sent back.

## API (Wavelog v2, `js/wavelog.js`)

| Request | When | Safeguards |
| --- | --- | --- |
| `GET api/v2/logbook` (`logbook:read`) | "Load logbooks" | 30 s deadline |
| `GET api/v2/token` | right after, best effort | scopes shown as a warning only |
| `GET api/v2/qso?station_id=…&page=n&per_page=1000&format=json` (`qso:read`) | "Import", page after page until `has_more` is false | 30 s deadline per page; at most 2000 pages; cancel button; `429` waits `Retry-After` (at most 60 s, three times) |

`Authorization: Bearer <token>`, no cookies (`credentials: omit`), no
referrer. The API sends `Access-Control-Allow-Origin: *`. The QSO list is
newest first; the whole logbook is fetched each time (`since_id` would allow
an incremental import, not used yet). Fields used: `id`, `call`, `qso_date`,
`band`, `mode`, `submode`, `name`, `qth`, `gridsquare`; the docs do not
promise `qth`, so check against your instance.

## Deployment

The page needs `connect-src https:` (the address is typed in and cannot be
listed): its own location in `deploy/nginx.conf.example` and
`deploy/htaccess.example`, tested in `tests/deploy-headers.test.mjs`. An
`http://` instance is blocked as mixed content by an https page (except
localhost).

## Tests

`tests/wavelog-import.test.mjs` (client with a stubbed `fetch`, mapping,
summary, store migration), `tests/e2e/wavelog-import.spec.mjs` (the page
against a stubbed instance).
