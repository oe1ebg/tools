# ADIF Editor

A dependency-free, client-side ADIF (ADI/ADX) viewer/editor. Drag-drop
a log file in, edit cells/rows/fields in a table, export a fresh `.adi` or `.adx`. No
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
  deliberately squeezed-together sample records with no separators. Text
  that looks like a tag inside a value (`<NOTES:9>a <EOR> b`, also `<EOH>`
  inside a header value) stays part of the value (issue #12).
- Trailing fields after the last `<EOR>` (malformed/truncated files) are
  recovered as a final record rather than silently dropped, with a warning.
- Export always regenerates a minimal `<EOH>`-terminated header; it does not
  attempt to preserve arbitrary free-text header content from the input file,
  only the USERDEF declarations (see *Field definitions*).
  A header field whose length runs past `<EOH>` is read up to the next tag
  (with a warning); the header fields and USERDEFs around it are kept.

**Verified before handoff** (Node, outside the browser, since this is pure
string logic with no DOM dependency):
- Round-trip: parse → serialize → re-parse produces an identical record set.
- Headered and headerless input both parse correctly.
- Files with no final `<EOR>` recover the trailing record with a warning.

**Editing:** a cell takes its value when it loses focus; Enter takes it
and moves one row down (only MultilineString fields such as ADDRESS or
NOTES may hold line breaks; those from a loaded file are kept), Esc restores the
value from before the edit. Cells are `contenteditable="plaintext-only"`
where supported, so pasted text brings no markup. Cells are one line high
(the table is virtualized, see *Performance*): long values end in …, line
breaks show as ¶; the cell shows the whole value while it is edited. Tab
at the end of a row goes on to the next row's first field. With edits
that haven't been exported (ADI or CSV), closing or reloading the tab
asks first.

**Dropdowns and suggestions** (`js/enum-options.js`, `js/cell-editors.js`).
ADIF 3.1.8 has two kinds of enumerated fields, and the editor treats them
as the validator does:
- **Strict** (type `Enumeration`: any other value is an error): the cell is
  a native `<select>`. That is BAND, BAND_RX, MODE, DXCC, MY_DXCC, the
  QSL/LoTW/eQSL/DCL sent and received fields, QSL_SENT_VIA/QSL_RCVD_VIA,
  the upload/download status fields, PROP_MODE, ANT_PATH, (MY_)ARRL_SECT,
  CONT, EQSL_AG, QSO_COMPLETE, REGION, (MY_)MORSE_KEY_TYPE, and a USERDEF
  field declared with type `E` and values (`NAME,{A,B}`). The first option
  is empty: it removes the field. Import-only values (MODE PSK31, QSL_RCVD
  V, QSL_VIA M, …) are not offered; REGION's `KO`, listed three times in
  the spec data, once. DXCC options read `291 – UNITED STATES OF AMERICA`,
  deleted entities are marked `(deleted)`.
- **STATE, MY_STATE, CNTY, MY_CNTY**: a select only when the row's DXCC
  (MY_DXCC) has a list in the spec data, else text (the validator checks
  them only then, too). Changing DXCC switches the row's cells.
- **Open lists** (a `String` field that recommends an enumeration; other
  values are valid, the validator only warns): CONTEST_ID and SUBMODE stay
  free text with suggestions. SUBMODE's follow the row's MODE (none for
  an ADIF mode without submodes such as FT8; all submodes without a MODE,
  or for one ADIF doesn't know). Typing shows the matching
  values (case-insensitive; those starting with the text first, at most 30,
  then "… n more"); ↓ opens the list, ↑/↓ move the highlight (announced to
  screen readers), Enter takes the highlighted value, or the typed text when
  none is highlighted, and moves down as usual; the first Esc closes the
  list, the second restores the value; Tab closes it. A click takes a value.
- Everything else (MY_COUNTRY: the spec data has no Country list; DARC_DOK:
  no data; credit and award lists, CNTY_ALT, `APP_` fields) stays text.

**A stored value is never changed by showing it.** The selected option's
value is always the stored value: one that matches an option except for
letter case (`20M`) or DXCC zero padding (`001`) keeps its own spelling; an
import-only value stays in the list as `PSK31 (import-only)`; any other
stays too, as `zz (not in ADIF 3.1.8)`, `(not declared in USERDEF)` or
`(not listed for DXCC=291)`. Focusing or tabbing through a cell edits
nothing. A select shows only its current value until it is used (the full
list is filled in on pointer-down, hover or focus, once per select). It
commits like a text cell: on blur, Enter (and down), Tab, or before its row
scrolls out; not on `change`, because some browsers step a closed select's
value with the arrow keys. Esc restores the value from before.

**Dates and times** (`js/datetime.js`, ISO 8601 as everywhere in these
tools). The 16 `Date` fields (QSO_DATE, QSO_DATE_OFF, the QSL, LoTW, eQSL
and DCL sent/received dates, the Club Log, HAMLOG.EU, HamQTH, HRDLog and
QRZ.COM upload/download dates), TIME_ON and TIME_OFF, and USERDEF/`APP_`
fields declared `D` or `T` are shown as `2026-09-01`, `12:00` and
`12:00:30`, and stored as ADIF (`20260901`, `1200`, `120030`). You can type
`2026-09-01`, `2026-9-1` (also with `.` or `/`) or `20260901`; `12:00`,
`9:05`, `12:00:30`, `1200` or `120030`. Seconds are stored only when typed.
Anything else is kept as typed, and the validator reports it. A stored
value that isn't ADIF's spelling (`2026-09-02`, `12:00`) is shown as it
is, and leaving it as shown is no edit. A focused date cell has a calendar
button (not in the Tab order; Alt+↓ does the same) that opens the
browser's date picker (`../shared/js/isodate.js`). The picked date is stored at once. Only the
picker's value is used, never its locale-formatted field, so no
`<input type="date">` shows. Without `showPicker` (Safari before 16) there
is no calendar, and typing works everywhere. Times have no picker: the
browser's time picker shows AM/PM in some locales.

**new / clear…** in the toolbar. *new* starts an empty log with the
columns CALL, QSO_DATE, TIME_ON, BAND, FREQ, MODE, RST_SENT, RST_RCVD, one
empty row and the focus on CALL (export file name `new.adi`); with
unexported edits it asks first. *clear…* always asks (naming unexported
edits) and empties the editor: the log, its files, field definitions,
validation, filters, sort order and warnings; it is disabled while the
editor is empty. Both wait while a file loads. The question is a modal
`<dialog>` (Cancel has the focus, Esc is no), not `confirm()`, which a
sandboxed iframe of an embedding page blocks.

**Room for the table.** Validation verdict, file versions, *Log statistics*
and *About ADIF compliance* share one line under the filter bar; a panel
opened from it takes the whole width. Once the table is scrolled down more
than 48 px, the parts only read now and then fold away (`body.compact`):
the log overview in the toolbar, the file versions and the closed
*Log statistics* / *About* lines. The verdict, the toolbar buttons and the
filter stay. On a phone (≤ 600 px) the page header goes too, and the
toolbar and the filter line become one row each that scrolls sideways.
Scrolling the table back to the top unfolds everything. What is open or
has the focus stays. A table that would scroll less than 48 px once folded
is not folded, so the layout doesn't flip back and forth.

**Encoding:** files are read as UTF-8, else as Windows-1252 (with a
warning). The ADI export is ASCII, as ADIF requires: an explicit preflight decision
is required before other characters are transliterated (ä → ae, é → e, the rest → ?), line breaks become blanks
except in MultilineString fields (written as CR LF), and the editor says how
many values that changed.

**Field definitions** (issue #12): what a file says about fields ADIF
doesn't define is kept through load → edit → export. `parseADIF(…, defs)`
(`../shared/js/adif.js`) collects the header's `USERDEFn` declarations as
written (type letter, enumeration `{A,B}` or range `{min:max}`) and the
data type of each application-defined field from its first occurrence
(its indicator, or none = MultilineString, ADIF 3.1.8 IV.A.4; for other
fields the first indicator given); `js/export.js`
merges them per loaded file (`mergeFieldDefs`) and `serializeADIF(…,
defs)` writes them back: `<USERDEFn:len:T>` in the header (renumbered
1…n in load order), the indicator on application-defined fields
(`<APP_X_Y:1:N>`), none on USERDEF fields (their type is in the header).
Line breaks stay in fields of type M (USERDEF or `APP_` with `:M`, or an
`APP_` field without indicator, which ADIF reads as MultilineString); in
any other type they become a blank, counted in the export's note.
Removing a column drops its declaration. Without `defs` the export is
the same as before. Combining files whose declarations differ:
- same USERDEF name and type, other enumeration values or range: the
  export declares the union of the values / the wider range (or no
  restriction when one file has none), so the values of both files stay
  valid; the warnings box says so;
- same name, another type (USERDEF, or the type of an `APP_` field, where
  no indicator counts as M, so `<APP_X_Y:13>a\r\nb` in one file and
  `<APP_X_Y:1:N>1` in the other conflict): the combined ADI preview retains the first loaded file's
  declaration, while export requires an explicit definition choice. The warnings box names the
  conflict at load, and the validation panel switches right away to the
  check of the log *as it would be exported*, so every value that no
  longer fits its declaration is in the issue list (and flagged in the
  table) before anything is exported.

**Known gaps** (not implemented — flag if you want these):
- No in-browser paste-from-clipboard entry point (file/drag-drop only).
- Type indicators of ADIF's own fields (`<CALL:5:S>`) aren't written back:
  their type is fixed by the spec.
- A USERDEF declared with an Intl type (`I`, `G`) is kept, but ADI values
  stay ASCII.
- MY_COUNTRY / MY_COUNTRY_INTL get no dropdown: the spec data has no
  Country enumeration.
- STATE / MY_STATE: the spec data's import-only list of these values does
  not say for which DXCC entity it holds (BC and NL are valid for Canada,
  import-only for Mexico), so the scoped dropdowns mark nothing
  import-only; the validator doesn't report those either.
- iOS Safari zooms into a focused table cell (select or text): the cells
  keep the table's 13px so that every row has the same height, which the
  virtual table needs.

## Validation

Every loaded file is checked against ADIF 3.1.8. ADI source syntax uses
`../shared/js/adif-validate.js` (`validateAdif(source)`, pure, no DOM); ADX
uses native XML parsing and the same field/header/cross-field semantics. The page shows a summary line (`✓ ADIF valid`,
`⚠ ADIF valid with warnings`, `✕ Invalid ADIF`, with the counts) in a
`role="status"` region; "show issues" opens the list, grouped per file and
per QSO (with its current table row). Problem cells get `cell-error`,
`cell-warning` or `cell-info` and the messages as tooltip; the row number
shows the worst severity.

Until the first edit the panel shows the check of the loaded files' own
text (so it catches wrong lengths, malformed tags, non-ASCII, header
problems). After any edit an ADI-only log is checked *as the ADI export
would write it* (`serializeADIF`); a log containing ADX is checked directly
with each source file's definitions and format, preserving Unicode and
keeping conversion effects separate. The records follow table order; rows without any
value are skipped. Sorting keeps the flags (they belong to the record).
The re-check waits 150 ms after the last edit and then runs when the
browser is idle (`requestIdleCallback`, a timeout in Safari); meanwhile
the bar says "checking…" (`aria-busy` on the status).

**Semantics** (issue #56, comment): `valid` = no `error`; warnings and
infos never fail validation. `error` = ADIF syntax or specification
violation, `warning` = valid but inconsistent or suspicious, `info` =
interoperability hint. The result is
`{ valid, errors, warnings, infos, issues, records, header, specVersion }`;
an issue is `{ severity, code, message, recordType: 'file'|'header'|'qso',
recordIndex (0-based into records), field, value, offset, line, column }`.
Input never makes it throw: when no field structure can be found the result
holds one `UNRECOVERABLE_PARSE_ERROR`.

**How it works.** A tolerant scanner reads tags. A declared length that
fits in the file always counts (ADIF 3.1.8 IV.A.1): the value is the
declared number of characters, never split at tag-shaped text inside it,
and characters after it outside a field or `<EOR>` are ignored (IV.A.6),
also the rest of a tag-shaped sequence the length ends in. So
`<NOTES:20>literal <EOR> insideignored annotation<EOR>` is valid, and
`<NOTES:7><CALL:5> annotation<EOR>` gives NOTES = `<CALL:5`. Suspicious
boundaries are warnings that never move a boundary: tag-shaped text inside
a value (`TAG_IN_VALUE`; `RECORD_END_IN_VALUE` for an `<EOR>`, which a
too-long length swallowing a QSO end looks like), and text after a value
before the next tag, directly or after a blank, or a length ending inside
a tag (`FIELD_LENGTH_MISMATCH` as a warning, also next to
`RECORD_END_IN_VALUE`). Only a length past the end of the file is cut: at
the first tag inside it, resyncing there (`FIELD_LENGTH_MISMATCH`, error),
else `TRUNCATED_FIELD`. `parseADIF` reads every one of these the same way,
so the editor and the validator agree on fields and QSOs
(`tests/adif-userdef.test.mjs`). Lengths counted in UTF-8 bytes (many
loggers): `adifCountsBytes()` (`../shared/js/adif.js`, also used by
`parseADIFAuto`) decides for the whole file; then the validator reads it by
bytes, reports values and positions in characters, and says so once
(`LENGTHS_IN_BYTES`). A broken QSO is reported and the next ones
are still read. Within a file, the first occurrence of an `APP_` field
determines its type (IV.A.4), also an empty one: later values are checked against it, a
different type is `APP_FIELD_TYPE_INCONSISTENT`. Field and value checks are driven by
`../shared/js/adif-spec-data.js`, generated from the official ADIF 3.1.8
resources archive (`https://adif.org.uk/318/resources`, `exports/csv/`:
data types, fields, enumerations) by `scripts/build_adif_spec.py`
(`just build-adif-spec`; the output is committed, rerun it only for a
new ADIF version). Only the cross-field checks and heuristics are code.

**Codes** (stable; tests assert codes, not wording):

| Code | Severity | Meaning |
| --- | --- | --- |
| `UNRECOVERABLE_PARSE_ERROR` | error | empty input or no field tag at all |
| `MALFORMED_FIELD` | error | `<` without `>`, tag without length, bad length/type syntax |
| `TRUNCATED_FIELD` | error | declared length runs past the end of the file |
| `FIELD_LENGTH_MISMATCH` | error / warning | error: the length runs past the end of the file over a tag (cut there), or it counted the line break of a one-line field; warning: text follows the value before the next tag, directly or after a blank, or the length ends inside a tag (read as declared, the rest is ignored, IV.A.6; non-ASCII values: probably counted in bytes) |
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
| `UNSUPPORTED_ADIF_VERSION` | warning | file declares a newer ADIF than 3.1.8 |
| `LENGTHS_IN_BYTES` | warning | the field lengths count UTF-8 bytes, not characters (IV.A.1); read by bytes, as the editor does (once per file) |
| `HEADER_STARTS_WITH_TAG` | warning | file starts with `<` but has an `<EOH>` |
| `TAG_IN_VALUE` | warning | tag-shaped text inside a value whose declared length ends cleanly: read as part of the value (IV.A.1); a too-long length can look the same, and naive readers split there |
| `RECORD_END_IN_VALUE` | warning | the same with `<EOR>` inside the value: the typical sign of a too-long length that swallowed the end of the QSO (two QSOs read as one); valid per spec, so a warning |
| `UNKNOWN_FIELD` | warning | not an ADIF 3.1.8 field, not `APP_`, not USERDEF (once per field name) |
| `FIELD_NOT_IN_HEADER` / `HEADER_FIELD_IN_RECORD` | warning | QSO field in the header, or the other way round |
| `TYPE_INDICATOR_MISMATCH` | warning | type letter differs from the field's type |
| `APP_FIELD_TYPE_INCONSISTENT` | warning | an `APP_` field with another type than at its first occurrence in the file (no indicator = M), which determines its type (IV.A.4) |
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
ADIF editor's export of them (with their USERDEF declarations and typed
`APP_` fields), the editor's export of the fixtures with typed/multiline
user-defined fields and tag-shaped text in values, the confirmation log's
exports (every template), Netlog's check-in exports (repeater, frequency
only, DMR, no radio data), and single invalid values per data type plus
valid edge cases (`NOTES` holding `<EOR>`/`<EOH>`, `COMMENT` holding
`<CALL:4>…`: both tools read the declared length, as we do).
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
| `<CALL:5>OE1ABC` | ok, `FIELD_LENGTH_MISMATCH` warning (reads `OE1AB`) | adif-checker: error (stray byte); adifmt agrees with us | IV.A.1, IV.A.6: characters outside fields are ignored |
| `<NOTES:20>literal <EOR> insideignored annotation<EOR>` | ok, `RECORD_END_IN_VALUE` warning | adif-checker: error (stray bytes); adifmt agrees with us | IV.A.1, IV.A.6 |
| `<NOTES:7><CALL:5> annotation<EOR>`, `<NOTES:4><EOR> annotation<EOR>` | ok (NOTES `<CALL:5` / `<EOR`), `FIELD_LENGTH_MISMATCH` warning | adif-checker: error (stray bytes); adifmt agrees with us | IV.A.1, IV.A.6 |
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
`self.ADIF_BUILD = { commit, version, release, run, adifmt, adifChecker, commitFull }`.
`release` is the tag of a release build (`v0.7.0`, shown before the commit;
`null` otherwise, as for the offline tools, `tools/confirm/README.md`).
`commit` is `GIT_SHA` (Justfile, CI) shortened to 7 characters,
`commitFull` the full SHA (`null` if `GIT_SHA` is short): GitHub resolves
`/commit/<short>` but answers `/commit/<short>/checks` with a 404, so the
checks link needs it and is left out without it. `version` a content hash of the
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
- the editor's export (`parseADIF` → `serializeADIF` with the file's field
  definitions): no issue at all, the USERDEF declarations kept, every
  value unchanged (multiline USERDEF and `APP_` values included).

## Performance

Logs of tens of thousands of QSOs stay usable:

- **Virtualized table body** (`js/table.js`): only the rows in and around
  the visible part (half a screen above and below) exist in the DOM,
  between two spacer rows; rows have one fixed height (measured), scrolling
  re-renders the window in a `requestAnimationFrame`. Columns get fixed
  widths from the longest value (a `<colgroup>`) and the table is laid out
  with `table-layout: fixed` and `border-collapse: separate` (see
  *Import, re-check and limits*), so nothing jumps while scrolling and the
  browser measures no cell contents. One `focusin`/`focusout`/`keydown`/`click` listener on the
  body handles every cell (event delegation via `data-ri`/`data-col`); a
  cell being edited is committed before its row scrolls out; Enter and Tab
  scroll the next row into the window before focusing it.
- **Validation flags per rendered row**: each validation result is indexed
  once (record index → issues, `issuesByIndex` in `js/state.js`); a row
  gets its `cell-*`/`row-*` classes when it is rendered. The issue list
  stops building at 500 issues and is only built while it's open.
- **Pure hot paths**: `serializeADIF` builds an array and joins it and
  skips empty values early; `adifAscii` returns printable-ASCII values
  without the transliteration chain; the validator's cross-field checks
  look at the few enumerations that depend on another field and use a
  prebuilt band table. `tests/adif-validate-snapshot.test.mjs` proves the
  validator and the export still give byte-identical output.
- Sorting computes the keys once (numbers, else `Intl.Collator`), sorts an
  index array and permutes the log; loading appends and collects the
  columns once; the toolbar statistics are recomputed once per change
  batch.

`js/state.js` documents the **view contract** for code that changes what
the table shows (search/filter): `records` (the source of truth; exports
always write all of it), `recordFile` (source file per record), `view`
(record indices in display order, or null) with `setView(v)`, and
`issuesByIndex`.

**Measured** (MacBook, Apple silicon; `node scripts/bench_adif.mjs` for the
pure parts, median of 3; the browser numbers with Playwright in Chromium,
1400×900, file → table + validation shown, and an edit → re-check done
including the 150 ms debounce):

| | before | after |
| --- | --- | --- |
| official test QSOs (6197 QSOs × 180 fields, 1 MB): validate | 114 ms | 33 ms |
| … serialize (ADI export) | 228 ms | 12 ms |
| … edit loop (serialize + validate) | 341 ms | 44 ms |
| … browser: load and render | 4.4 s, 1.12 M cells | 0.13 s, ~60 rows / 10.5 k cells |
| … browser: edit → re-checked | 1.7 s (UI blocked) | 0.29 s |
| synthetic 50 000 QSOs (7.3 MB): validate | 845 ms | 222 ms |
| … serialize | 1838 ms | 107 ms |
| … edit loop | 2701 ms | 329 ms |
| … browser: load and render | did not finish in 10 min | 0.34 s |
| … browser: edit → re-checked | – | 0.49 s |

Validation stays well under 150 ms for 6k QSOs; at 50 000 QSOs one re-check
takes about a third of a second. Since issue #15 it runs in slices on the main
thread (see *Import, re-check and limits*, which also says why there is no
Web Worker).

### Responsiveness baselines (issue #15)

`just bench-ui` (`scripts/bench_ui.mjs`, not part of `just e2e`/CI, needs
`just build`) seeds data into the built tools and measures them in Chromium
(CDP CPU throttling 1x/4x/6x) and WebKit (unthrottled), desktop (1400x900)
and phone viewports (Pixel 7 / iPhone 13), 3 runs, median / p95 over the
samples. `--quick`, `--tool`, `--size`, `--adif-size`, `--engine`,
`--throttle`, `--viewport`, `--out` narrow it; an operation whose result does not
show (saved row, edited cell, finished re-check) fails the run: its samples are
dropped, the tables show ERROR and the exit code is 1, as does any uncaught page
error or console error other than two exactly matched known artifacts
(blocked service worker, WebKit's aborted location-data fetch on reload);
`--selftest` proves both with disabled saves and an injected error; raw numbers go to
`bench-ui.json` (ignored by version control). WebKit has no long-task
observer and Playwright no heap readout there, so those cells are empty.
`node --expose-gc scripts/bench_adif.mjs 5` adds heap figures to the node
benchmark (sizes 1k/10k/50k/100k as 2nd argument); its timings are noisy when
the machine is busy, so repeat on an idle one.

Measured 2026-10-10, MacBook (Apple silicon), Chromium; ADIF editor, synthetic
log from the official test QSOs (180 fields):

| | 10k QSOs | 50k QSOs |
| --- | ---: | ---: |
| file chosen -> rows + validation shown, 1x | 224 / 227 ms | 606 / 616 ms |
| ... 4x / 6x CPU | 839 / 1297 ms | 2350 / 3557 ms |
| ... WebKit (desktop / iPhone 13) | 597 / 426 ms | 1008 / 834 ms |
| longest task while loading (UI blocked), 1x / 4x / 6x | 168 / 633 / 976 ms | 549 / 2132 / 3207 ms |
| edit commit (Enter) -> next frame, 1x / 4x / 6x | 11 / 37 / 57 ms | 13 / 39 / 60 ms |
| edit -> re-checked (incl. 150 ms debounce), 1x / 4x / 6x | 275 / 617 / 865 ms | 679 / 2261 / 3374 ms |
| JS heap loaded / after edits | 10 / 16 MB | 39 / 71 MB |
| node: heap kept by parsed records + one validation result | 3 + 9 MB | 16 + 45 MB (100k: 33 + 89 MB, RSS up to ~1 GB) |

Findings: parsing and validation run in one task (about as long as the whole
load); at 4x CPU a 50k log blocks the page for 2 s on load and for about 1.5 s
(`serializeADIF` + `validateAdif` in one idle task) after each edit batch.
The edit commit itself stays below 60 ms. Scrolling the virtualized table is
smooth unthrottled (0 frames > 50 ms) but at 4x/6x CPU almost every frame
takes 50-150 ms, independent of log size: the cost is per-row rendering
(180 columns), not the size of the log.

**Enumeration selects** (measured 2026-10-14, same machine, `just bench-ui
--tool adif --engine chromium --throttle 1,4 --viewport desktop`, main
before the change / with it, median):

| | 10k QSOs | 50k QSOs |
| --- | ---: | ---: |
| file chosen -> rows + validation shown, 1x / 4x | 135 → 169 / 539 → 661 ms | 377 → 419 / 1551 → 1602 ms |
| longest task while loading, 4x | 112 → 198 ms | 149 → 222 ms |
| rendered DOM nodes | 10 329 → 24 142 | 10 329 → 24 142 |
| scroll frame, 4x (median / p95) | 16.7 / 16.8 → 33.3 / 33.4 ms | 16.7 / 33.3 → 16.7 / 33.4 ms |
| edit commit -> next frame, 4x | 28 → 33 ms | 36 → 40 ms |
| edit -> re-checked, 4x | 454 → 456 ms | 1571 → 1514 ms |

Each enumeration cell of the rendered window is a `<select>` with one
option until it is used, which more than doubles the rendered nodes; the
first render of a log is up to about a quarter slower, scrolling at 4x CPU
still has no frame over 50 ms, editing and re-checking are unchanged. Should
this grow, the fallback is a text cell that becomes a select on
hover/focus.

### Import, re-check and limits (issue #15)

**Chunked, cancellable import** (`js/load.js`, `../shared/js/chunked.js`).
`parseADIF()`, `validateAdif()` and `serializeADIF()` are thin drivers over
generator versions (`parseADIFSteps()`, `validateAdifSteps()`,
`serializeADIFSteps()`): the same code, which yields a progress value every
few thousand tags/QSOs, so the results are exactly those of the synchronous
functions whatever the pauses (`tests/adif-chunked.test.mjs` compares them
with a pause at every step; the validator snapshot and the official-QSO and
cross-check tests are unchanged). `chunkedRun()` runs a generator in slices
of about 10 ms and hands the thread back between them with a
`MessageChannel` (not `requestIdleCallback`, which Safari 15.4 lacks and
which only schedules, it cannot interrupt). While a file loads, the page
shows a labelled progress bar (reading: QSOs read; checking: n of m QSOs; in
percent) and a Cancel button that has the focus (Escape cancels too); a
status region announces every 10 %. `loadLogFiles()` reads, decodes, parses
and checks the files one after the other and only **returns** what it got;
the editor applies it (columns, records, validation view, table) in one step
after the last file, so a cancel, or an unexpected error, leaves the loaded
log, its filters and its warnings as they were. A file over a limit or
unreadable is left out with a message while the others load. Edits made
while a file loads stay (the new records are appended afterwards); a second
import is refused until the first is done.

**Chunked re-check after an edit.** The debounced re-check (serialize +
validate) runs in the same slices. A newer edit cancels a running check and
schedules a new one, and a result is applied only if no edit came after it
started (a sequence number), so the finished check is always that of the
current log, what a full `validateAdif()` of the export gives. The check
reads a copy of the list of records with values, so sorting while it runs
cannot change what it sees. "checking… n %" shows the progress. A truly
incremental check (re-validating only the edited QSOs) was not attempted:
issues carry line/column offsets into the exported text and some findings
are per file (`UNKNOWN_FIELD` counts, the first occurrence of an `APP_` field
decides its type), so an edit can change results anywhere; chunking keeps the
guarantee "equals a full validation".

**Memory.** The editor asks the validator for a `lean` result: the QSO records
keep only `index`, `offset` and `line` (the editor never reads their fields),
and the fields of a QSO are released as soon as it is checked. A 100 000 QSO
result drops from 89 MB to 6 MB, the editor's heap after loading 50 000 QSOs
from 39 to 16 MB. `maxIssues` keeps at most 100 000 issues per file (the
counts stay exact; a warning says how many were not kept).

**Table scrolling under CPU throttling.** A trace of a scroll at 4x CPU
showed the time in paint (36 ms per frame), pre-paint (20 ms) and layout
(19 ms) of ~8 000 cells, not in JavaScript. `border-collapse: collapse` was
the expensive part (collapsed borders are resolved and painted per table, not
per cell). With `border-collapse: separate; border-spacing: 0` (the same
look: one 1 px border at the right and bottom of each cell),
`table-layout: fixed` (widths from the `<colgroup>`; the table's width is set
from their sum in `setTableWidth()`) and half a screen of overscan instead of
a whole one (about 25 % fewer cells), the median frame at 4x CPU went from
83-100 ms to 33 ms. Horizontal virtualization of the ~180 columns (about ten
times fewer cells) would cut more, but changes the table's structure for
keyboard navigation, screen readers and tests, and is not needed any more.

**Resource limits** (`ADIF_LIMITS` in `js/load.js`). A file over one of them is
refused before the memory is spent, with a message that names the file and the
limit and says the log is unchanged:

| limit | value | checked |
| --- | ---: | --- |
| one file | 50 MB | before reading (`File.size`) |
| QSOs in the log (all files together) | 500 000 | while parsing, at the QSO that crosses it (a final QSO without `<EOR>` too, also when the log is already at the ceiling) |
| field values in the log (QSOs times fields) | 5 000 000 | while parsing |
| one field value | 100 000 characters (decoded: a byte-counted `ä` is one) | at its tag, before the value is cut out |
| fields in one QSO | 5 000 | while parsing |
| different field names (table columns) | 1 000, counting those the log has | while parsing |
| validation issues kept per file | 100 000 | the validator counts all; half the budget for structure issues, the rest for per-field ones; scanner findings beyond that budget are only counted while scanning |
| parser warnings kept per file | 200 | the rest is counted and one line says how many; the warnings box shows at most 50 per file and says how many more there are |

They follow from what a load takes (node, one parse + check in a fresh
process): about 20 MB of peak memory per MB of file, 244 MB for 50 000 QSOs
(7 MB), 600 MB for 200 000, 1.4 GB for 500 000 (73 MB, 4.4 M fields), about
the most a desktop tab survives; phones have less room, so for them the
limits are a ceiling, not a promise. Real logs are far below (a 10 000 QSO
log has about 90 000 fields). Derived calculations (sorting, column widths,
statistics, the comment template, exports) are linear in the log, which the
limits bound; the table only ever builds its window.

Details of how the limits count:

- The field-value limit counts what is in the log now (recounted at each
  load, deleted rows free it).
- The value limit counts the value as it is cut, not a declared length past
  the end of the file, in characters of the decoded value. A file whose
  lengths count UTF-8 bytes is read by its bytes; the limit and its message
  still count the decoded characters.
- A value over the limit refuses the file instead of cutting the value,
  because silently dropping data from a log is worse than refusing the file.
- The check of how a non-ASCII file's lengths count reads it both ways
  without building records or values (it needs only the limits and the count
  of unclean ends). The value limit is left to the real parse.
- The validator's scanner yields by scanned work, so a long malformed stretch
  neither piles up memory nor blocks the page. Findings beyond the issue
  budget, and a second and later `<EOH>`, are only counted.
- Not bounded by the limits: the line index (`avLineIndex`) and the byte to
  character map of a byte-counted file (`avByteToChar`) grow with the size of
  the file (at most 50 MB), not with the number of QSOs or issues.
- `maxWarnings` (like the other limits) is enforced only where `limits` are
  passed to `parseADIFSteps()`; the plain `parseADIF()` without them keeps
  every warning.
- Adding a file re-checks the log as it is now whenever an edit has made the
  loaded files' results obsolete, also when that edit's check had already
  finished.
- The messages are in English, like the rest of the editor.

**Web Worker assessment: not used.** A worker would take the ~0.4 s (50 000
QSOs, 1x) of checking off the main thread entirely, but chunking already keeps
every task of a load and a re-check short (see the numbers below), and a
worker would cost more than it gains here: (1) the single-file
`adif-editor.html` has to run from `file://`, where module workers do not
load, so the worker would have to be a second bundle (`scripts/single_file.py`
makes one script per entry) embedded as text and started from a Blob URL,
while the served build would use a module worker or the same Blob: two
start-up paths to test in five engines; (2) the Content-Security-Policy in
`deploy/nginx.conf.example` and `htaccess.example` would need `worker-src blob:`
for the Blob (and `tests/deploy-headers.test.mjs` with it); (3) parsed
records must be structured-cloned back to the page (16 MB of heap at 50 000
QSOs: a main-thread cost of the order of the parse itself, and twice the
memory for a while), so only the check could move, which is where the time is
but also where the generator already gives the same responsiveness; (4)
cancel and "the newest edit wins" would need messages instead of a flag. If
the check grows (ADX in #24, more rules), a worker for `validateAdifSteps()`
with the text transferred and a lean result back is the next step; the
generator split keeps that small.

**Measured** 2026-10-11 on the same machine and with the same configurations
as the baselines above (`just bench-ui --tool adif`, 3 runs, median; before =
`origin/main` at f06ff35). Chromium with CDP CPU throttling, WebKit
unthrottled; "before -> after":

| 50 000 QSOs | chromium 1x | 4x | 6x | webkit desktop | webkit iPhone 13 |
| --- | ---: | ---: | ---: | ---: | ---: |
| file chosen -> rows + validation shown (ms) | 606 -> 594 | 2627 -> 2512 | 3549 -> 3793 | 1038 -> 722 | 829 -> 683 |
| load: longest task (ms) | 549 -> 62 | 2393 -> 254 | 3224 -> 377 | n/a | n/a |
| scroll: median frame (ms) | 17 -> 17 | 100 -> 33 | 133 -> 50 | 67 -> 17 | 28 -> 17 |
| scroll: frames over 50 ms (of 89) | 0 -> 0 | 84 -> 0 | 88 -> 11 | 89 -> 0 | 0 -> 0 |
| edit commit -> next frame (ms) | 16 -> 11 | 42 -> 29 | 56 -> 38 | 62 -> 9 | 21 -> 9 |
| edit -> re-checked, incl. 150 ms debounce (ms) | 693 -> 694 | 2361 -> 2410 | 3295 -> 3576 | 577 -> 666 | 603 -> 692 |
| edit -> re-checked: longest task (ms) \* | 546 -> 0 | 2046 -> 134 | 3138 -> 198 | n/a | n/a |
| JS heap loaded / after edits (MB) | 39 / 71 -> 16 / 24 | same | same | n/a | n/a |

| 10 000 QSOs | chromium 1x | 4x | 6x | webkit desktop | webkit iPhone 13 |
| --- | ---: | ---: | ---: | ---: | ---: |
| file chosen -> rows + validation shown (ms) | 227 -> 205 | 976 -> 878 | 1360 -> 1300 | 623 -> 276 | 437 -> 236 |
| load: longest task (ms) | 172 -> 0 | 715 -> 186 | 1016 -> 268 | n/a | n/a |
| scroll: median frame (ms) | 17 -> 17 | 83 -> 33 | 133 -> 50 | 67 -> 17 | 28 -> 17 |
| scroll: frames over 50 ms (of 89) | 0 -> 0 | 86 -> 0 | 89 -> 12 | 88 -> 0 | 0 -> 0 |
| edit commit -> next frame (ms) | 13 -> 8 | 46 -> 24 | 73 -> 35 | 60 -> 9 | 21 -> 7 |
| edit -> re-checked, incl. 150 ms debounce (ms) | 275 -> 263 | 639 -> 638 | 904 -> 901 | 275 -> 269 | 257 -> 261 |
| edit -> re-checked: longest task (ms) \* | 125 -> 0 | 437 -> 0 | 665 -> 0 | n/a | n/a |
| JS heap loaded / after edits (MB) | 10 / 16 -> 5.5 / 7.4 | same | same | n/a | n/a |

\* `bench-ui` gained this line with the change; the "before" values were taken
with the same page-side long-task probe on an unchanged build of `origin/main`
(a profiling script, one run). The Chromium phone-viewport rows follow the
desktop ones (50 000 QSOs at 4x: scroll median 50 -> 17 ms, load longest task
2181 -> 259 ms); the full tables are in the pull request.

Trade-offs: the time until the table shows is about the same, up to 7 % longer
at 6x CPU for 50 000 QSOs (the slices and their hand-backs cost a little);
what changed is that the page answers while it loads (longest task 549 -> 62
ms at 1x, 3224 -> 377 ms at 6x), shows progress and can be cancelled. The
re-check as a whole is not faster; it no longer blocks (frames during a
50 000 QSO re-check at 4x stay below 30 ms at the 95th percentile). What
remains in one task: the end of a load (columns, widths, the first window,
~60 ms at 1x) and the end of a check (indexing the result, up to ~200 ms at
6x). The synchronous functions are not slower (`node scripts/bench_adif.mjs`,
50 000 QSOs: validate 420 -> 397 ms, parse 73 -> 67 ms, serialize 180 -> 172
ms, within noise). Memory after a load is lower (lean results); the peak while
reading is unchanged (the validator materializes the tokens before it checks
them), which is what the limits are for.

## ADIF version compliance

The tool targets and declares **ADIF 3.1.8** (https://www.adif.org/318/ADIF_318.htm)
— this must be kept in sync if a newer ADIF version is adopted:
- Exported `.adi` files emit `<ADIF_VER:5>3.1.8` in the header.
- Each loaded file's own declared `ADIF_VER` (if present in its header) is
  parsed and surfaced per-file in the UI, purely informational — the tool
  doesn't refuse or reinterpret files declaring a different/no version.
- The field picker and column-header inline help are backed by ADIF 3.1.8's
  own machine-readable field export (`adif.org.uk/318/resources` →
  `exports/csv/fields.csv`), transformed offline into an embedded JS data
  table (name/type/description for all ~181 QSO-record fields) — not
  hand-typed from memory, so it stays accurate to the spec. Re-run that
  transform against the new export if/when the target version changes.

## Languages

The editor speaks German and English (#108 C3), switched with DE/EN in the
header; it starts in the saved choice (`oe1ebg-adif-lang`), else in the
browser's language. Both texts sit where a text is built:
`tx('ADIF valid', 'ADIF gültig')` from `../shared/js/i18n.js`; static HTML
has `data-de`, `data-de-title`, `data-de-aria-label`, `data-de-placeholder`,
and the help has one block per language (`data-lang-only`). That covers the
whole interface and every message: the validator's
(`../shared/js/adif-validate.js`), the parser's (`../shared/js/adif.js`),
loading, ADX, export decisions and statistics. Issue **codes** stay the
same in both languages. Numbers use the language's separators (6,202 /
6.202). In Node the language is English, so the tests and snapshots read
the English texts; `tests/i18n.test.mjs` and `tests/e2e/adif-i18n.spec.mjs`
check German.

Stays English on purpose: the ADIF specification's own text (field
descriptions in the column tooltips, DXCC entity names), and what is
written into exported files (an export does not change with the
interface language). A change of language rebuilds every text on the
page; messages of a check already made keep their language until the
next check (after an edit, or when a file is loaded again), since the
loaded files' text is not kept to check them again.

## Column order

The table shows the core fields of a QSO first (`js/columns.js`:
CALL, QSO_DATE, TIME_ON, TIME_OFF, BAND, FREQ, MODE, SUBMODE, RST_SENT,
RST_RCVD, NAME, QTH, GRIDSQUARE, as far as the log has them), then the other
fields in the order of the file. Otherwise a log such as the official test
QSOs would start with REMOTE_STATION_LAT, QSO_TRANSCRIPT and MY_AMP, with
CALL and the date far to the right (#108 B4). The toolbar's "core fields
first / file order" switch shows the file's order instead; the choice is
kept on this device (`oe1ebg-adif-column-order`). **Exports always write
the file's order** (fields in order of first appearance, added fields last),
whatever the table shows, so an export does not change with the view.

## Exports

Besides `.adi` and `.adx`, the toolbar offers:
- **`.csv`** — every current column/row, RFC4180-quoted, for spreadsheet use;
  spreadsheet-safe: a value or field name starting with `=`, `+`, `-`, `@`
  or a control character gets a leading `'` (plain numbers like `-10`
  don't; `../shared/js/csv.js`, policy in `../shared/README.md`), and the
  warnings box says how many. The `.adi` export keeps the values exact.
- **SOTA V2 CSV** (activator/chaser mode toggle) — the format SOTA's own
  database importer expects (`V2,<call>,<summit>,<date>,<time>,<band>,<mode>,
  <call>,<summit>,<comment>`), verified against sotadata.org.uk's own docs.
  SOTA's importer has no quoting: commas become `;` and line breaks (and
  other control characters) a blank, so one QSO is one line; the warnings
  box says how many values that changed. No leading `'` (not for a
  spreadsheet).
  Note SOTA's database also accepts standard ADIF directly via `MY_SOTA_REF`/
  `SOTA_REF`/`COMMENT` — the CSV export exists as an alternative for people
  who prefer it, not because ADIF import doesn't work.

A "tools" panel adds a bulk **comment template**: a `{FIELDNAME}` placeholder
string (e.g. `{RST_SENT} {RST_RCVD} thx`) applied to every record whose
`COMMENT` is currently blank — it never overwrites a `COMMENT` you already
typed by hand.

## Search & filter

A filter bar under the toolbar narrows the **table's view** only; every
export still writes the whole log (the bar says so while a filter is
active, next to the "n of N QSOs shown" counter). Filters, all ANDed:
free-text search (case-insensitive substring, any field's value or one
field's), validation status (QSOs with errors / warnings / info, or
issue-free), field conditions (equals, starts with, contains, is empty,
is not empty; case-insensitive), the source file (only with more than one
file loaded) and a `QSO_DATE` range. The range is typed as ISO dates
(`2026-09-01`, `2026-9-1` or `20260901`, shown as `YYYY-MM-DD` once
complete). A calendar button next to each field opens the browser's
picker. A date that is not complete or not ISO is marked and filters
nothing. A QSO edited while filtered stays
visible until the filter is changed, even if it no longer matches. "row N"
in the issue list clears the filters that hide that QSO and goes to it.

`js/filter.js` is pure (`computeView(records, state, ctx)` returns the
record indices to show, or `null` for all) and tested in
`oe1ebg/tests/adif-filter.test.mjs`; `js/filter-ui.js` is the bar. The
filter sets the view (`js/state.js`, `setView`) when the filter, the
validation result, the loaded files or the columns change; after adding,
deleting or sorting rows the view is remapped, not filtered again. The
record holding the focus always stays in the view.

## Files

- `index.html` — markup and CSS; served at the pretty URL `/tools/adif/` on
  oe1ebg.at. Loads `js/app.js` as an ES module, so it needs to be served
  over http (`just preview`, or any static server on `oe1ebg/tools/`).
- `js/compliance.js` — the compliance panel (see *Compliance panel and
  build provenance*); its pure parts tested in
  `oe1ebg/tests/adif-compliance.test.mjs`.
- `build-info.js` — generated by `scripts/build_adif.py`, git-ignored.
- `js/load.js` (loading files in slices: progress, cancel, the resource
  limits; pure, tested in `oe1ebg/tests/adif-chunked.test.mjs`),
  `../shared/js/chunked.js` (the slice runner),
  `js/app.js` (table rendering, editing, validation display, applying a
  loaded file, toolbar), `js/state.js` (the log, the view and the issue index:
  the view contract), `js/table.js` (the virtualized table body),
  `js/export.js` (ADI,
  CSV and SOTA CSV export; pure, unit-tested in `oe1ebg/tests/adif.test.mjs`),
  `js/fields.js` (ADIF 3.1.8 field reference data), `js/filter.js` +
  `js/filter-ui.js` (search & filter, see above), `js/enum-options.js`
  (which cells get a dropdown or suggestions and their options; pure,
  tested in `oe1ebg/tests/adif-enum-options.test.mjs`), `js/cell-editors.js`
  (the select cells and the suggestion list), `js/datetime.js` (ISO
  display and input of date and time fields; pure apart from the picker,
  tested in `oe1ebg/tests/adif-datetime.test.mjs`).
- `../shared/js/adif.js` — ADI parsing and field encoding, shared with the
  confirmation log's ADIF export.
- `../shared/js/adif-validate.js` + `../shared/js/adif-spec-data.js` — the
  validator and its generated spec data (see *Validation*), tested in
  `oe1ebg/tests/adif-validate.test.mjs` with the fixtures in
  `oe1ebg/tests/fixtures/adif/`, their output pinned by
  `oe1ebg/tests/adif-validate-snapshot.test.mjs`.
- `oe1ebg/scripts/bench_adif.mjs` — timing of parse, validate and
  serialize (see *Performance*).
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

## Log statistics

The wrapping overview describes the **whole loaded log**, including incomplete
rows: QSO count, loaded source-file count (including zero-record files), valid
QSO_DATE range, distinct reported callsigns, and recognized bands/modes. Calls
are trimmed and grouped without case differences; portable suffixes stay distinct.
Dates must be real dates from 1930 onward; future dates count while validation
reports them separately. No BAND is inferred from FREQ, or MODE from SUBMODE.

“Log statistics” expands count/percentage tables and completeness counts. Its
Whole log / Shown QSOs selector uses the actual displayed view, including edited
rows pinned until filters change. Exports still include the whole log. BAND,
MODE and SUBMODE use canonical spec spelling without changing stored values.
Whitespace-only values are missing; other whitespace is not silently stripped.
Submodes retain their reported MODE context. Unrecognized submodes can be valid ADIF String values; they are separate from invalid text. DXCC uses the explicit code only,
with bundled official labels; deleted/import-only codes remain recognized, and
code 0 (no entity) is separate from the distinct entity count. Populated fields
exclude wholly blank columns. Missing/invalid-present counts supplement the
validation panel rather than adding conformance errors.

All distribution percentages use the scoped row count, including missing and
invalid buckets, and are rounded to one decimal. Calculations run in slices,
coalesced after committed changes; expanded details are only calculated while
open. The official 3.1.8 fixture has 6,202 QSOs, 6,008 distinct reported calls,
33 bands, 49 modes, 180 populated fields, 340 DXCC entities and a QSO_DATE range
of 1970-01-01–2026-09-05. The retained 3.1.7 fixture's separate expectations
remain covered by `tests/adif-statistics.test.mjs`.

Local calculation benchmark (Node 26.11.1, Apple silicon, five warm samples):
old band/mode summary / new overview / full details medians were 0.41 /
2.67 / 10.06 ms on 6,202 official records, and 1.33 / 13.55 / 57.48 ms on
50,000 synthetic records (CALL, BAND, MODE, QSO_DATE, TIME_ON, FREQ, DXCC).
These measure pure calculation, not DOM rendering; the UI runs it in 10 ms
slices and omits details while collapsed.

## ADX import, validation and conversion (#24)

The file picker and drag/drop accept ADI and ADX; content selects the format,
including a BOM, XML declaration, comments or namespace prefixes. ADI keeps
UTF-8/Windows-1252 recovery and declared-length diagnostics. ADX requires UTF-8;
malformed XML, incompatible XML content, DOCTYPE/custom entities, field CDATA,
nested field elements and wrong structure reject that file without applying any
records. Other valid files in a batch can load; cancelling the batch applies
nothing. Existing size/record/field/value/column limits cover both formats.
New file-rejection codes: `ADX_ENCODING`, `ADX_XML_SYNTAX`, `ADX_STRUCTURE`,
`ADX_PROHIBITED_XML`, `ADX_FIELD_CONTENT`. Changing an APP type within one ADX file is an `APP_FIELD_TYPE_INCONSISTENT` error (the existing ADI warning remains unchanged). Semantic/cell issue codes remain the
shared validator's codes, with per-QSO indices. Firefox's native DOMParser emits
an unavoidable console diagnostic for malformed XML; the corresponding browser
test registers that specific diagnostic with an exact expected count. Other
console/page errors, CSP violations and unstubbed requests still fail tests.

APP elements map to existing `APP_{PROGRAMID}_{FIELDNAME}` names and types;
USERDEF header declarations retain their names, types, enums/ranges, and record
references. Original APP PROGRAMID/FIELDNAME components are retained per record,
including PROGRAMIDs containing underscores; ADI cannot retain that boundary,
so flattening requires explicit approval. Distinct APP identities from different
files retain their own components/types in ADX. When APP identities collapse to one ADI-style name within a source, the editor
uses an internal qualified column for the alternatives; the ordinary ADI
identity retains its stable name. Those qualifiers are never written to ADX:
original attributes/types are retained per record. ADI cannot retain such a
qualified identity, so its export requires deliberate omission or cancellation
in favor of ADX. Namespace prefixes and processing instructions are ignored. XML
entities/numeric references are decoded; XML's standard newline normalization
applies on import. Export escapes XML text/attributes and uses numeric CR
references to retain CR/LF values. Only Intl types allow Unicode; ordinary ADIF
fields retain their ASCII rules. Custom Number ranges accept the full ADIF decimal spelling (including `.5` and `2.`), with bounds checked before and after conversion; Go cross-checks cover these boundaries. New edits are validated directly against their
source definitions in a log containing ADX, never through lossy ASCII output.

Both export buttons cover the whole log. Preflight runs in slices and stops for
losses or incompatible definitions before any log download. Each field/category
shows its reason, count and examples; “Download complete affected list” provides
all occurrences as JSON. No destructive choice is preselected. Choices cover
ASCII/whitespace conversion, international-to-ordinary mapping (with explicit
keep/replace destination choices), custom type conversion, nonstandard-field
USERDEF declarations, conflicting definitions, and deliberate omission. Cancel
to edit individual exceptions; “Export ADX instead” restarts from the original
log so supported international values are retained. Choices apply only to an
export copy and the final message summarizes transformations. Cancelled/failed
exports retain dirty state and restore focus. Invalid edited logs remain
exportable only after explicit approval of the selected output's reported
validation errors; this does not make them conforming ADIF.

Representable fields/definitions survive ADI↔ADX conversion semantically.
Formatting, attribute order, namespace prefixes, processing instructions, ADI
free-text headers, original provenance header values, and generated USERDEF
numbers are not preserved byte-for-byte. ADX retains empty records and empty fields. ADI keeps zero-length fields from
ADX, and requires an explicit decision to omit fieldless ADX records (which ADI
readers cannot restore). The existing ADI-only empty-value handling stays intact.
Unused USERDEF declarations survive export; explicitly removing a column removes
its declarations from the current log. Compatible custom enum/range definitions from
multiple sources are widened. ASCII conversion still uses the existing
transliteration (unsupported non-BMP characters can become `??`); the decision
preview shows the actual result. Unicode controls or unpaired surrogates that
cannot be serialized as XML require editing before export.

Native XML parsing is one synchronous browser operation, bracketed by progress
and cancellation checks; traversal, record validation, preflight and writing run
in cancellable slices. Cancellation cannot interrupt the native parse itself.
The 50 MiB file ceiling remains unchanged; XML temporarily holds a native DOM as well as decoded records, so the ADI memory estimates do not establish an ADX peak-memory guarantee. no runtime XSD engine is bundled and
no imported document can trigger a schema/DTD/network fetch.

### Independent XML checks and upstream deviations

Official fixture/schema sources: [3.1.8 resources](https://adif.org.uk/318/ADIF_318_Resources.htm),
[generic import schema](https://adif.org.uk/318/adx318generic.xsd),
[export schema](https://adif.org.uk/318/adx318.xsd). All are committed unchanged;
`build-adif-spec` now refreshes ADI/ADX fixtures and both schemas. `--zip` and
`--schemas-dir` support fully local regeneration. `just xmlcheck` installs locked
test-only lxml and checks schemas offline; `ADIF_XMLCHECK=require` prevents skips.

Both official schemas (3.1.8.0, 2026-09-26) contain `(?=[a-zA-Z])` lookahead in
`Secondary_Administrative_Subdivision_Enumeration_Alt`. That is outside XML
Schema 1.0 regular-expression syntax, so libxml2 refuses to compile them.
`scripts/check_adx_schema.py` keeps the originals unchanged, removes only those
two lookaheads in memory for XSD compilation, and additionally checks the
**original** expression on CNTY_ALT/MY_CNTY_ALT in Python. Unexpected non-XSD
patterns fail. Regression cases require rejection of repeated/trailing
spaces/dashes, retaining the original constraint alongside the XSD checks.
This follows the intent of the spec's subdivision type and its documented
schema version; it is an upstream schema-compatibility deviation, not a relaxed
application validator. [Specification](https://adif.org.uk/318/ADIF_318.htm#ADX_Schemas)

The schemas intentionally omit advisory CONTEST_ID/SUBMODE enumeration checks;
they also omit STATE/MY_STATE, several USERDEF name/reference/type/restriction
checks, APP contents against TYPE, and duplicate fields. The browser's shared
semantic checks remain necessary. ADI→ADX→XSD adds an independent structural and
value check of the recovered/exported representation, but cannot prove original
ADI tag lengths, boundaries, encoding or recoverability. Original ADI source
checks, snapshots and Go cross-checks remain separate required gates.
