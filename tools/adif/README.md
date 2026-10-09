# ADIF Editor

A dependency-free, client-side ADIF (.adi) viewer/editor. Drag-drop
a log file in, edit cells/rows/fields in a table, export a fresh `.adi`. No
network calls, no framework. The published page loads plain ES modules; a
generated single-file version (`adif-editor.html`) runs without a server.

## Why this exists / process

**Problem:** wanted a browser-based drag-and-drop ADIF viewer/editor to embed
in a Zensical site. Requirements: auditable, self-hostable, minimal
dependencies.

**Survey of existing options (Sept 2026):**
- Full loggers (Log4OM, DXKeeper, Cloudlog, ADIF Master) — desktop/server
  apps, not embeddable browser components, way over-scoped for "load, edit,
  save."
- "Online ADIF viewer/converter" sites (fileproinfo.com, filext.com) — upload
  your log to a third-party server to view it. Rejected on privacy/auditability
  grounds; a log file contains your callsign, grid square, and QSO timestamps.
- `nigelhewitt/Logger` (GitHub) — native WinForms app, not browser-based.
- JS libraries exist (`adif-parser-ts`, actively maintained; `adif`/node-adif,
  abandoned ~11 years) but nothing wraps them in a self-contained drag-drop
  editor UI.

**Conclusion:** nothing fit, so built one from scratch rather than vendor a
dependency for a format simple enough to parse in ~40 lines.

**Why not Jupyter/JupyterLite:** ADIF parsing needs no numeric/scientific
stack (unlike NEC2 or Touchstone work) — it's a flat tagged-length format
(`<FIELDNAME:LENGTH:TYPE>value`, records terminated by `<EOR>`). Pulling in
Pyodide for this would mean tens of MB and a slower cold start to do what
plain `FileReader` + a `<table>` does natively. A notebook's cell-execution
model is also the wrong shape for "drag a file, edit a grid, export" — that's
an app, not an exploratory script. Reserved Jupyter/Voici for where it
actually earns its keep (the propagation-dashboard notebook work).

**Format handling:**
- Header is optional per the ADIF spec (a file may begin directly with the
  first field tag). Parser detects this: if it can't find a plausible
  free-text-header shape, it looks for `<EOH>`; if that's absent too, the
  whole file is treated as records with a warning surfaced in the UI rather
  than failing silently.
- All field/tag names are case-folded to uppercase internally; ADIF is
  case-insensitive on tag names.
- Field length is taken literally from the `<FIELD:LEN>` declaration, not
  inferred from delimiters — this matches spec behavior (values are not
  required to be separated by whitespace) and was verified against
  deliberately squeezed-together sample records with no separators.
- Trailing fields after the last `<EOR>` (malformed/truncated files) are
  recovered as a final record rather than silently dropped, with a warning.
- Export always regenerates a minimal `<EOH>`-terminated header; it does not
  attempt to preserve arbitrary free-text header content from the input file.

**Verified before handoff** (Node, outside the browser, since this is pure
string logic with no DOM dependency):
- Round-trip: parse → serialize → re-parse produces an identical record set.
- Headered and headerless input both parse correctly.
- Files with no final `<EOR>` recover the trailing record with a warning.

**Editing:** a cell takes its value when it loses focus; Enter takes it
and moves one row down (only MultilineString fields such as ADDRESS or
NOTES may hold line breaks; those from a loaded file are kept), Esc restores the
value from before the edit. Cells are `contenteditable="plaintext-only"`
where supported, so pasted text brings no markup. With edits that haven't
been exported (ADI or CSV), closing or reloading the tab asks first.

**Encoding:** files are read as UTF-8, else as Windows-1252 (with a
warning). The ADI export is ASCII, as ADIF requires: other characters are
transliterated (ä → ae, é → e, the rest → ?), line breaks become blanks
except in MultilineString fields (written as CR LF), and the editor says how
many values that changed.

**Known gaps** (not implemented — flag if you want these):
- No ADX (XML variant) read/write, `.adi` only.
- No in-browser paste-from-clipboard entry point (file/drag-drop only).
- The editor itself keeps no USERDEF field type declarations (`<USERDEFn>`
  header fields): such fields round-trip as opaque strings and the export
  writes no USERDEF header. (The validator does read USERDEF declarations
  of a loaded file and checks the fields against them.)
  They are exported as String, so a line break in them becomes a blank.
- Likewise, the data type indicator of application-defined fields
  (`<APP_X_Y:3:N>`) is not kept; they are exported without one, which ADIF
  reads as MultilineString (line breaks kept).

## Validation

Every loaded file is checked against ADIF 3.1.7 by
`../shared/js/adif-validate.js` (`validateAdif(source)`, pure, no DOM,
issue #56). The page shows a summary line (`✓ ADIF valid`,
`⚠ ADIF valid with warnings`, `✕ Invalid ADIF`, with the counts) in a
`role="status"` region; "show issues" opens the list, grouped per file and
per QSO (with its current table row). Problem cells get `cell-error`,
`cell-warning` or `cell-info` and the messages as tooltip; the row number
shows the worst severity.

Until the first edit the panel shows the check of the loaded files' own
text (so it catches wrong lengths, malformed tags, non-ASCII, header
problems). After any edit it re-checks the log *as the ADI export would
write it* (`serializeADIF`), with the rows in table order; rows without any
value are skipped. Sorting keeps the flags (they belong to the record).

**Semantics** (issue #56, comment): `valid` = no `error`; warnings and
infos never fail validation. `error` = ADIF syntax or specification
violation, `warning` = valid but inconsistent or suspicious, `info` =
interoperability hint. The result is
`{ valid, errors, warnings, infos, issues, records, header, specVersion }`;
an issue is `{ severity, code, message, recordType: 'file'|'header'|'qso',
recordIndex (0-based into records), field, value, offset, line, column }`.
Input never makes it throw: when no field structure can be found the result
holds one `UNRECOVERABLE_PARSE_ERROR`.

**How it works.** A tolerant scanner reads tags; when a declared length
runs into the next tag, the value is cut there and the scan resyncs, so one
wrong length doesn't swallow the following fields; a broken QSO is reported
and the next ones are still read. Field and value checks are driven by
`../shared/js/adif-spec-data.js`, generated from the official ADIF 3.1.7
resources archive (`https://adif.org.uk/317/resources`, `exports/csv/`:
data types, fields, enumerations) by `scripts/build_adif_spec.py`
(`just build-adif-spec`; the output is committed, rerun it only for a
new ADIF version). Only the cross-field checks and heuristics are code.

**Codes** (stable; tests assert codes, not wording):

| Code | Severity | Meaning |
| --- | --- | --- |
| `UNRECOVERABLE_PARSE_ERROR` | error | empty input or no field tag at all |
| `MALFORMED_FIELD` | error | `<` without `>`, tag without length, bad length/type syntax |
| `TRUNCATED_FIELD` | error | declared length runs past the end of the file |
| `FIELD_LENGTH_MISMATCH` | error | value continues after the declared length, runs into the next tag, or the length counted the line break |
| `MISSING_EOH` / `DUPLICATE_EOH` | error | header text without `<EOH>`; a second `<EOH>` |
| `MISSING_EOR` | error | fields after the last `<EOR>` (still read as a QSO) |
| `MALFORMED_RECORD` | error | `<EOR>` inside the header |
| `DUPLICATE_FIELD` | error | a field twice in one QSO (or header) |
| `INVALID_ADIF_VERSION` | error | `ADIF_VER` not X.Y.Z |
| `INVALID_USERDEF` | error | USERDEF without type, bad syntax, or naming an ADIF field |
| `INVALID_APPLICATION_FIELD` | error | `APP_` name not `APP_{PROGRAMID}_{FIELD}` |
| `INVALID_DATATYPE_INDICATOR` | error | unknown type letter in `<NAME:LEN:X>` |
| `INVALID_DATATYPE` | error | `CREATED_TIMESTAMP`, IOTA/POTA/SOTA/WWFF references, Character |
| `INVALID_CHARACTER` | error | non-ASCII, or a line break outside a MultilineString |
| `INTL_FIELD_IN_ADI` | error | `*_INTL` (Intl types) are for ADX only |
| `INVALID_BOOLEAN`, `INVALID_NUMBER`, `INVALID_DATE`, `INVALID_TIME` | error | data type format (dates from 1930, real days of the month) |
| `NUMBER_OUT_OF_RANGE` | error (info for `ANT_AZ`/`ANT_EL`, whose out-of-range values are import-only) | field min/max |
| `INVALID_ENUM` | error | value not in the enumeration (STATE/MY_STATE checked per DXCC where ADIF lists codes) |
| `INVALID_GRIDSQUARE` | error | not a 2/4/6/8-character locator (10/12 characters belong into `*_EXT`) |
| `INVALID_LOCATION` | error | not `XDDD MM.MMM`, wrong direction letter, out of range |
| `UNSUPPORTED_ADIF_VERSION` | warning | file declares a newer ADIF than 3.1.7 |
| `HEADER_STARTS_WITH_TAG` | warning | file starts with `<` but has an `<EOH>` |
| `UNKNOWN_FIELD` | warning | not an ADIF 3.1.7 field, not `APP_`, not USERDEF (once per field name) |
| `FIELD_NOT_IN_HEADER` / `HEADER_FIELD_IN_RECORD` | warning | QSO field in the header, or the other way round |
| `TYPE_INDICATOR_MISMATCH` | warning | type letter differs from the field's type |
| `APP_FIELD_TYPE_INCONSISTENT` | warning | an `APP_` field with different type letters |
| `IMPORT_ONLY_VALUE` | warning | e.g. `MODE=C4FM` (use `MODE=DIGITALVOICE SUBMODE=C4FM`), Award values |
| `NONSTANDARD_ENUM_VALUE` | warning | `CONTEST_ID`/`SUBMODE` outside the recommended enumeration |
| `BAND_FREQUENCY_MISMATCH` | warning | `FREQ` outside `BAND` (and `FREQ_RX`/`BAND_RX`) |
| `MODE_SUBMODE_MISMATCH` | warning | SUBMODE of another MODE, or SUBMODE without MODE |
| `GRIDSQUARE_EXT_MISMATCH` | warning | `*_EXT` without an 8-character locator |
| `INCOMPLETE_LOCATION` | warning | LAT without LON (or MY_…) |
| `DATE_IN_FUTURE` | warning | a date after today (UTC) |
| `EMPTY_RECORD` | warning | `<EOR>` with no fields |
| `MISSING_QSO_FIELD` | warning | no CALL, QSO_DATE, TIME_ON, BAND or FREQ, MODE |
| `SUSPICIOUS_CITY_VALUE` | warning | `MY_CITY`/`QTH` holds a locator ("Did you mean MY_GRIDSQUARE?") |
| `APP_FIELD_WITHOUT_TYPE` | info | `APP_` field without type letter (once per field name); its value is checked as MultilineString, as ADIF says |
| `IMPORT_ONLY_FIELD` | info | `GUEST_OP`, `VE_PROV` |
| `FREQUENCY_OUTSIDE_BANDS` | info | FREQ in no ADIF band, no BAND given |
| `LINE_BREAK_NOT_CRLF` | info | bare CR or LF in a MultilineString |
| `NO_HEADER` / `MISSING_ADIF_VERSION` / `NO_RECORDS` | info | |

Not checked (yet): secondary subdivisions (`CNTY`, except where ADIF lists
codes for the DXCC entity), `USACA_COUNTIES`, the 2-or-4 rule of
`VUCC_GRIDS`, CQ/ITU zones against DXCC, CONT against DXCC.

## Cross-checks with other tools

`oe1ebg/tests/adif-crosscheck.test.mjs` runs two independent tools on the
same inputs and expects the same answer to "are there errors?":

- **adifmt** (ADIF Multitool, github.com/flwyd/adif-multitool): types,
  enumerations, ranges (`adifmt validate`);
- **adif-checker** (github.com/k0swe/adif-checker): ADI syntax only (tags,
  lengths, stray bytes), so it is compared with our syntax errors.

Inputs: the fixtures, the official test QSOs (whole and per group), the
ADIF editor's export of them, the confirmation log's exports (every
template), and single invalid values per data type plus valid edge cases.
Both tools are pinned in `oe1ebg/tests/tools/go.mod` (Dependabot) and built
by `just crosscheck-tools`; `just crosscheck` runs the test.
Without the tools it skips; CI builds them and requires them
(`ADIF_CROSSCHECK=require`) whenever ADIF code changed (AGENTS.md, *CI
scope*), in the weekly full run, and in every release and weekly data build
(`release.yml`, `data.yml`): a release whose cross-checks fail is not
published.

**A disagreement is not automatically our bug.** Look the case up in the
ADIF specification first; then fix our code, or record the tool's deviation
in the test (the `differs` of the case, with the spec section). Recorded so
far:

| Input | Us | Tool | Spec |
| --- | --- | --- | --- |
| `<CALL:5>OE1ABC` | `FIELD_LENGTH_MISMATCH` | adifmt: ok (reads `OE1AB`) | IV.A.1; adif-checker agrees with us |
| `GRIDSQUARE=SZ88` | `INVALID_GRIDSQUARE` | adifmt: ok | III.A.1: the first pair is A–R |
| `NAME_INTL` in .adi | `INTL_FIELD_IN_ADI` | adifmt: ok | IV.A.1: no Intl types in ADI |
| `CREDIT_SUBMITTED=DXCC:CARD&FAX` | `INVALID_ENUM` | adifmt: ok | III.A CreditList: QSL_Medium values only |
| `ANT_AZ=370` | info | adifmt: error | field ANT_AZ: outside 0–360 is import-only |
| text between records (official test file) | ok | adif-checker: error | IV.A.2 lists Header, Record…; the spec's own test file has it |
| `COMMENT=Grüße` | `INVALID_CHARACTER` | adif-checker: error too (counts bytes) | ADI is ASCII |

Found and fixed through these: an application-defined field without a type
indicator is MultilineString (IV.A.4), not String; line breaks in it are
valid. Beyond errors, the validator also warns where adifmt is silent:
BAND/FREQ, locator in a city field, newer `ADIF_VER`, unknown fields,
import-only values such as `MODE=C4FM`. Malformed files: adifmt stops at
the first syntax error, the validator reports every QSO.

## Compliance panel and build provenance

Under the validation bar, a collapsible `<details id="compliance">`
("About ADIF compliance & validation", `js/compliance.js`, built with
`el()`, links via `../shared/js/sources.js`) tells the user:
- what the in-browser check covers (spec version `ADIF_SPEC_VERSION`,
  syntax / data types / enumerations / cross-field checks), what
  error/warning/info mean, and that edits are re-checked as exported;
- how the editor itself is verified: the official test QSOs pass without
  issues, the strict independent reader (`tests/adif-spec.mjs`), the
  cross-checks against adifmt and adif-checker (with the pinned versions),
  and the known differences (*Cross-checks with other tools* on GitHub);
- where this build comes from: its commit, the checks GitHub ran on that
  commit (`/commit/<sha>/checks`), the workflow run that built it (or
  "local build"), and the CI workflow page. Links to test files point at
  the build's commit, so they show the tests this build was checked with.

The facts come from `build-info.js`, generated (git-ignored) by
`scripts/build_adif.py` next to `adif-editor.html` and inlined into it:
`self.ADIF_BUILD = { commit, version, run, adifmt, adifChecker }`.
`commit` is `GIT_SHA` (Justfile, CI), `version` a content hash of the
bundle, `run` is `BUILD_RUN_URL` (the Justfile builds it from GitHub
Actions' `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`/`GITHUB_RUN_ID`; `null`
locally), and the tool versions are read from `tests/tools/go.mod`. On a dev
server without it the panel says "development build".

The provenance chain of a release: tag → `release.yml` run (builds the
cross-check tools, `just dist`, then every test with
`ADIF_CROSSCHECK=require`) → `build-info.js` names that run and the commit → the panel
links both, plus the commit's checks (the CI runs of the PR/push).
`data.yml` rebuilds work the same way and name their own run.

## Official test QSOs

The resources archive holds test QSOs that use every field and enumeration
value of the spec (minus deleted and import-only ones), one QSO each.
`scripts/build_adif_spec.py` copies them, byte for byte, to
`oe1ebg/tests/fixtures/adif-spec/test-qsos.adi` (committed, so the tests
need no network; CR LF kept via `.gitattributes`).
`oe1ebg/tests/adif-official.test.mjs` runs on the whole file and on groups
of it (user-defined and application-defined fields, primary and secondary
subdivisions, DXCC entities, contests/credits/awards, QSL and upload
status, bands/frequencies/modes, other fields; every QSO in exactly one
group), so a failure names the part of the spec. Each run requires:
- the validator: no issue at all;
- the editor's export (`parseADIF` → `serializeADIF`): no error, every
  value unchanged, except the known gaps above (USERDEF fields lose line
  breaks, APP fields their type indicator).

## ADIF version compliance

The tool targets and declares **ADIF 3.1.7** (https://www.adif.org/317/ADIF_317.htm)
— this must be kept in sync if a newer ADIF version is adopted:
- Exported `.adi` files emit `<ADIF_VER:5>3.1.7` in the header.
- Each loaded file's own declared `ADIF_VER` (if present in its header) is
  parsed and surfaced per-file in the UI, purely informational — the tool
  doesn't refuse or reinterpret files declaring a different/no version.
- The field picker and column-header inline help are backed by ADIF 3.1.7's
  own machine-readable field export (`adif.org.uk/317/resources` →
  `exports/csv/fields.csv`), transformed offline into an embedded JS data
  table (name/type/description for all ~181 QSO-record fields) — not
  hand-typed from memory, so it stays accurate to the spec. Re-run that
  transform against the new export if/when the target version changes.

## Exports

Beyond `.adi`, the toolbar offers:
- **`.csv`** — every current column/row, RFC4180-quoted, for spreadsheet use.
- **SOTA V2 CSV** (activator/chaser mode toggle) — the format SOTA's own
  database importer expects (`V2,<call>,<summit>,<date>,<time>,<band>,<mode>,
  <call>,<summit>,<comment>`), verified against sotadata.org.uk's own docs.
  Note SOTA's database also accepts standard ADIF directly via `MY_SOTA_REF`/
  `SOTA_REF`/`COMMENT` — the CSV export exists as an alternative for people
  who prefer it, not because ADIF import doesn't work.

A "tools" panel adds a bulk **comment template**: a `{FIELDNAME}` placeholder
string (e.g. `{RST_SENT} {RST_RCVD} thx`) applied to every record whose
`COMMENT` is currently blank — it never overwrites a `COMMENT` you already
typed by hand.

## Files

- `index.html` — markup and CSS; served at the pretty URL `/tools/adif/` on
  oe1ebg.at. Loads `js/app.js` as an ES module, so it needs to be served
  over http (`just preview`, or any static server on `oe1ebg/tools/`).
- `js/compliance.js` — the compliance panel (see *Compliance panel and
  build provenance*); its pure parts tested in
  `oe1ebg/tests/adif-compliance.test.mjs`.
- `build-info.js` — generated by `scripts/build_adif.py`, git-ignored.
- `js/app.js` (state, table, file loading, toolbar), `js/export.js` (ADI,
  CSV and SOTA CSV export; pure, unit-tested in `oe1ebg/tests/adif.test.mjs`),
  `js/fields.js` (ADIF 3.1.7 field reference data).
- `../shared/js/adif.js` — ADI parsing and field encoding, shared with the
  confirmation log's ADIF export.
- `../shared/js/adif-validate.js` + `../shared/js/adif-spec-data.js` — the
  validator and its generated spec data (see *Validation*), tested in
  `oe1ebg/tests/adif-validate.test.mjs` with the fixtures in
  `oe1ebg/tests/fixtures/adif/`.
- `adif-editor.html` — generated by `scripts/build_adif.py`
  (`just build-adif`, part of `build`), git-ignored: the whole editor
  in one HTML file, modules inlined (`scripts/single_file.py`). This is the
  "open directly in any browser, no server required" version, linked as
  "single file ↓" in the page header.

The source lives in `tools/adif/` and is copied into the bundle
(`site/tools/adif/`) at build time by `scripts/build_site.py`, without this
README.

## Zensical integration

Zensical (and MkDocs, which it stays compatible with) copies any non-Markdown
file under your `docs_dir` straight through to the built site. Two ways to
use the single-file `adif-editor.html` on another site:

**1. Standalone page.** Drop it in, e.g.:
```
docs/tools/adif-editor.html
```
Builds to `yoursite.org/tools/adif-editor.html`, no Material theme chrome.

**2. Embedded in a themed page**, keeping the tool in its own document so its
CSS can never collide with Material's site-wide styles in either direction:
```html
<iframe src="/tools/adif-editor.html"
        style="width:100%;height:85vh;border:1px solid var(--md-default-fg-color--lightest);"
        loading="lazy"></iframe>
```
Drag-and-drop works normally through the iframe — the browser delivers the
drop event to whatever document is under the cursor, so no `postMessage`
bridging is needed.

## License

No external code, no dependencies. Do whatever you want with it.
