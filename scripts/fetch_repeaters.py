from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# All Austrian voice repeaters for the confirmation log (docs/confirm/):
# search/select the "Relais" in the log header and fill in callsign, output
# frequency, shift, CTCSS and mode — offline, so built here.
#
# Source: the ÖVSV repeater database (https://repeater.oevsv.at, code at
# https://github.com/oevsv/repeater-db), a PostgREST API over PostgreSQL.
# Endpoints (OpenAPI at /api/): /trx (every transceiver: frequencies,
# modes, tones, status, site_name), /site (sites with WGS84 coordinates,
# locator, altitude), and joined views /trx_list, /trx_type, /site_type.
# We join /trx + /site ourselves so that planned/inactive entries are kept
# (the joined views are active-only), restricted to type
# "repeater_voice". Semantics: frequency_tx = repeater output (what you
# listen to), frequency_rx = repeater input (what you transmit on), so
# shift = rx - tx; ctcss_rx = tone the repeater needs from you.
#
# Cached in .cache/repeaters/ (7 days, REPEATERS_FORCE_REFRESH=1). Unlike
# the callsign list, a fetch failure without any cache is NOT fatal: the
# tool then simply has no repeater list (manual entry still works).

API = "https://repeater.oevsv.at/api"
CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
KEEP_STATUS = {"active", "planned", "inactive"}  # drop historic/historisch/obsolete
MODES = [("fm", "FM"), ("dmr", "DMR"), ("c4fm", "C4FM"), ("dstar", "DSTAR"), ("tetra", "TETRA")]

OE1EBG_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = OE1EBG_DIR / ".cache" / "repeaters"
OUTPUT_PATH = OE1EBG_DIR / "docs" / "confirm" / "data" / "repeaters-at.json"


def log(msg: str) -> None:
    print(f"fetch_repeaters: {msg}")


def cached_get(name: str) -> tuple[list, float]:
    path = CACHE_DIR / f"{name}.json"
    force = os.environ.get("REPEATERS_FORCE_REFRESH") == "1"
    if path.exists() and not force and time.time() - path.stat().st_mtime < CACHE_MAX_AGE_SECONDS:
        return json.loads(path.read_text(encoding="utf-8")), path.stat().st_mtime
    try:
        req = urllib.request.Request(f"{API}/{name}", headers={"User-Agent": "oe1ebg.at build (confirm tool)"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not isinstance(data, list) or not data:
            raise RuntimeError(f"/{name}: unexpected response")
    except Exception as e:  # noqa: BLE001 — any failure: fall back to cache
        if path.exists():
            log(f"WARNING: refresh of /{name} failed ({e}); using cached copy")
            return json.loads(path.read_text(encoding="utf-8")), path.stat().st_mtime
        raise
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data, time.time()


def num(v) -> float | None:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def build(trx: list[dict], sites: list[dict]) -> list[dict]:
    by_site = {s["site_name"]: s for s in sites}
    out = []
    for t in trx:
        if t.get("type_of_station") != "repeater_voice" or (t.get("status") or "") not in KEEP_STATUS:
            continue
        out_f, in_f = num(t.get("frequency_tx")), num(t.get("frequency_rx"))
        if out_f is None:
            continue
        site = by_site.get(t.get("site_name")) or {}
        modes = [label for key, label in MODES if t.get(key)]
        r = {
            "call": (t.get("callsign") or "").strip().upper(),
            "site": t.get("site_name") or "",
            "city": site.get("city") or "",
            "lat": round(site["latitude"], 5) if site.get("latitude") is not None else None,
            "lon": round(site["longitude"], 5) if site.get("longitude") is not None else None,
            "locator": (site.get("locator_short") or "")[:6],
            "alt": site.get("sea_level"),
            "band": t.get("band") or "",
            "out": out_f,
            "in": in_f,
            "shift": round(in_f - out_f, 4) if in_f is not None else None,
            "ctcss": num(t.get("ctcss_rx")),
            "modes": modes,
            "status": t["status"],
        }
        for k, src in (("ch", "ch_new"), ("cc", "cc"), ("echolink", "echolink_id"), ("comment", "comment")):
            if t.get(src) not in (None, ""):
                r[k] = t[src]
        if r["call"]:
            out.append(r)
    out.sort(key=lambda r: (r["call"], r["out"]))
    return out


def main() -> None:
    try:
        trx, t_time = cached_get("trx")
        sites, _ = cached_get("site")
    except Exception as e:  # noqa: BLE001
        log(f"WARNING: repeater database unavailable ({e}) and no cache — building without repeater list")
        OUTPUT_PATH.unlink(missing_ok=True)
        return
    reps = build(trx, sites)
    iso = datetime.fromtimestamp(t_time, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps({
        "source": "ÖVSV Repeater-Datenbank, repeater.oevsv.at",
        "retrieved": iso,
        "repeaters": reps,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"wrote {len(reps)} voice repeaters ({sum(1 for r in reps if r['status'] == 'active')} active) "
        f"-> {OUTPUT_PATH.relative_to(OE1EBG_DIR)} ({OUTPUT_PATH.stat().st_size / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
