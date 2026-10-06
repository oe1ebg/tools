from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from pathlib import Path

from single_file import bundle_modules, inline_vendor, module_order, script_safe, vendor_licenses, vendor_refs

# Build step for the offline confirmation log (oe1ebg/tools/confirm/). Runs
# before scripts/stage_tools.py and `zensical build`, which copy the generated
# files into content/confirm/ and then site/.
# Stdlib only. Produces three git-ignored files:
#
# 1. confirm-offline.html — the whole tool in ONE file (all js/ modules and
#    the tools/shared/data/ files it loads inlined, so run the data steps
#    first). Copy it to a USB stick or laptop and open it via file://, where neither service workers nor ES
#    module scripts work. Modules are "bundled" by plain concatenation in
#    dependency order with import lines and `export` keywords stripped,
#    wrapped in one IIFE (scripts/single_file.py has the rules this puts on
#    the modules).
#
# 2. precache.js — the service worker's file list plus a content-hash
#    version (see tools/confirm/sw.js). The list includes the files from
#    tools/shared/ the tool uses (imported modules, Leaflet), as relative
#    URLs (../shared/…). Any change to any shipped file changes the version, which makes browsers install the new version in
#    the background (activated only when the user clicks "Update").
#
# 3. build-info.js — `self.CONFIRM_BUILD = { commit, version }` for the
#    footer ("commit abc1234 · data 1a2b3c4d5e6f"). The commit comes from the
#    GIT_SHA env var (Docker build arg / Justfile; default "dev"). It is
#    deliberately NOT in precache.js and NOT part of the content hash: the
#    browser byte-compares precache.js (imported by sw.js) to detect updates,
#    so a commit in there would offer a no-op "Update" (re-downloading ~5 MB
#    of data) after every oe1ebg commit, even ones that don't touch this
#    tool. build-info.js is precached but unhashed, so the footer shows the
#    commit the installed version was built from, and the version still
#    changes only with the shipped content (incl. the weekly/monthly data
#    refreshes, which have no new commit). The single-file bundle gets the
#    same object inlined.

OE1EBG_DIR = Path(__file__).resolve().parent.parent
CONFIRM_DIR = OE1EBG_DIR / "tools" / "confirm"
BUNDLE_NAME = "confirm-offline.html"
PRECACHE_NAME = "precache.js"
BUILD_INFO_NAME = "build-info.js"

# Not precached by the service worker. The single-file bundle duplicates
# everything else (incl. the multi-MB data), so it's only a download.
# Markdown (README.md, AGENTS.md) isn't published at all (scripts/stage_tools.py).
EXCLUDE = {"sw.js", PRECACHE_NAME, BUNDLE_NAME, BUILD_INFO_NAME}
# Precached, but not part of the content hash (see build-info.js above).
UNHASHED = [BUILD_INFO_NAME]


def git_commit() -> str:
    """Short commit SHA (7 chars) from $GIT_SHA (full or short), else "dev"."""
    sha = os.environ.get("GIT_SHA", "").strip().lower()
    return sha[:7] if re.fullmatch(r"[0-9a-f]{7,40}", sha) else "dev"


def build_info_js(build: dict) -> str:
    return f"self.CONFIRM_BUILD = {json.dumps(build)};\n"

SCRIPT_BLOCK_RE = re.compile(r"<!-- CONFIRM-SCRIPT-BEGIN -->.*?<!-- CONFIRM-SCRIPT-END -->", re.S)
VENDOR_BLOCK_RE = re.compile(r"<!-- CONFIRM-VENDOR-BEGIN -->(.*?)<!-- CONFIRM-VENDOR-END -->", re.S)
LICENSES_MARKER = "<!-- CONFIRM-LICENSES -->"
ENTRY = CONFIRM_DIR / "js" / "app.js"
DATA_DIR = OE1EBG_DIR / "tools" / "shared" / "data"
DATA_CALL_RE = re.compile(r"""loadDataFile\(\s*['"]([\w.-]+\.json)['"]""")


def data_files() -> list[Path]:
    """The tools/shared/data/ files the tool loads: every loadDataFile('x.json')
    literal in its modules, as far as they have been built (the tool runs
    without them, e.g. in a fresh checkout; run the data steps first)."""
    names = sorted({n for p in module_order(ENTRY) for n in DATA_CALL_RE.findall(p.read_text(encoding="utf-8"))})
    missing = [n for n in names if not (DATA_DIR / n).exists()]
    if missing:
        print(f"confirm: WARNING data not built, left out: {', '.join(missing)} (run `just build-confirm`)")
    return [DATA_DIR / n for n in names if n not in missing]


def inline_data() -> str:
    """The data files as globalThis.OE1EBG_DATA (read by shared/js/data.js);
    nothing at all when none have been built (data.js then finds no data)."""
    payload = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in data_files()}
    if not payload:
        return ""
    # "<" escaped so no string in the data can close the <script> element.
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    return f"<script>\nglobalThis.OE1EBG_DATA = {text};\n</script>\n"


def build_bundle(build: dict) -> str:
    html = (CONFIRM_DIR / "index.html").read_text(encoding="utf-8")
    # build-info.js (replaced by the CONFIRM-SCRIPT block) inlined before the app.
    js = script_safe(build_info_js(build) + bundle_modules(ENTRY))
    data = inline_data()
    html, n = SCRIPT_BLOCK_RE.subn(lambda _m: f"{data}<script>\n{js}</script>", html)
    if n != 1:
        raise SystemExit("index.html: CONFIRM-SCRIPT markers not found")
    vendor = VENDOR_BLOCK_RE.search(html)
    if not vendor:
        raise SystemExit("index.html: CONFIRM-VENDOR markers not found")
    licenses = vendor_licenses(vendor.group(1), CONFIRM_DIR)
    html = html[:vendor.start()] + inline_vendor(vendor.group(1), CONFIRM_DIR) + html[vendor.end():]
    # Licence texts of the inlined third-party code, in the footer.
    if html.count(LICENSES_MARKER) != 1:
        raise SystemExit(f"index.html: {LICENSES_MARKER} not found")
    html = html.replace(LICENSES_MARKER, licenses)
    # No manifest (meaningless on file://); icon inlined so the file is self-contained.
    html = re.sub(r'\s*<link rel="manifest"[^>]*>', "", html)
    icon = base64.b64encode((CONFIRM_DIR / "icon.svg").read_bytes()).decode()
    html = html.replace('href="icon.svg"', f'href="data:image/svg+xml;base64,{icon}"')
    return html


def shared_files() -> list[Path]:
    """Files outside tools/confirm/ the tool loads: imported modules, vendor block, data."""
    html = (CONFIRM_DIR / "index.html").read_text(encoding="utf-8")
    block = VENDOR_BLOCK_RE.search(html)
    vendor = [(CONFIRM_DIR / ref).resolve() for ref in vendor_refs(block.group(1))] if block else []
    root = CONFIRM_DIR.resolve()
    return sorted({p for p in module_order(ENTRY) + vendor + data_files() if not p.is_relative_to(root)})


def shipped_files() -> list[Path]:
    files = []
    for p in sorted(CONFIRM_DIR.rglob("*")):
        if p.is_file() and p.name not in EXCLUDE and p.suffix != ".md" and not p.name.startswith("."):
            files.append(p)
    return files + shared_files()


def url_of(p: Path) -> str:
    """Precache entry: path relative to tools/confirm/ (= /confirm/ on the site)."""
    return Path(os.path.relpath(p.resolve(), CONFIRM_DIR.resolve())).as_posix()


def main() -> None:
    # The bundle and build-info.js are excluded from the hash, so the order
    # doesn't matter: hash first, then both can carry the version.
    files = shipped_files()
    h = hashlib.sha256()
    for p in files:
        h.update(url_of(p).encode())
        h.update(b"\0")
        h.update(p.read_bytes())
    version = h.hexdigest()[:12]
    build = {"commit": git_commit(), "version": version}

    (CONFIRM_DIR / BUILD_INFO_NAME).write_text(
        "// Generated by scripts/build_confirm.py — do not edit.\n" + build_info_js(build), encoding="utf-8")
    (CONFIRM_DIR / BUNDLE_NAME).write_text(build_bundle(build), encoding="utf-8")

    entries = ["./"] + [url_of(p) for p in files] + UNHASHED
    listing = ",\n".join(f"    {e!r}" for e in entries).replace("'", '"')
    (CONFIRM_DIR / PRECACHE_NAME).write_text(
        "// Generated by scripts/build_confirm.py — do not edit.\n"
        f'self.CONFIRM_PRECACHE = {{\n  version: "{version}",\n  files: [\n{listing},\n  ],\n}};\n',
        encoding="utf-8",
    )
    total = sum(p.stat().st_size for p in files)
    print(f"confirm: commit {build['commit']}, version {version}, {len(files)} files, {total / 1024:.0f} KiB precached; wrote {BUNDLE_NAME}")


if __name__ == "__main__":
    main()
