from __future__ import annotations

import csv
import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Powers the SOTA Alerts Map's "all summits" overlay (oe1ebg/docs/sota-alerts/),
# so the browser never has to fetch this itself: storage.sota.org.uk doesn't
# send CORS headers for browser requests (verified live — see
# oe1ebg/sota-alerts-README.md), and even if it did, ~180,000 individual
# summits is not something a visitor's browser should be downloading fresh
# on every page load. Fetched once here, at build time, and cached across
# rebuilds (see CACHE_DIR below) so iterating locally or rebuilding the
# Docker image doesn't re-download ~24MB every single time.

SUMMITS_CSV_URL = "https://storage.sota.org.uk/summitslist.csv"
CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60  # matches SOTA's own weekly (Sunday) refresh cadence

DOCS_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = DOCS_DIR / ".cache" / "sota-summits"
CACHE_CSV_PATH = CACHE_DIR / "summitslist.csv"
OUTPUT_PATH = DOCS_DIR / "docs" / "sota-alerts" / "data" / "summits.json"
# A much smaller sibling of summits.json, keyed for O(1) lookup by summit
# code and used as a static-first source for per-summit coordinate
# resolution (see index.html's resolveSummits()) — checked before ever
# calling api2.sota.org.uk/api/summits/{assoc}/{code} live, since summit
# coordinates barely change and this turns a cold cache's tens-to-hundreds
# of live per-summit requests into zero for any summit already in this
# weekly-refreshed list. Array-of-tuples rather than one-object-per-summit
# (i.e. summits.json's own shape): ~9.8MB vs ~17.8MB for the identical
# fields, purely from not repeating key names in every entry.
LOOKUP_OUTPUT_PATH = DOCS_DIR / "docs" / "sota-alerts" / "data" / "summit-lookup.json"


def fetch_csv_text() -> str:
    force = os.environ.get("SOTA_SUMMITS_FORCE_REFRESH") == "1"
    if not force and CACHE_CSV_PATH.exists():
        age = time.time() - CACHE_CSV_PATH.stat().st_mtime
        if age < CACHE_MAX_AGE_SECONDS:
            print(f"fetch_summits: using cached CSV ({age / 3600:.1f}h old) at {CACHE_CSV_PATH}")
            return CACHE_CSV_PATH.read_text(encoding="utf-8")
        print(f"fetch_summits: cached CSV is {age / 3600:.1f}h old, re-fetching")

    print(f"fetch_summits: downloading {SUMMITS_CSV_URL}")
    with urllib.request.urlopen(SUMMITS_CSV_URL, timeout=180) as resp:
        data = resp.read().decode("utf-8")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_CSV_PATH.write_text(data, encoding="utf-8")
    return data


def parse_date(value: str | None) -> datetime | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return datetime.strptime(value, "%d/%m/%Y").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_summits(raw: str) -> list[dict]:
    # First line is a "SOTA Summits List (Date=...)" banner, not the header.
    lines = raw.splitlines()
    if lines and not lines[0].startswith("SummitCode"):
        lines = lines[1:]
    reader = csv.DictReader(lines)

    today = datetime.now(timezone.utc)
    summits = []
    for row in reader:
        valid_from = parse_date(row.get("ValidFrom"))
        valid_to = parse_date(row.get("ValidTo"))
        if valid_from and today < valid_from:
            continue
        if valid_to and today > valid_to:
            continue
        try:
            lat = float(row["Latitude"])
            lon = float(row["Longitude"])
        except (KeyError, ValueError):
            continue

        entry = {
            "key": row["SummitCode"],
            "name": row["SummitName"],
            "lat": round(lat, 5),
            "lon": round(lon, 5),
        }
        alt_m = row.get("AltM")
        if alt_m:
            try:
                entry["altM"] = int(float(alt_m))
            except ValueError:
                pass
        points = row.get("Points")
        if points:
            try:
                entry["points"] = int(points)
            except ValueError:
                pass
        # Real per-summit data, not derivable from points alone — checked
        # live: bonus points (always exactly 3 where present) show up at
        # every points tier (1/2/4/6/8/10), not just for one of them.
        bonus_points = row.get("BonusPoints")
        if bonus_points:
            try:
                bonus = int(bonus_points)
                if bonus:
                    entry["bonusPoints"] = bonus
            except ValueError:
                pass
        summits.append(entry)
    return summits


def build_lookup_rows(summits: list[dict]) -> list[list]:
    return [
        [s["key"], s["lat"], s["lon"], s["name"], s.get("altM"), s.get("points"), s.get("bonusPoints")]
        for s in summits
    ]


def main() -> None:
    raw = fetch_csv_text()
    summits = parse_summits(raw)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(summits, separators=(",", ":")), encoding="utf-8")
    print(f"fetch_summits: wrote {len(summits)} summits to {OUTPUT_PATH}")

    lookup_rows = build_lookup_rows(summits)
    LOOKUP_OUTPUT_PATH.write_text(json.dumps(lookup_rows, separators=(",", ":")), encoding="utf-8")
    print(f"fetch_summits: wrote {len(lookup_rows)} lookup rows to {LOOKUP_OUTPUT_PATH}")


if __name__ == "__main__":
    main()
