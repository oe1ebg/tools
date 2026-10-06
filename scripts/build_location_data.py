from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import tomllib
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Offline Vienna location data for the confirmation log (tools/confirm/):
# lets the browser turn "Waehringerstr 42", "1100 Quellenstr", "Donauturm",
# "JN88ee" or "48.21, 16.37" into PLZ / coordinates / Maidenhead locator
# without any network access. Everything the runtime needs is produced
# here, at build time (see oe1ebg/tools/confirm/README.md, "Vienna location
# lookup"). Output: tools/shared/data/vienna-locations.json.
#
# Sources:
# - Stadt Wien "Adressen Standorte Wien" (WFS layer ogdwien:ADRESSENOGD,
#   CC BY 4.0) — official street names, house numbers, PLZ, district,
#   coordinates. ~290,000 objects, fetched district by district as the city
#   recommends, directly in WGS84 (srsName=EPSG:4326), so no reprojection.
# - OpenStreetMap via Overpass (ODbL) — named landmarks/POIs inside Vienna
#   (one query, representative point only), for "Donauturm", "Kahlenberg"...
#   Much lighter than processing the Austria PBF. Overpass is a shared,
#   often overloaded service (504s are common) and CI builds have no
#   persistent cache, so the processed POI list is a COMMITTED snapshot,
#   oe1ebg/location-pois.json, refreshed by hand with `--refresh-pois`
#   (`just refresh-pois`). The regular build never contacts Overpass.
# - Stadt Wien "GIP.at Namen (Punkt) Wien" (WFS ogdwien:GEONAMENOGD, CC BY
#   4.0) — ~4,750 official and common names for orientation: Flurnamen,
#   Kleingärten, Gemeindebauten, parks, stations, with ALIAS1-3. The point
#   is where the map label sits, not an entrance.
# - Stadt Wien / Wiener Linien "Haltestellen" (WFS ogdwien:HALTESTELLEWLOGD,
#   CC BY 4.0) — ~1,800 stop names; stops named exactly like a street are
#   left out (the street already finds them).
# - OpenStreetMap around Vienna (UMLAND_QUERY, same snapshot file, section
#   "umland"): settlements, airport, hospitals, fire stations, ... within
#   about 25 km of the city boundary.
# - oe1ebg/location-aliases.toml — curated district names, missing
#   landmarks, on-air shorthand, colloquial and former names.
#
# Address downloads are cached in .cache/vienna-location/ (30 days;
# VIENNA_LOCATION_FORCE_REFRESH=1 bypasses). A failed refresh falls back to
# the cache. Text normalization happens at runtime in the browser
# (tools/shared/js/location/normalize.js) so it exists in exactly one place.

WFS_URL = (
    "https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0"
    "&typeName=ogdwien:ADRESSENOGD&srsName=EPSG:4326&outputFormat=json"
    "&propertyName=NAME_STR,NAME_ONR,PLZ,GEB_BEZIRK,SHAPE"
)
WFS_BASE = (
    "https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0"
    "&srsName=EPSG:4326&outputFormat=json&typeName="
)
GIP_NAMES_URL = WFS_BASE + "ogdwien:GEONAMENOGD"
STOPS_URL = WFS_BASE + "ogdwien:HALTESTELLEWLOGD"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
OVERPASS_QUERY = """
[out:json][timeout:400];
area["ISO3166-2"="AT-9"]["admin_level"="4"]->.w;
(
  nwr["name"]["place"~"^(suburb|quarter|neighbourhood|locality|hamlet|village|square|island|islet)$"](area.w);
  nwr["name"]["amenity"~"^(hospital|townhall|university|college|school|police|fire_station|place_of_worship|library|theatre|arts_centre|community_centre|conference_centre|marketplace|bus_station|ferry_terminal|embassy|courthouse|prison)$"](area.w);
  nwr["name"]["tourism"~"^(attraction|museum|viewpoint|zoo|aquarium|theme_park|gallery|camp_site)$"](area.w);
  nwr["name"]["historic"~"^(monument|castle|church|city_gate|ruins|palace|fort|manor|archaeological_site)$"](area.w);
  nwr["name"]["leisure"~"^(park|stadium|sports_centre|garden|nature_reserve|water_park|golf_course|marina)$"](area.w);
  nwr["name"]["natural"~"^(peak|hill|water|wood|island)$"](area.w);
  nwr["name"]["railway"~"^(station|halt)$"](area.w);
  nwr["name"]["public_transport"="station"](area.w);
  nwr["name"]["man_made"~"^(tower|bridge|mast|lighthouse)$"](area.w);
  nwr["name"]["shop"="mall"](area.w);
  nwr["name"]["building"]["wikidata"](area.w);
  nwr["name"]["landuse"~"^(cemetery|allotments)$"](area.w);
);
out center tags qt;
"""
# Around Vienna (about 25 km beyond the city boundary, the city itself
# excluded): settlements, the airport and what a report from there names.
UMLAND_BBOX = "47.90,15.85,48.55,16.95"
UMLAND_QUERY = f"""
[out:json][timeout:400];
area["ISO3166-2"="AT-9"]["admin_level"="4"]->.w;
(
  nwr["name"]["place"~"^(town|village|hamlet|suburb|quarter|neighbourhood|locality|isolated_dwelling)$"]({UMLAND_BBOX});
  nwr["name"]["aeroway"="aerodrome"]({UMLAND_BBOX});
  nwr["name"]["amenity"~"^(hospital|fire_station|police|townhall)$"]({UMLAND_BBOX});
  nwr["name"]["historic"~"^(monastery|castle|palace|ruins)$"]({UMLAND_BBOX});
  nwr["name"]["amenity"="monastery"]({UMLAND_BBOX});
  nwr["name"]["railway"~"^(station|halt)$"]({UMLAND_BBOX});
  nwr["name"]["natural"="peak"]({UMLAND_BBOX});
  nwr["name"]["shop"="mall"]({UMLAND_BBOX});
  nwr["name"]["tourism"~"^(attraction|museum|zoo|theme_park)$"]({UMLAND_BBOX});
  nwr["name"]["leisure"~"^(stadium|water_park|nature_reserve)$"]({UMLAND_BBOX});
)->.u;
nwr.u(area.w)->.inw;
(.u; - .inw;);
out center tags qt;
"""
CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
SCALE = 100_000  # coordinates stored as integer 1e-5 degrees (~1 m)
LAT_BASE, LON_BASE = 48.0, 16.0

# OSM category -> rank (lower = more "landmark-like"); first match wins.
CATEGORY_RANK = [
    ("place", 0), ("aeroway=aerodrome", 1), ("natural=peak", 1), ("natural=hill", 1), ("natural=island", 1),
    ("tourism=attraction", 2), ("tourism=viewpoint", 2), ("historic=castle", 2), ("historic=palace", 2),
    ("railway=station", 3), ("public_transport=station", 3), ("leisure=stadium", 3), ("leisure=park", 3),
    ("amenity=hospital", 3), ("amenity=townhall", 3), ("amenity=university", 3), ("amenity=conference_centre", 3),
    ("man_made=tower", 3), ("tourism=zoo", 3), ("tourism=aquarium", 3), ("shop=mall", 3),
    ("historic=monastery", 3), ("amenity=monastery", 3), ("tourism=museum", 4), ("railway=halt", 4),
    ("amenity", 5), ("tourism", 5), ("historic", 5), ("leisure", 5), ("natural", 5), ("man_made", 5),
    ("aeroway", 5), ("shop", 5), ("landuse", 6), ("building", 6),
]
# OSM name tags -> name type: "" alias, "c" colloquial (loc_name), "h"
# historical (old_name). Stored as plain strings (alias) or [name, type].
NAME_TAGS = [
    ("name:de", ""), ("alt_name", ""), ("short_name", ""), ("official_name", ""), ("name:en", ""),
    ("loc_name", "c"), ("old_name", "h"),
]

OE1EBG_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = OE1EBG_DIR / ".cache" / "vienna-location"
ALIASES_PATH = OE1EBG_DIR / "location-aliases.toml"
POIS_SNAPSHOT_PATH = OE1EBG_DIR / "location-pois.json"
OUTPUT_PATH = OE1EBG_DIR / "tools" / "shared" / "data" / "vienna-locations.json"


def log(msg: str) -> None:
    print(f"build_location_data: {msg}")


def cached_fetch(name: str, fetch) -> tuple[object, float]:
    """Return (parsed JSON, retrieval unix time) from cache or network."""
    path = CACHE_DIR / name
    force = os.environ.get("VIENNA_LOCATION_FORCE_REFRESH") == "1"
    if path.exists() and not force and time.time() - path.stat().st_mtime < CACHE_MAX_AGE_SECONDS:
        return json.loads(path.read_text(encoding="utf-8")), path.stat().st_mtime
    try:
        data = fetch()
    except Exception as e:  # noqa: BLE001 — any failure: fall back to cache
        if path.exists():
            log(f"WARNING: refresh of {name} failed ({e}); using cached copy")
            return json.loads(path.read_text(encoding="utf-8")), path.stat().st_mtime
        raise
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data, time.time()


# Stadt Wien's WFS sometimes drops a connection (CI saw "Connection timed
# out" on one of the ~25 requests a cold build makes): retry before giving up.
HTTP_ATTEMPTS = 4
HTTP_BACKOFF_SECONDS = (10, 30, 60)


def http_get_json(url: str, data: bytes | None = None, timeout: int = 300, attempts: int = HTTP_ATTEMPTS):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "oe1ebg.at build (confirm tool)"})
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (OSError, ValueError) as e:  # URLError/HTTPError/timeouts are OSErrors; ValueError: truncated JSON
            if attempt == attempts:
                raise
            wait = HTTP_BACKOFF_SECONDS[min(attempt, len(HTTP_BACKOFF_SECONDS)) - 1]
            log(f"request failed ({e}), retry {attempt}/{attempts - 1} in {wait} s: {url[:120]}")
            time.sleep(wait)


def fetch_addresses() -> tuple[list[dict], float]:
    features: list[dict] = []
    oldest = time.time()
    for d in range(1, 24):
        bez = f"{d:02d}"
        url = WFS_URL + "&CQL_FILTER=" + urllib.parse.quote(f"GEB_BEZIRK='{bez}'")
        data, fetched = cached_fetch(f"addresses-{bez}.json", lambda url=url: http_get_json(url))
        n = len(data["features"])
        if n == 0:
            raise RuntimeError(f"district {bez}: no addresses returned")
        features += data["features"]
        oldest = min(oldest, fetched)
    return features, oldest


def fetch_overpass(query: str) -> list[dict]:
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for url in OVERPASS_URLS:
        try:
            log(f"querying {url} (can take a few minutes)")
            return http_get_json(url, data=body, timeout=500, attempts=1)["elements"]
        except Exception as e:  # noqa: BLE001 — try the next mirror
            last = e
            log(f"Overpass {url} failed: {e}")
    raise last


def refresh_pois(elements: list[dict], umland_elements: list[dict]) -> None:
    rows = process_osm_places(elements)
    umland = process_osm_places(umland_elements)
    retrieved = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # One place per line, so a refresh produces a readable git diff.
    lines = lambda rs: ",\n".join(json.dumps(r, ensure_ascii=False) for r in rs)  # noqa: E731
    POIS_SNAPSHOT_PATH.write_text(
        "{\n"
        '"source": "© OpenStreetMap-Mitwirkende, ODbL (Overpass, see OVERPASS_QUERY and UMLAND_QUERY in scripts/build_location_data.py)",\n'
        f'"retrieved": "{retrieved}",\n'
        '"fields": ["name", "category", "lat", "lon", "alt_names"],\n'
        '"alt_names": "a string is an alias; [name, \\"c\\"] colloquial (loc_name), [name, \\"h\\"] historical (old_name)",\n'
        f'"places": [\n{lines(rows)}\n],\n'
        f'"umland": [\n{lines(umland)}\n]\n}}\n',
        encoding="utf-8",
    )
    log(f"wrote {len(rows)} Vienna and {len(umland)} Umland places to {POIS_SNAPSHOT_PATH.relative_to(OE1EBG_DIR)}")


def to_int(lat: float, lon: float) -> tuple[int, int]:
    return round((lat - LAT_BASE) * SCALE), round((lon - LON_BASE) * SCALE)


def hn_sort_key(hn: str) -> tuple:
    m = re.search(r"\d+", hn)
    return (0 if hn else 1, int(m.group()) if m else 0, hn)


def build_addresses(features: list[dict]):
    numbered: dict[tuple, list] = {}
    unnumbered: dict[tuple, list] = {}
    for f in features:
        p, g = f["properties"], f.get("geometry")
        street = (p.get("NAME_STR") or "").strip()
        plz = (p.get("PLZ") or "").strip()
        if not street or not plz or not g or g.get("type") != "Point":
            continue
        lon, lat = g["coordinates"][:2]
        hn = re.sub(r"\s+", " ", (p.get("NAME_ONR") or "").strip())
        dist = int(p.get("GEB_BEZIRK") or 0)
        if hn:
            # Several points per address (entrances/buildings): average them.
            acc = numbered.setdefault((street, hn, plz), [0.0, 0.0, 0, dist])
            acc[0] += lat
            acc[1] += lon
            acc[2] += 1
        else:
            key = (street, plz, round(lat, 4), round(lon, 4))
            unnumbered.setdefault(key, [lat, lon, 1, dist])

    rows = [(s, hn, plz, a[0] / a[2], a[1] / a[2], a[3]) for (s, hn, plz), a in numbered.items()]
    rows += [(s, "", plz, a[0], a[1], a[3]) for (s, plz, _, _), a in unnumbered.items()]
    rows.sort(key=lambda r: (r[0], r[2], hn_sort_key(r[1])))

    plz_list = sorted({r[2] for r in rows})
    plz_idx = {p: i for i, p in enumerate(plz_list)}
    streets, hn, ap, ad, alat, alon = [], [], [], [], [], []
    for i, r in enumerate(rows):
        if not streets or streets[-1][0] != r[0]:
            streets.append([r[0], i, 0])
        streets[-1][2] += 1
        la, lo = to_int(r[3], r[4])
        hn.append(r[1])
        ap.append(plz_idx[r[2]])
        ad.append(r[5])
        alat.append(la)
        alon.append(lo)
    return {"plz": plz_list, "streets": streets, "hn": hn, "ap": ap, "ad": ad, "alat": alat, "alon": alon}


def category(tags: dict) -> tuple[str, int]:
    for key, rank in CATEGORY_RANK:
        k, _, v = key.partition("=")
        if k in tags and (not v or tags[k] == v):
            return f"{k}={tags[k]}", rank
    return "other", 9


def dist_m(lat1, lon1, lat2, lon2) -> float:
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return math.hypot(x, y) * 6_371_000


def fetch_gip_names() -> tuple[list[dict], float]:
    data, fetched = cached_fetch("gip-names.json", lambda: http_get_json(GIP_NAMES_URL))
    if len(data["features"]) < 3000:
        raise RuntimeError(f"GIP names: only {len(data['features'])} features")
    return data["features"], fetched


def fetch_stops() -> tuple[list[dict], float]:
    data, fetched = cached_fetch("stops.json", lambda: http_get_json(STOPS_URL))
    if len(data["features"]) < 1000:
        raise RuntimeError(f"stops: only {len(data['features'])} features")
    return data["features"], fetched


def point_of(f: dict):
    g = f.get("geometry") or {}
    return (g["coordinates"][1], g["coordinates"][0]) if g.get("type") == "Point" else None


# "U-Bahn Station Schottentor" -> "Schottentor" (generated short form).
GIP_SHORT_RE = re.compile(r"^U-Bahn[- ]Station\s+(.+)$")


def process_gip_names(features: list[dict]) -> list[list]:
    """GEONAMENOGD -> [name, "gip:<Kategorie>", lat, lon, alts] rows."""
    rows = []
    for f in features:
        p, pt = f["properties"], point_of(f)
        name = (p.get("FEATURENAME") or "").strip()
        if not name or not pt:
            continue
        alts: list = []
        for k in ("ALIAS1", "ALIAS2", "ALIAS3"):
            v = (p.get(k) or "").strip()
            if v and v != name and v not in alts:
                alts.append(v)
        m = GIP_SHORT_RE.match(name)
        if m:
            alts.append([m.group(1), "g"])
        rows.append([name, f"gip:{p.get('NAMECAT_NAME') or 'Name'}", round(pt[0], 5), round(pt[1], 5), alts])
    return rows


def process_stops(features: list[dict], street_names: set[str]) -> list[list]:
    rows = []
    for f in features:
        name, pt = (f["properties"].get("BEZEICHNUNG") or "").strip(), point_of(f)
        if name and pt and name not in street_names:
            rows.append([name, "stop", round(pt[0], 5), round(pt[1], 5), []])
    return rows


def merge_places(places: list[dict], rows: list[list], src: str) -> int:
    """Add rows from another source: the same name (or alias) within 400 m
    is the same place (its names and the source are merged), anything else
    is a new place. Returns the number of merged rows."""
    by_name: dict[str, list[dict]] = {}
    for p in places:
        for n in [p["name"], *map(alt_name, p["alts"])]:
            by_name.setdefault(n.casefold(), []).append(p)
    merged = 0
    for name, cat, lat, lon, alts in rows:
        names = [name, *map(alt_name, alts)]
        hit = next((p for n in names for p in by_name.get(n.casefold(), [])
                    if dist_m(p["lat"], p["lon"], lat, lon) < 400), None)
        if hit:
            have = {hit["name"], *map(alt_name, hit["alts"])}
            for a in [name, *alts]:
                if alt_name(a) not in have:
                    hit["alts"].append(a)
                    have.add(alt_name(a))
            if src not in hit["src"]:
                hit["src"].append(src)
            merged += 1
            continue
        p = {"name": name, "cat": cat, "lat": lat, "lon": lon, "alts": list(alts), "src": [src], "umland": False}
        places.append(p)
        for n in names:
            by_name.setdefault(n.casefold(), []).append(p)
    return merged


def alt_name(a) -> str:
    """An alt_names entry is "name" (alias) or ["name", type]."""
    return a if isinstance(a, str) else a[0]


def process_osm_places(elements: list[dict]) -> list[list]:
    """Overpass elements -> deduplicated [name, category, lat, lon, alts] rows."""
    found = []
    for e in elements:
        tags = e.get("tags", {})
        name = tags.get("name", "").strip()
        c = e.get("center") or ({"lat": e["lat"], "lon": e["lon"]} if "lat" in e else None)
        if not name or not c:
            continue
        cat, rank = category(tags)
        alts: list = []
        for t, kind in NAME_TAGS:
            for v in tags.get(t, "").split(";"):
                v = v.strip()
                if v and v != name and all(alt_name(a) != v for a in alts):
                    alts.append([v, kind] if kind else v)
        found.append({"name": name, "cat": cat, "rank": rank, "lat": c["lat"], "lon": c["lon"], "alts": alts})

    # Same name within 400 m = same thing (e.g. station node + building):
    # keep the most landmark-like, merge alternative names.
    found.sort(key=lambda p: p["rank"])
    kept: list[dict] = []
    by_name: dict[str, list[dict]] = {}
    for p in found:
        key = p["name"].casefold()
        dup = next((k for k in by_name.get(key, []) if dist_m(k["lat"], k["lon"], p["lat"], p["lon"]) < 400), None)
        if dup:
            have = {alt_name(a) for a in dup["alts"]}
            dup["alts"] += [a for a in p["alts"] if alt_name(a) not in have]
            continue
        by_name.setdefault(key, []).append(p)
        kept.append(p)
    rows = [[p["name"], p["cat"], round(p["lat"], 5), round(p["lon"], 5), p["alts"]] for p in kept]
    rows.sort(key=lambda r: (r[0], r[2], r[3]))
    return rows


def build_places(snapshot: dict, aliases_cfg: dict, gip_rows: list[list], stop_rows: list[list]) -> list[list]:
    """Schema 2 rows: [name, category, lat, lon, alts, sources, umland]."""
    places = [{"name": r[0], "cat": r[1], "lat": r[2], "lon": r[3], "alts": list(r[4]), "src": ["osm"], "umland": False}
              for r in snapshot["places"]]
    log(f"GIP names: {len(gip_rows)}, {merge_places(places, gip_rows, 'gip')} merged into OSM places")
    log(f"stops: {len(stop_rows)} (not named like a street), {merge_places(places, stop_rows, 'wl')} merged")
    for r in snapshot.get("umland", []):
        places.append({"name": r[0], "cat": r[1], "lat": r[2], "lon": r[3], "alts": list(r[4]), "src": ["osm"], "umland": True})
    for cp in aliases_cfg.get("place", []):
        alts = list(cp.get("aliases", []))
        alts += [[a, "c"] for a in cp.get("colloquial", [])] + [[a, "h"] for a in cp.get("historical", [])]
        places.append({"name": cp["name"], "cat": cp.get("category", "landmark"), "lat": cp["lat"], "lon": cp["lon"],
                       "alts": alts, "src": ["curated"], "umland": bool(cp.get("umland"))})
    out = []
    for p in places:
        la, lo = to_int(p["lat"], p["lon"])
        out.append([p["name"], p["cat"], la, lo, p["alts"], "+".join(p["src"]), 1 if p["umland"] else 0])
    out.sort(key=lambda r: (r[0], r[2], r[3]))
    return out


ALIAS_TYPES = {"": "", "alias": "", "abbrev": "", "colloquial": "c", "historical": "h"}


def resolve_aliases(aliases_cfg: dict, streets: list, places: list) -> list[list]:
    """[[alias]] -> [alias, kind, id, type]; type "" alias, "c" colloquial, "h" historical."""
    street_idx = {s[0]: i for i, s in enumerate(streets)}
    out = []
    for a in aliases_cfg.get("alias", []):
        target, prefer = a["target"], a.get("prefer")
        kind = ALIAS_TYPES[a.get("type", "")]
        cands = [i for i, p in enumerate(places) if p[0] == target or target in map(alt_name, p[4])]
        if prefer:
            cands.sort(key=lambda i: places[i][1] != prefer)
        if cands:
            out.append([a["alias"], "place", cands[0], kind])
        elif target in street_idx:
            out.append([a["alias"], "street", street_idx[target], kind])
        else:
            log(f"WARNING: alias {a['alias']!r}: target {target!r} not found")
    return out


def resolve_families(aliases_cfg: dict, streets: list) -> list[list]:
    """[[family]] -> [name, [street index, ...]]; members must be exact street names."""
    street_idx = {s[0]: i for i, s in enumerate(streets)}
    out = []
    for f in aliases_cfg.get("family", []):
        members = [street_idx[s] for s in f["streets"] if s in street_idx]
        for s in f["streets"]:
            if s not in street_idx:
                log(f"WARNING: family {f['name']!r}: street {s!r} not found")
        if members:
            out.append([f["name"], members])
    return out


def main() -> None:
    if "--refresh-pois" in sys.argv:
        refresh_pois(fetch_overpass(OVERPASS_QUERY), fetch_overpass(UMLAND_QUERY))
        return
    aliases_cfg = tomllib.loads(ALIASES_PATH.read_text(encoding="utf-8"))
    snapshot = json.loads(POIS_SNAPSHOT_PATH.read_text(encoding="utf-8"))
    features, addr_time = fetch_addresses()
    addr = build_addresses(features)
    gip_features, gip_time = fetch_gip_names()
    stop_features, stops_time = fetch_stops()
    street_names = {s[0] for s in addr["streets"]}
    places = build_places(snapshot, aliases_cfg, process_gip_names(gip_features), process_stops(stop_features, street_names))
    aliases = resolve_aliases(aliases_cfg, addr["streets"], places)
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    out = {
        "schema": 2,
        "meta": {
            "built": iso(time.time()),
            "addresses_source": "Stadt Wien – data.wien.gv.at, Adressen Standorte Wien (ogdwien:ADRESSENOGD), CC BY 4.0",
            "addresses_retrieved": iso(addr_time),
            "places_source": "© OpenStreetMap-Mitwirkende, ODbL (Overpass)",
            "places_retrieved": snapshot["retrieved"],
            "gip_names_source": "Stadt Wien – data.wien.gv.at, GIP.at Namen (Punkt) Wien (ogdwien:GEONAMENOGD), CC BY 4.0",
            "gip_names_retrieved": iso(gip_time),
            "stops_source": "Stadt Wien – data.wien.gv.at, Wiener Linien Haltestellen (ogdwien:HALTESTELLEWLOGD), CC BY 4.0",
            "stops_retrieved": iso(stops_time),
            "attribution": "Adressdaten, Ortsnamen (GIP), Haltestellen: Stadt Wien – data.wien.gv.at, CC BY 4.0 · POIs: © OpenStreetMap-Mitwirkende (ODbL)",
        },
        "latBase": LAT_BASE,
        "lonBase": LON_BASE,
        "scale": SCALE,
        **addr,
        "places": places,
        "districts": [[d["nr"], d["names"]] for d in aliases_cfg["district"]],
        "aliases": aliases,
        "families": resolve_families(aliases_cfg, addr["streets"]),
        "genericStreets": aliases_cfg.get("generic", {}).get("streets", []),
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size = OUTPUT_PATH.stat().st_size
    import gzip
    gz = len(gzip.compress(OUTPUT_PATH.read_bytes(), 6))
    log(f"{len(features)} address points -> {len(addr['hn'])} addresses on {len(addr['streets'])} streets, "
        f"{len(addr['plz'])} PLZ; {len(places)} places; {len(aliases)} aliases")
    log(f"wrote {OUTPUT_PATH.relative_to(OE1EBG_DIR)}: {size / 1e6:.2f} MB ({gz / 1e6:.2f} MB gzip)")


if __name__ == "__main__":
    main()
