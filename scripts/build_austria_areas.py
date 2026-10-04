from __future__ import annotations

import csv
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# Offline Austria-wide PLZ and Bezirk areas for the confirmation log's
# location lookup (docs/confirm/): "2340", "Mödling", "Bezirk Baden",
# "Graz" -> centre + Maidenhead locators covering the area (with the share of
# addresses per locator square). Vienna streets/landmarks stay in
# vienna-locations.json (scripts/build_location_data.py); this file only adds
# areas. Design: oe1ebg/confirm-README.md, "Austria-wide PLZ and Bezirke".
#
# Sources:
# - BEV, Österreichisches Adressregister, "Adresse Relationale Tabellen –
#   Stichtagsdaten" (CC BY 4.0) — every address in Austria with GKZ
#   (Gemeindekennziffer), PLZ and coordinates in MGI / Gauß-Krüger
#   (EPSG 31254/31255/31256). A ~100 MB ZIP, republished twice a year.
# - Statistik Austria, "Politische Bezirke" (polbezirke.csv, CC BY 4.0) —
#   Bezirk names; the "Code" column equals GKZ[:3] (Vienna: 901–923).
#
# Like location-pois.json, the processed result is a COMMITTED snapshot
# (oe1ebg/austria-areas.json), so regular/CI builds never download 100 MB:
# - default run (`just build-areas`): validate the snapshot and write the
#   compact docs/confirm/data/austria-areas.json. No network.
# - `--refresh` (`just refresh-areas`): download both sources (cached in
#   .cache/austria-areas/, 30 days; AUSTRIA_AREAS_FORCE_REFRESH=1 bypasses,
#   a failed refresh falls back to the cache), aggregate, rewrite the
#   snapshot. Needs pyproj (the recipe runs `uv run --with pyproj`).

BEV_URL = "https://data.bev.gv.at/download/Adressregister/Adresse_Relationale_Tabellen_Stichtagsdaten.zip"
BEZIRKE_URL = "https://www.statistik.at/verzeichnis/reglisten/polbezirke.csv"
CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

OE1EBG_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = OE1EBG_DIR / ".cache" / "austria-areas"
SNAPSHOT_PATH = OE1EBG_DIR / "austria-areas.json"
OUTPUT_PATH = OE1EBG_DIR / "docs" / "confirm" / "data" / "austria-areas.json"

# Bundesland by the first GKZ digit (short forms as used in addresses).
STATES = ["", "Bgld.", "Ktn.", "NÖ", "OÖ", "Sbg.", "Stmk.", "T", "Vbg.", "W"]
AUSTRIA_BBOX = (46.3, 49.1, 9.4, 17.2)  # south, north, west, east

# Locator coverage lists: biggest squares first until this share is
# covered, at most LOC_MAX entries, nothing below LOC_MIN_SHARE percent.
LOC_COVER = 0.95
LOC_MAX = 12
LOC_MIN_SHARE = 1


def log(msg: str) -> None:
    print(f"build_austria_areas: {msg}")


def cached_download(name: str, url: str) -> Path:
    path = CACHE_DIR / name
    force = os.environ.get("AUSTRIA_AREAS_FORCE_REFRESH") == "1"
    if path.exists() and not force and time.time() - path.stat().st_mtime < CACHE_MAX_AGE_SECONDS:
        return path
    try:
        log(f"downloading {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "oe1ebg.at build (confirm tool)"})
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        with urllib.request.urlopen(req, timeout=600) as resp, open(tmp, "wb") as out:
            while chunk := resp.read(1 << 20):
                out.write(chunk)
        tmp.replace(path)
    except Exception as e:  # noqa: BLE001 — any failure: fall back to cache
        if path.exists():
            log(f"WARNING: refresh of {name} failed ({e}); using cached copy")
            return path
        raise
    return path


def maidenhead(lat: float, lon: float, precision: int = 6) -> str:
    """Same algorithm as docs/confirm/js/location/maidenhead.js."""
    lon += 180
    lat += 90
    out = chr(65 + int(lon // 20)) + chr(65 + int(lat // 10))
    lon %= 20
    lat %= 10
    out += str(int(lon // 2)) + str(int(lat // 1))
    if precision >= 6:
        lon %= 2
        lat %= 1
        out += chr(97 + int(lon * 12)) + chr(97 + int(lat * 24))
    return out


def coverage(counter: Counter, total: int, cap: int = LOC_MAX) -> list[list]:
    out, covered = [], 0
    for loc, n in counter.most_common():
        share = round(100 * n / total)
        if out and (covered >= LOC_COVER * total or len(out) >= cap or share < LOC_MIN_SHARE):
            break
        out.append([loc, share])
        covered += n
    return out


def read_bezirke(path: Path) -> dict[str, dict]:
    """polbezirke.csv -> {code: {name, aliases, vienna}}."""
    text = path.read_bytes().decode("utf-8-sig", errors="replace")
    lines = text.splitlines()
    head = next(i for i, l in enumerate(lines) if l.startswith("Bundeslandkennziffer"))
    out = {}
    for row in csv.reader(lines[head + 1:], delimiter=";"):
        if len(row) < 5 or not row[4].strip().isdigit():
            continue
        code, raw = row[4].strip(), re.sub(r"\s+", " ", row[3]).strip()
        out[code] = {"vienna": code.startswith("9") and code != "900", **bezirk_names(code, raw)}
    return out


def bezirk_names(code: str, raw: str) -> dict:
    """Official name -> display name + search aliases ("Eisenstadt(Stadt)")."""
    if code == "900":
        return {"name": "Wien", "aliases": []}
    m = re.match(r"Wien\s*\d+\.,\s*(.+)$", raw)
    if m:
        return {"name": m.group(1), "aliases": []}
    aliases: list[str] = []
    name = raw
    if m := re.match(r"(.+?)\s*\((Stadt|Land)\)$", raw):
        base, kind = m.group(1), m.group(2)
        name = f"{base} ({kind})"
        aliases = [base, f"{base} Stadt", f"Stadt {base}"] if kind == "Stadt" else [f"{base}-Land", f"{base} Land"]
    elif m := re.match(r"(.+?)[ -](Stadt|Land)$", raw):
        base, kind = m.group(1), m.group(2)
        aliases = [base, f"{base} (Stadt)", f"Stadt {base}"] if kind == "Stadt" else [f"{base}-Land", f"{base} (Land)"]
    elif m := re.match(r"Stadt (.+)$", raw):
        aliases = [m.group(1), f"{m.group(1)} (Stadt)"]
    # "Krems an der Donau (Stadt)" -> also "Krems"
    if (m := re.match(r"(.+?) (?:an der|am|im|in der) ", raw)) and "(Stadt)" in name:
        aliases.append(m.group(1))
    for a in [name, *aliases]:
        if a.startswith("Sankt "):
            aliases.append("St. " + a[6:])
    aliases = [a for a in dict.fromkeys(aliases) if a != name]
    return {"name": name, "aliases": aliases}


def read_addresses(zip_path: Path):
    """Yield (gkz, plz, lat, lon) for every geocoded address."""
    from pyproj import Transformer  # only needed for --refresh

    transformers = {epsg: Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True) for epsg in (31254, 31255, 31256)}
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.upper().endswith("ADRESSE.CSV"))
        with z.open(name) as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""), delimiter=";")
            batch: dict[int, list] = defaultdict(list)

            def flush(epsg):
                rows = batch.pop(epsg, [])
                if not rows:
                    return
                lon, lat = transformers[epsg].transform([r[2] for r in rows], [r[3] for r in rows])
                for r, la, lo in zip(rows, lat, lon):
                    yield r[0], r[1], la, lo

            for row in reader:
                try:
                    epsg = int(row["EPSG"])
                    rw, hw = float(row["RW"]), float(row["HW"])
                except (TypeError, ValueError):
                    continue  # not geocoded / "#"
                gkz, plz = (row["GKZ"] or "").strip(), (row["PLZ"] or "").strip()
                if epsg not in transformers or not re.fullmatch(r"\d{5}", gkz) or not re.fullmatch(r"\d{4}", plz):
                    continue
                batch[epsg].append((gkz, plz, rw, hw))
                if len(batch[epsg]) >= 200_000:
                    yield from flush(epsg)
            for epsg in list(batch):
                yield from flush(epsg)


def read_gemeinden(zip_path: Path) -> dict[str, str]:
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.upper().endswith("GEMEINDE.CSV"))
        with z.open(name) as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""), delimiter=";")
            return {r["GKZ"].strip(): r["GEMEINDENAME"].strip() for r in reader}


def stichtag(zip_path: Path) -> str:
    with zipfile.ZipFile(zip_path) as z:
        n = next((n for n in z.namelist() if n.lower().startswith("aktualitaetsstand")), None)
        text = z.read(n).decode("latin-1") if n else ""
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", text)
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else ""


class Acc:
    __slots__ = ("n", "lat", "lon", "loc6", "loc4", "sub")

    def __init__(self):
        self.n, self.lat, self.lon = 0, 0.0, 0.0
        self.loc6: Counter = Counter()
        self.loc4: Counter = Counter()
        self.sub: Counter = Counter()  # PLZ: Gemeinde GKZ; Bezirk: PLZ

    def add(self, lat, lon, loc6, sub):
        self.n += 1
        self.lat += lat
        self.lon += lon
        self.loc6[loc6] += 1
        self.loc4[loc6[:4]] += 1
        self.sub[sub] += 1

    def centre(self):
        return round(self.lat / self.n, 5), round(self.lon / self.n, 5)


def refresh() -> None:
    zip_path = cached_download("adressregister.zip", BEV_URL)
    bez_path = cached_download("polbezirke.csv", BEZIRKE_URL)
    bezirke = read_bezirke(bez_path)
    gemeinden = read_gemeinden(zip_path)
    stand = stichtag(zip_path)

    plz_acc: dict[str, Acc] = defaultdict(Acc)
    bez_acc: dict[str, Acc] = defaultdict(Acc)
    count = 0
    for gkz, plz, lat, lon in read_addresses(zip_path):
        loc6 = maidenhead(lat, lon, 6)
        plz_acc[plz].add(lat, lon, loc6, gkz)
        if gkz.startswith("9"):
            # Vienna is a single Gemeinde (GKZ 90001) in the register; its
            # districts follow from the PLZ (1100 -> 910), close enough here.
            bez_acc["900"].add(lat, lon, loc6, plz)
            if 1 <= int(plz[1:3]) <= 23:
                bez_acc["9" + plz[1:3]].add(lat, lon, loc6, plz)
        else:
            bez_acc[gkz[:3]].add(lat, lon, loc6, plz)
        count += 1
        if count % 500_000 == 0:
            log(f"{count} addresses…")

    plz_rows = []
    for plz in sorted(plz_acc):
        a = plz_acc[plz]
        lat, lon = a.centre()
        gem = [gemeinden.get(g, g) for g, n in a.sub.most_common() if n >= 0.05 * a.n]
        gem = list(dict.fromkeys(gem))
        bez = sorted({g[:3] for g, n in a.sub.items() if n >= 0.05 * a.n})
        state = int(a.sub.most_common(1)[0][0][0])
        plz_rows.append([plz, gem[0], gem[1:6], state, bez, lat, lon, a.n,
                         coverage(a.loc6, a.n), len(a.loc6), coverage(a.loc4, a.n, 8)])

    bez_rows = []
    missing = sorted(set(bezirke) - set(bez_acc))
    if missing:
        raise SystemExit(f"Bezirke without addresses: {missing}")
    for code in sorted(bezirke):
        b, a = bezirke[code], bez_acc[code]
        lat, lon = a.centre()
        top_plz = [p for p, _ in a.sub.most_common(8)]
        bez_rows.append([code, b["name"], b["aliases"], int(code[0]), lat, lon, a.n,
                         coverage(a.loc6, a.n), len(a.loc6), coverage(a.loc4, a.n, 8), top_plz])

    check(plz_rows, bez_rows)
    retrieved = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # One area per line, so a refresh produces a readable git diff.
    plz_lines = ",\n".join(json.dumps(r, ensure_ascii=False) for r in plz_rows)
    bez_lines = ",\n".join(json.dumps(r, ensure_ascii=False) for r in bez_rows)
    meta = {
        "built": retrieved,
        "stichtag": stand,
        "addresses_source": "BEV – Österreichisches Adressregister, Adresse Relationale Tabellen – Stichtagsdaten, CC BY 4.0",
        "bezirke_source": "Statistik Austria – Politische Bezirke, CC BY 4.0",
        "attribution": f"© Österreichisches Adressregister, Stichtagsdatum {'.'.join(reversed(stand.split('-')))} · Bezirke: Statistik Austria, CC BY 4.0",
        "addresses": count,
    }
    SNAPSHOT_PATH.write_text(
        "{\n"
        '"schema": 1,\n'
        f'"meta": {json.dumps(meta, ensure_ascii=False)},\n'
        f'"states": {json.dumps(STATES, ensure_ascii=False)},\n'
        '"plzFields": ["plz", "name", "moreGemeinden", "state", "bezirke", "lat", "lon", "addresses", "loc6", "loc6Count", "loc4"],\n'
        '"bezirkFields": ["code", "name", "aliases", "state", "lat", "lon", "addresses", "loc6", "loc6Count", "loc4", "topPlz"],\n'
        f'"plz": [\n{plz_lines}\n],\n'
        f'"bezirke": [\n{bez_lines}\n]\n}}\n',
        encoding="utf-8",
    )
    log(f"{count} addresses -> {len(plz_rows)} PLZ, {len(bez_rows)} Bezirke (Stichtag {stand}); "
        f"wrote {SNAPSHOT_PATH.relative_to(OE1EBG_DIR)}")


def check(plz_rows: list, bez_rows: list) -> None:
    s, n, w, e = AUSTRIA_BBOX
    if len(plz_rows) < 2000:
        raise SystemExit(f"only {len(plz_rows)} PLZ — incomplete data?")
    if len(bez_rows) < 110:
        raise SystemExit(f"only {len(bez_rows)} Bezirke — incomplete data?")
    for r in plz_rows:
        if not (s <= r[5] <= n and w <= r[6] <= e):
            raise SystemExit(f"PLZ {r[0]} centre outside Austria: {r[5]}, {r[6]}")
    for r in bez_rows:
        if not (s <= r[4] <= n and w <= r[5] <= e):
            raise SystemExit(f"Bezirk {r[0]} centre outside Austria: {r[4]}, {r[5]}")


def build() -> None:
    snap = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    if snap.get("schema") != 1:
        raise SystemExit(f"{SNAPSHOT_PATH.name}: unsupported schema {snap.get('schema')}")
    check(snap["plz"], snap["bezirke"])
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size = OUTPUT_PATH.stat().st_size
    gz = len(gzip.compress(OUTPUT_PATH.read_bytes(), 6))
    log(f"{len(snap['plz'])} PLZ, {len(snap['bezirke'])} Bezirke (Stichtag {snap['meta']['stichtag']}); "
        f"wrote {OUTPUT_PATH.relative_to(OE1EBG_DIR)}: {size / 1e3:.0f} KB ({gz / 1e3:.0f} KB gzip)")


if __name__ == "__main__":
    if "--refresh" in sys.argv:
        refresh()
    build()
