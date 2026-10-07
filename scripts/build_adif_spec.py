from __future__ import annotations

import argparse
import csv
import io
import json
import os
import urllib.request
import zipfile
from pathlib import Path

# Generates tools/shared/js/adif-spec-data.js, the ADIF specification data
# behind the ADIF validator (tools/shared/js/adif-validate.js): data types,
# fields (type, enumeration, header field, min/max, import-only) and the
# enumerations the validator checks. Source: the official ADIF resources
# archive, which carries the spec's own CSV exports (exports/csv/*.csv):
#
#   https://adif.org.uk/317/resources  (redirects to ADIF_317_resources_<date>.zip)
#
# Nothing is typed in by hand. The output is committed, so regular builds
# never touch the network: run `just build-adif-spec` only when the target
# ADIF version changes (update SPEC_VERSION and RESOURCES_URL, then review
# the validator's tests). The download is cached in .cache/adif-spec/
# (ADIF_SPEC_FORCE_REFRESH=1 bypasses), `--zip PATH` reads a local archive.
# Stdlib only.

SPEC_VERSION = "3.1.7"
RESOURCES_URL = "https://adif.org.uk/317/resources"

OE1EBG_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = OE1EBG_DIR / ".cache" / "adif-spec"
OUTPUT_PATH = OE1EBG_DIR / "tools" / "shared" / "js" / "adif-spec-data.js"

# Enumerations whose values are scoped by another field's value (the
# "[DXCC]" / "[MODE]" in fields.csv): file -> column holding the scope value.
SCOPE_COLUMNS = {
    "Primary_Administrative_Subdivision": "DXCC Entity Code",
    "Secondary_Administrative_Subdivision": "DXCC Entity Code",
    "Submode": "Mode",
}


def num(text: str) -> int | float:
    """A CSV number as int when it is one (120, not 120.0)."""
    f = float(text)
    return int(f) if f.is_integer() else f


def log(msg: str) -> None:
    print(f"build_adif_spec: {msg}")


def resources_zip(local: str | None) -> bytes:
    if local:
        return Path(local).read_bytes()
    path = CACHE_DIR / f"ADIF_{SPEC_VERSION.replace('.', '')}_resources.zip"
    if path.exists() and os.environ.get("ADIF_SPEC_FORCE_REFRESH") != "1":
        log(f"using cached {path.relative_to(OE1EBG_DIR)}")
        return path.read_bytes()
    req = urllib.request.Request(RESOURCES_URL, headers={"User-Agent": "oe1ebg.at build (adif validator)"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    log(f"downloaded {len(data) / 1024:.0f} KiB from {RESOURCES_URL}")
    return data


def read_csvs(data: bytes) -> dict[str, list[dict[str, str]]]:
    """exports/csv/<name>.csv of the archive as {name: rows}."""
    out = {}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            parts = info.filename.split("/")
            if len(parts) >= 3 and parts[-2] == "csv" and parts[-3] == "exports" and parts[-1].endswith(".csv"):
                text = z.read(info).decode("utf-8-sig")
                out[parts[-1][:-4]] = list(csv.DictReader(io.StringIO(text)))
    if "fields" not in out or "datatypes" not in out:
        raise SystemExit("resources archive without exports/csv/fields.csv + datatypes.csv")
    return out


def check_version(name: str, rows: list[dict[str, str]]) -> None:
    versions = {r.get("ADIF Version", "") for r in rows}
    if versions != {SPEC_VERSION}:
        raise SystemExit(f"{name}.csv: ADIF Version {sorted(versions)}, expected {SPEC_VERSION}")


def datatypes(rows: list[dict[str, str]]) -> dict:
    out = {}
    for r in rows:
        d: dict = {}
        if r["Data Type Indicator"]:
            d["indicator"] = r["Data Type Indicator"]
        if r["Minimum Value"]:
            d["min"] = num(r["Minimum Value"])
        if r["Maximum Value"]:
            d["max"] = num(r["Maximum Value"])
        if r["Import-only"]:
            d["importOnly"] = True
        out[r["Data Type Name"]] = d
    return out


def fields(rows: list[dict[str, str]]) -> dict:
    out = {}
    for r in rows:
        types = [t.strip() for t in r["Data Type"].split(",")]
        d: dict = {"type": types[0]}
        if len(types) > 1:
            d["altTypes"] = types[1:]  # e.g. CREDIT_SUBMITTED: CreditList, AwardList (import-only)
        enum = r["Enumeration"]
        if enum:
            name, _, scope = enum.partition("[")
            d["enum"] = name.split(",")[0].strip()
            if scope:
                d["enumScope"] = scope.rstrip("]")
        if r["Header Field"]:
            d["header"] = True
        if r["Minimum Value"]:
            d["min"] = num(r["Minimum Value"])
        if r["Maximum Value"]:
            d["max"] = num(r["Maximum Value"])
        if r["Import-only"]:
            d["importOnly"] = True
        # ANT_AZ / ANT_EL: "Values outside this range are import-only"
        if "outside this range are import-only" in r["Description"]:
            d["rangeImportOnly"] = True
        out[r["Field Name"]] = d
    return out


def enumerations(csvs: dict[str, list[dict[str, str]]]) -> dict:
    out = {}
    for key, rows in sorted(csvs.items()):
        if not key.startswith("enumerations_") or not rows:
            continue
        check_version(key, rows)
        name = rows[0]["Enumeration Name"]
        value_col = list(rows[0].keys())[1]  # the code column follows "Enumeration Name"
        e: dict = {}
        scope_col = SCOPE_COLUMNS.get(name)
        if scope_col:
            by_scope: dict[str, list[str]] = {}
            for r in rows:
                by_scope.setdefault(r[scope_col].strip().upper(), []).append(r[value_col])
            e["byScope"] = {k: sorted(set(v)) for k, v in sorted(by_scope.items())}
        else:
            e["values"] = [r[value_col] for r in rows]
        import_only = sorted({r[value_col] for r in rows if r.get("Import-only")})
        if import_only:
            e["importOnly"] = import_only
        if name == "Band":
            e["ranges"] = {r["Band"]: [num(r["Lower Freq (MHz)"]), num(r["Upper Freq (MHz)"])] for r in rows}
        out[name] = e
    return out


def render(spec: dict) -> str:
    def js(obj) -> str:
        return json.dumps(obj, ensure_ascii=True, separators=(",", ":"), sort_keys=True)

    lines = [
        "// GENERATED by oe1ebg/scripts/build_adif_spec.py (`just build-adif-spec`) from",
        f"// the official ADIF {SPEC_VERSION} resources (exports/csv). Do not edit by hand.",
        "// Read by adif-validate.js. Plain data, no logic.",
        "",
        f"export const ADIF_SPEC_VERSION = '{SPEC_VERSION}';",
        "",
        "// Data types: indicator letter (the optional third part of a tag), min/max, import-only.",
        f"export const ADIF_SPEC_DATATYPES = {js(spec['datatypes'])};",
        "",
        "// Fields: type, enumeration (enumScope: the field that selects its values), header field, min/max.",
        "export const ADIF_SPEC_FIELDS = {",
    ]
    lines += [f"  {json.dumps(k)}: {js(v)}," for k, v in spec["fields"].items()]
    lines += [
        "};",
        "",
        "// Enumerations: values (or byScope: values per scope value), importOnly; Band: ranges in MHz.",
        "export const ADIF_SPEC_ENUMS = {",
    ]
    lines += [f"  {json.dumps(k)}: {js(v)}," for k, v in spec["enums"].items()]
    lines += ["};", ""]
    text = "\n".join(lines)
    if "<!--" in text:  # scripts/single_file.py refuses it
        raise SystemExit("generated data contains '<!--'")
    return text


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--zip", help="read this resources archive instead of downloading it")
    args = ap.parse_args()
    csvs = read_csvs(resources_zip(args.zip))
    check_version("fields", csvs["fields"])
    check_version("datatypes", csvs["datatypes"])
    spec = {
        "datatypes": datatypes(csvs["datatypes"]),
        "fields": fields(csvs["fields"]),
        "enums": enumerations(csvs),
    }
    text = render(spec)
    OUTPUT_PATH.write_text(text, encoding="utf-8")
    log(f"wrote {OUTPUT_PATH.relative_to(OE1EBG_DIR)} ({len(text.encode()) / 1024:.0f} KiB, "
        f"{len(spec['fields'])} fields, {len(spec['enums'])} enumerations)")


if __name__ == "__main__":
    main()
