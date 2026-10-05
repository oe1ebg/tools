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

**Known gaps** (not implemented — flag if you want these):
- No ADX (XML variant) read/write, `.adi` only.
- No validation against ADIF's per-field data types (dates, enumerations,
  etc.) — it's a generic string-tagged editor, not a spec-conformance
  checker.
- No in-browser paste-from-clipboard entry point (file/drag-drop only).
- No USERDEF field type declarations (`<USERDEFn>` header fields) — unknown
  fields round-trip fine as opaque strings, just without type metadata.

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

- `index.html` — markup and CSS; served at the pretty URL `/adif/` on
  oe1ebg.at. Loads `js/app.js` as an ES module, so it needs to be served
  over http (`just oe1ebg preview`, or any static server on `oe1ebg/tools/`).
- `js/app.js` (state, table, file loading, toolbar), `js/export.js` (ADI,
  CSV and SOTA CSV export; pure, unit-tested in `oe1ebg/tests/adif.test.mjs`),
  `js/fields.js` (ADIF 3.1.7 field reference data).
- `../shared/js/adif.js` — ADI parsing and field encoding, shared with the
  confirmation log's ADIF export.
- `adif-editor.html` — generated by `scripts/build_adif.py`
  (`just oe1ebg build-adif`, part of `build`), git-ignored: the whole editor
  in one HTML file, modules inlined (`scripts/single_file.py`). This is the
  "open directly in any browser, no server required" version, linked as
  "single file ↓" in the page header.

The source lives in `oe1ebg/tools/adif/` and is copied into the Zensical `docs_dir` at build time by
`scripts/stage_tools.py`, without this README (a `README.md` inside the
`docs_dir` would become the section's index page and hide `index.html`).

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
