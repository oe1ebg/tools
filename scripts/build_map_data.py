from __future__ import annotations

import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Offline basemap for the confirmation log's map view (tools/confirm/,
# "Karte"): vector outlines only, no tiles — drawn by the vendored Leaflet.
# Output: tools/shared/data/vienna-map.json (see tools/confirm/AGENTS.md).
#
# Sources:
# - Stadt Wien WFS ogdwien:BEZIRKSGRENZEOGD (CC BY 4.0) — the 23 district
#   boundaries, fetched in WGS84 at build time (cached 30 days,
#   VIENNA_MAP_FORCE_REFRESH=1; a failed refresh falls back to the cache).
# - OpenStreetMap (ODbL) — main roads and the larger waters (Donau, Neue
#   Donau, Donaukanal, Alte Donau, ...). Overpass is often overloaded and CI
#   has no cache, so the processed result is a COMMITTED snapshot,
#   oe1ebg/map-osm.json, refreshed by hand with `--refresh-osm`
#   (`just refresh-map`) — same reasoning as location-pois.json.
#
# All geometry is simplified (Ramer-Douglas-Peucker) to map precision and
# rounded to 5 decimals (~1 m); coordinates are [lat, lon] (Leaflet order).

WFS_URL = (
    "https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0"
    "&typeName=ogdwien:BEZIRKSGRENZEOGD&srsName=EPSG:4326&outputFormat=json"
)
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
OVERPASS_QUERY = """
[out:json][timeout:300];
area["ISO3166-2"="AT-9"]["admin_level"="4"]->.w;
(
  way["highway"~"^(motorway|trunk|primary|secondary)$"](area.w);
  nwr["water"="river"](area.w);
  way["waterway"="riverbank"](area.w);
  relation["natural"="water"]["water"~"river|oxbow|lake"]["name"](area.w);
);
out geom qt;
"""
CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
# Simplification tolerances in metres.
TOL_DISTRICT_M = 8
TOL_WATER_M = 8
TOL_ROAD_M = 10
MIN_WATER_AREA_M2 = 20_000  # drop tiny ponds/fragments

OE1EBG_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = OE1EBG_DIR / ".cache" / "vienna-map"
OSM_SNAPSHOT_PATH = OE1EBG_DIR / "map-osm.json"
OUTPUT_PATH = OE1EBG_DIR / "tools" / "shared" / "data" / "vienna-map.json"


def log(msg: str) -> None:
    print(f"build_map_data: {msg}")


def http_get_json(url: str, data: bytes | None = None, timeout: int = 300):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "oe1ebg.at build (confirm tool)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# --- geometry -----------------------------------------------------------

def _xy(p, lat0):
    """[lat, lon] -> local metres (equirectangular around lat0)."""
    k = math.cos(math.radians(lat0))
    return (p[1] * 111_320 * k, p[0] * 110_540)


def rdp(points: list, tol_m: float) -> list:
    """Ramer-Douglas-Peucker on [lat, lon] points with a tolerance in metres."""
    if len(points) < 3:
        return points
    lat0 = points[0][0]
    xy = [_xy(p, lat0) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = xy[a], xy[b]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if seg2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > best:
                best, idx = d, i
        if best > tol_m:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def rnd(points: list) -> list:
    out = []
    for lat, lon in points:
        q = [round(lat, 5), round(lon, 5)]
        if not out or out[-1] != q:
            out.append(q)
    return out


def ring_area_m2(ring: list) -> float:
    if len(ring) < 3:
        return 0.0
    lat0 = ring[0][0]
    xy = [_xy(p, lat0) for p in ring]
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(xy, xy[1:] + xy[:1]))) / 2


def centroid(ring: list) -> list:
    """Area-weighted centroid of a ring (label point)."""
    a = cx = cy = 0.0
    for (y1, x1), (y2, x2) in zip(ring, ring[1:] + ring[:1]):
        f = x1 * y2 - x2 * y1
        a += f
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    if a == 0:
        return ring[0]
    return [round(cy / (3 * a), 5), round(cx / (3 * a), 5)]


def assemble_rings(segments: list[list]) -> list[list]:
    """Join open way geometries (multipolygon members) into closed rings."""
    segs = [s[:] for s in segments if len(s) >= 2]
    rings = []
    while segs:
        ring = segs.pop()
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if len(ring) >= 4 and ring[0] == ring[-1]:
            rings.append(ring)
    return rings


# --- OSM snapshot ---------------------------------------------------------

def geom(way: dict) -> list:
    return [[p["lat"], p["lon"]] for p in way.get("geometry") or [] if p]


def process_osm(elements: list[dict]) -> dict:
    roads, water = [], []
    for e in elements:
        tags = e.get("tags", {})
        if e["type"] == "way" and "highway" in tags:
            pts = rnd(rdp(geom(e), TOL_ROAD_M))
            if len(pts) >= 2:
                roads.append([tags["highway"], pts])
        elif e["type"] == "way" and geom(e) and geom(e)[0] == geom(e)[-1]:
            rings = [geom(e)]
            water.append([tags.get("name", ""), rings])
        elif e["type"] == "relation":
            outer = assemble_rings([geom(m) for m in e.get("members", []) if m.get("type") == "way" and m.get("role") != "inner"])
            inner = assemble_rings([geom(m) for m in e.get("members", []) if m.get("type") == "way" and m.get("role") == "inner"])
            for o in outer:
                water.append([tags.get("name", ""), [o] + inner])
    out_water = []
    for name, rings in water:
        if ring_area_m2(rings[0]) < MIN_WATER_AREA_M2:
            continue
        simp = [rnd(rdp(r, TOL_WATER_M)) for r in rings]
        simp = [r for r in simp if len(r) >= 4]
        if simp:
            out_water.append([name, simp])
    roads.sort(key=lambda r: ["motorway", "trunk", "primary", "secondary"].index(r[0]) if r[0] in ("motorway", "trunk", "primary", "secondary") else 9)
    return {"roads": roads, "water": out_water}


def refresh_osm(elements: list[dict]) -> None:
    data = process_osm(elements)
    retrieved = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # One feature per line, so a refresh produces a readable git diff.
    lines = ['{',
             '"source": "© OpenStreetMap-Mitwirkende, ODbL (Overpass, see OVERPASS_QUERY in scripts/build_map_data.py)",',
             f'"retrieved": "{retrieved}",',
             '"water": [']
    lines.append(",\n".join(json.dumps(w, ensure_ascii=False, separators=(",", ":")) for w in data["water"]))
    lines.append('],\n"roads": [')
    lines.append(",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in data["roads"]))
    lines.append(']\n}')
    OSM_SNAPSHOT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"wrote {len(data['water'])} water areas, {len(data['roads'])} road lines to "
        f"{OSM_SNAPSHOT_PATH.relative_to(OE1EBG_DIR)} ({OSM_SNAPSHOT_PATH.stat().st_size / 1024:.0f} KiB)")


def fetch_overpass() -> list[dict]:
    body = urllib.parse.urlencode({"data": OVERPASS_QUERY}).encode()
    last = None
    for url in OVERPASS_URLS:
        try:
            log(f"querying {url} (can take a few minutes)")
            return http_get_json(url, data=body, timeout=400)["elements"]
        except Exception as e:  # noqa: BLE001 — try the next mirror
            last = e
            log(f"Overpass {url} failed: {e}")
    raise last


# --- districts --------------------------------------------------------------

def fetch_districts() -> tuple[list[dict], float]:
    path = CACHE_DIR / "districts.json"
    force = os.environ.get("VIENNA_MAP_FORCE_REFRESH") == "1"
    if path.exists() and not force and time.time() - path.stat().st_mtime < CACHE_MAX_AGE_SECONDS:
        return json.loads(path.read_text(encoding="utf-8"))["features"], path.stat().st_mtime
    try:
        data = http_get_json(WFS_URL)
        if len(data.get("features", [])) != 23:
            raise RuntimeError(f"expected 23 districts, got {len(data.get('features', []))}")
    except Exception as e:  # noqa: BLE001 — fall back to cache
        if path.exists():
            log(f"WARNING: refresh failed ({e}); using cached districts")
            return json.loads(path.read_text(encoding="utf-8"))["features"], path.stat().st_mtime
        raise
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return data["features"], time.time()


def build_districts(features: list[dict]) -> list[dict]:
    out = []
    for f in features:
        p, g = f["properties"], f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        rings = []
        for poly in polys:
            for ring in poly:
                pts = rnd(rdp([[lat, lon] for lon, lat in ring], TOL_DISTRICT_M))
                if len(pts) >= 4:
                    rings.append(pts)
        main = max(rings, key=ring_area_m2)
        out.append({"nr": int(p["BEZNR"]), "name": p.get("NAMEK") or p.get("NAMEG") or "", "label": centroid(main), "rings": rings})
    out.sort(key=lambda d: d["nr"])
    return out


def main() -> None:
    if "--refresh-osm" in sys.argv:
        src = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--from=")), None)
        elements = json.loads(Path(src).read_text())["elements"] if src else fetch_overpass()
        refresh_osm(elements)
        return
    osm = json.loads(OSM_SNAPSHOT_PATH.read_text(encoding="utf-8"))
    features, fetched = fetch_districts()
    districts = build_districts(features)
    lats = [pt[0] for d in districts for r in d["rings"] for pt in r]
    lons = [pt[1] for d in districts for r in d["rings"] for pt in r]
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    out = {
        "schema": 1,
        "meta": {
            "built": iso(time.time()),
            "districts_source": "Stadt Wien – data.wien.gv.at, Bezirksgrenzen Wien (ogdwien:BEZIRKSGRENZEOGD), CC BY 4.0",
            "districts_retrieved": iso(fetched),
            "osm_source": osm["source"],
            "osm_retrieved": osm["retrieved"],
        },
        "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]],
        "districts": districts,
        "water": [{"name": n, "rings": r} for n, r in osm["water"]],
        "roads": [{"c": c, "p": p} for c, p in osm["roads"]],
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    dsize = len(json.dumps(districts, separators=(",", ":")))
    log(f"{len(districts)} districts ({dsize / 1024:.0f} KiB), {len(out['water'])} water areas, {len(out['roads'])} roads "
        f"-> {OUTPUT_PATH.relative_to(OE1EBG_DIR)} ({OUTPUT_PATH.stat().st_size / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
