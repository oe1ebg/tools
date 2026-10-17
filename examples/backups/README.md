# Fictional backup examples

These JSON files can be imported through each tool's **Sicherung
importieren… / Import backup…** control. Download the raw JSON file from
GitHub, then select it in the matching tool. Each tool has its own backup
format; the files are not interchangeable. These are repository examples,
not assets included in the deployed apps or release bundle.

| Tool | Small example | Fuller dataset |
| --- | --- | --- |
| Netlog | [netlog-example.json](netlog-example.json): one session, three speaking rounds | [netlog-full.json](netlog-full.json): 3 series, 12 sessions, 39 speaking rounds, 14 station profiles, 261 notes |
| Bestätigungsverkehr (Confirm) | [confirm-example.json](confirm-example.json): one reception log, 13 check-ins | [confirm-full.json](confirm-full.json): 3 reception logs and 1 warning-system exercise survey, 51 check-ins plus operator comments |
| Notfunk-Meldebuch (draft) | [notfunk-example.json](notfunk-example.json): a separate exercise with 6 messages | [notfunk-full.json](notfunk-full.json): one exercise with 30 messages |

Start with a small example or the fuller dataset. The Netlog and Confirm
small examples are subsets of their full files. Netlog skips unchanged
sessions on repeated imports; changed sessions import as copies. Confirm
imports a copy when an ID is already present, including when importing the
full file after its small example. The two Notfunk files have distinct
operation and message IDs, so they can be tried independently. Notfunk
merges by message ID and modification time and preserves message counters.

## What to try

**Netlog:** recurring fictional stations discuss a miniature lighthouse,
a garden weather display, a sound workshop and invented paper maps. Names
and callsigns stay consistent across the series. The data includes all
three speaking styles (central control, round-robin and free-form), net
control handovers, pauses and reentries, monitoring, reception problems,
prepared responses, completed responses, personal talking points,
after-net tasks and edited-note revisions. Nine sessions are finished;
three are left open to try the live controls. Undo history and unfinished
editor drafts are empty.

**Confirm:** the reception logs contain brief check-ins, names, fictional
QTH values, varied sent/received reports and repeat check-ins. The fourth
log uses the Zivilschutz-Probealarm template with simulated siren grades
and AT-Alert answers. Operator comments identify the exercise and mark
the beginning and end. This dataset is for confirmations and structured
observations rather than long conversations.

**Notfunk:** an explicitly fictional logistics exercise at a model park
contains incoming requests, outgoing replies and follow-up reports. Try
the message references, delivery-state filters, read-back flags, a failed
transmission attempt and radio/telephone/messenger channels. Message
numbers and the staff's separate reference numbers are both populated.
The next message number is `D1-031` in the full exercise and `D1-007` in the
small exercise. Every message says **ÜBUNG – KEIN REALEINSATZ**. Receipt or
delivery status does not establish that an instruction was carried out.

## Fictional identities and stories

The examples were inspired by the general shape of a handwritten radio-net
log: recurring stations, short check-ins, several speaking rounds,
technical observations and follow-up questions. All stories were written
afresh. Names, dates, series titles, places and callsigns are synthetic;
there is no original-to-fictional identity key. This is test data, not a
reconstruction of real attendance or statements. The source log is not
included.

The callsigns follow Netlog's `OE0QX…` example convention and are not
presented as assigned callsigns. A fictional name, QTH and member code
stay attached to each synthetic identity across the three tools. No real
coordinates, locators, postal addresses, phone numbers, email addresses or
source URLs are included. All scenario timestamps are invented and stored
in UTC. The German notes are intentional user content and are not
translated by switching the app language.

## Validation

Run from the repository root:

```sh
node --test tests/demo-backups.test.mjs
```

The tests read these committed files and check the native validators and
restore paths, including reference preservation and repeat imports.
Netlog and Notfunk are restored through their operations into an isolated
in-memory store; Confirm's import plan is applied to the same test storage
API. No existing browser storage is accessed. These checks do not replace
a browser test of the import controls.

## Tests

- `tests/demo-backups.test.mjs` (Node, `just test`): each file passes its
  tool's validator and restores losslessly in memory; repeated imports
  change nothing.
- `tests/e2e/examples.spec.mjs` (browsers, `just e2e`): each file goes
  through the real import dialog into an empty browser profile and shows
  what is described above (counts, series summaries, the next Notfunk
  number). It is then exported with the tool's own backup and restored into
  another empty profile with the same result. For Netlog, one series is
  also backed up and restored alone.

Both run in CI for every change to these files (`ci.yml`, `site` filter)
and against the release tarball (`validate-dist.yml`).

