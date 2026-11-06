from __future__ import annotations

import json
import re
from pathlib import Path

# Local corrections of generated data (issue #180): a committed, reviewed
# JSON file next to the fetch script patches single fields of records the
# upstream source has wrong. Applied after every build of the records, from
# a fresh download or the cache, so a correction never depends on the cache.
#
# File format (e.g. scripts/data/repeater-overrides.json):
#   {"overrides": [{"match": {"call": "OE1XUF", "band": "70cm"},
#                   "set": {"out": 438.3375, "ctcss": 162.2},
#                   "reason": "…", "date": "YYYY-MM-DD"}]}
# `match` selects exactly one record by field equality (strings case-
# insensitive); `set` replaces single fields. Generic over the record type:
# the caller passes the fields an override may match on and set.
#
# Stale overrides show up at every refresh as warnings: one that matches no
# record (or several), and fields upstream already has corrected.

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def load_overrides(path: Path) -> list[dict]:
    """The override list of `path`; [] when the file does not exist."""
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    entries = data.get("overrides") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise ValueError(f"{path.name}: expected an object with an \"overrides\" list")
    return entries


def _same(a, b) -> bool:
    if isinstance(a, str) and isinstance(b, str):
        return a.strip().upper() == b.strip().upper()
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        return abs(a - b) < 1e-6
    return a == b


def describe(entry: dict) -> str:
    match = entry.get("match") or {}
    return " ".join(str(v) for v in match.values()) or "?"


def validate(entries: list[dict], fields: set[str]) -> None:
    """Raise ValueError for a malformed entry: the file is reviewed, so a
    typo must fail the build rather than silently do nothing."""
    for i, e in enumerate(entries, 1):
        where = f"override {i} ({describe(e) if isinstance(e, dict) else '?'})"
        if not isinstance(e, dict):
            raise ValueError(f"{where}: not an object")
        match, patch = e.get("match"), e.get("set")
        if not isinstance(match, dict) or not match:
            raise ValueError(f"{where}: \"match\" must be a non-empty object")
        if not isinstance(patch, dict) or not patch:
            raise ValueError(f"{where}: \"set\" must be a non-empty object")
        unknown = sorted((set(match) | set(patch)) - fields)
        if unknown:
            raise ValueError(f"{where}: unknown field(s) {', '.join(unknown)}")
        if not isinstance(e.get("reason"), str) or not e["reason"].strip():
            raise ValueError(f"{where}: \"reason\" is required")
        if not isinstance(e.get("date"), str) or not DATE_RE.match(e["date"]):
            raise ValueError(f"{where}: \"date\" must be YYYY-MM-DD")


def apply_overrides(records: list[dict], entries: list[dict], fields: set[str]) -> tuple[list[tuple[dict, dict]], list[str]]:
    """Patch `records` in place. Returns ([(record, applied fields)], warnings).

    An entry matching no record or several is not applied (warning). Fields
    whose upstream value already equals the correction are reported; when
    all are, the whole entry is reported as no longer needed.
    """
    validate(entries, fields)
    applied: list[tuple[dict, dict]] = []
    warnings: list[str] = []
    for i, e in enumerate(entries, 1):
        where = f"override {i} ({describe(e)}, {e['date']})"
        hits = [r for r in records if all(_same(r.get(k), v) for k, v in e["match"].items())]
        if not hits:
            warnings.append(f"{where} matches no record — stale? remove it or fix \"match\"")
            continue
        if len(hits) > 1:
            warnings.append(f"{where} matches {len(hits)} records — not applied; narrow \"match\" (e.g. band)")
            continue
        r = hits[0]
        done = [k for k, v in e["set"].items() if k in r and _same(r[k], v)]
        if len(done) == len(e["set"]):
            warnings.append(f"{where}: upstream already has the corrected values — no longer needed, remove it")
            continue
        for k in done:
            warnings.append(f"{where}: upstream already has {k}={r[k]!r} — remove this field")
        patch = {k: v for k, v in e["set"].items() if k not in done}
        r.update(patch)
        applied.append((r, patch))
    return applied, warnings
