from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pdfplumber

# Austrian callsign list for the confirmation log (oe1ebg/docs/confirm/):
# autocomplete with name + location, and a "not in the list — typo?" hint.
# Built here, at build time, because the tool must work 100% offline.
#
# Source: the Fernmeldebüro's official "Rufzeichenliste österreichischer
# Amateurfunkstellen" (§ 150 TKG 2021), a ~260-page PDF republished about
# monthly under a changing file name, linked from AMATEUR_PAGE. No
# machine-readable version or maintained git mirror exists (searched
# 2026-10-04, see oe1ebg/confirm-README.md). Every licensed station is
# listed; holders who opted out of publication appear as "*-*-*" but keep
# their callsign, so the list is complete for "is this a valid OE call".
#
# Output keeps only callsign, name and location (Standort) — no street
# addresses, no licence class.

AMATEUR_PAGE = "https://www.fb.gv.at/Funk/amateurfunkdienst.html"
PDF_LINK_RE = re.compile(r'href="([^"]*Rufzeichenliste[^"]*\.pdf)"', re.I)
STAND_RE = re.compile(r"Stand_(\d{2})(\d{2})(\d{2})", re.I)  # ..._Stand_100926.pdf = 2026-09-10
CALL_RE = re.compile(r"^OE\d[A-Z0-9]{1,6}$")
HIDDEN = "*-*-*"
CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

OE1EBG_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = OE1EBG_DIR / ".cache" / "callsigns"
STATE_PATH = CACHE_DIR / "latest.json"  # {"url", "pdf", "fetched"}
OUTPUT_PATH = OE1EBG_DIR / "docs" / "confirm" / "data" / "callsigns-oe.json"


def log(msg: str) -> None:
    print(f"fetch_callsigns: {msg}")


def download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "oe1ebg.at build (confirm tool)"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def fetch_pdf() -> tuple[Path, str]:
    """Return (local pdf path, source url), using the cache when fresh.

    On a network failure an older cached PDF is used rather than failing
    the build — a slightly stale list is far better than none.
    """
    state = json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else None
    cached = CACHE_DIR / state["pdf"] if state else None
    force = os.environ.get("CALLSIGNS_FORCE_REFRESH") == "1"
    if state and cached.exists() and not force:
        age = time.time() - state["fetched"]
        if age < CACHE_MAX_AGE_SECONDS:
            log(f"using cached {cached.name} ({age / 3600:.1f}h old)")
            return cached, state["url"]

    try:
        page = download(AMATEUR_PAGE).decode("utf-8", "replace")
        m = PDF_LINK_RE.search(page)
        if not m:
            raise RuntimeError(f"no Rufzeichenliste PDF link on {AMATEUR_PAGE}")
        url = urllib.parse.urljoin(AMATEUR_PAGE, m.group(1))
        name = Path(urllib.parse.urlparse(url).path).name
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        pdf_path = CACHE_DIR / name
        if not pdf_path.exists() or force:
            log(f"downloading {url}")
            pdf_path.write_bytes(download(url))
        STATE_PATH.write_text(json.dumps({"url": url, "pdf": name, "fetched": time.time()}))
        return pdf_path, url
    except Exception as e:  # noqa: BLE001 — any failure: fall back to cache
        if state and cached.exists():
            log(f"WARNING: refresh failed ({e}); using cached {cached.name}")
            return cached, state["url"]
        raise


def clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def parse_pdf(pdf_path: Path) -> list[list[str]]:
    # Parsing ~260 pages takes ~15s; cache the result per PDF file.
    parsed_cache = pdf_path.with_suffix(".parsed.json")
    if parsed_cache.exists():
        return json.loads(parsed_cache.read_text(encoding="utf-8"))
    rows: dict[str, list[str]] = {}
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for r in table:
                    if not r or not r[0]:
                        continue
                    call = clean(r[0]).upper()
                    if not CALL_RE.match(call):
                        continue  # header row ("Rufzeichen") or junk
                    name, location = clean(r[1]), clean(r[2])
                    rows[call] = [call, "" if name == HIDDEN else name, "" if location == HIDDEN else location]
    out = sorted(rows.values())
    if len(out) < 1000:
        raise RuntimeError(f"only {len(out)} callsigns parsed from {pdf_path.name} — PDF layout changed?")
    parsed_cache.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


def stand_date(name: str) -> str:
    m = STAND_RE.search(name)
    if not m:
        return ""
    d, mo, y = m.groups()
    return f"20{y}-{mo}-{d}"


def main() -> None:
    pdf_path, url = fetch_pdf()
    calls = parse_pdf(pdf_path)
    out = {
        "source": url,
        "stand": stand_date(pdf_path.name),
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "license": "Fernmeldebüro, Rufzeichenliste gemäß § 150 TKG 2021",
        "fields": ["call", "name", "location"],
        "calls": calls,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    hidden = sum(1 for c in calls if not c[1])
    log(f"wrote {len(calls)} callsigns ({hidden} without published details), Stand {out['stand']}, "
        f"{OUTPUT_PATH.stat().st_size / 1024:.0f} KiB -> {OUTPUT_PATH.relative_to(OE1EBG_DIR)}")


if __name__ == "__main__":
    main()
