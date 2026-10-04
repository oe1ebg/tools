from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from pathlib import Path

# Build step for the offline confirmation log (oe1ebg/tools/confirm/). Runs
# before scripts/stage_tools.py and `zensical build`, which copy the generated
# files into content/confirm/ and then site/.
# Stdlib only. Produces three git-ignored files:
#
# 1. confirm-offline.html — the whole tool in ONE file (all js/ modules and
#    all data/*.json files inlined, so run the data fetch scripts first). Copy it to a USB stick or
#    laptop and open it via file://, where neither service workers nor ES
#    module scripts work. Modules are "bundled" by plain concatenation in
#    dependency order with import lines and `export` keywords stripped,
#    wrapped in one IIFE — so js/ modules must keep their top-level names
#    unique and use only single-statement `import {...} from './x.js';`.
#
# 2. precache.js — the service worker's file list plus a content-hash
#    version (see tools/confirm/sw.js). Any change to any shipped file
#    changes the version, which makes browsers install the new version in
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

IMPORT_RE = re.compile(r"^import\s*\{[^}]*\}\s*from\s*['\"](\./[^'\"]+)['\"];?[ \t]*\n", re.M)
EXPORT_RE = re.compile(r"^export\s+(?=(async\s+)?(function|const|let|class)\b)", re.M)
SCRIPT_BLOCK_RE = re.compile(r"<!-- CONFIRM-SCRIPT-BEGIN -->.*?<!-- CONFIRM-SCRIPT-END -->", re.S)
VENDOR_BLOCK_RE = re.compile(r"<!-- CONFIRM-VENDOR-BEGIN -->(.*?)<!-- CONFIRM-VENDOR-END -->", re.S)
VENDOR_REF_RE = re.compile(r'<link rel="stylesheet" href="([^"]+)">|<script src="([^"]+)"></script>')


def inline_vendor(block: str) -> str:
    """Third-party files (vendor/, e.g. Leaflet) as inline <style>/<script>."""
    def sub(m: re.Match) -> str:
        css, js = m.group(1), m.group(2)
        text = (CONFIRM_DIR / (css or js)).read_text(encoding="utf-8")
        if css:
            return f"<style>\n{text.replace('</style', '<\\/style')}\n</style>"
        return f"<script>\n{text.replace('</script', '<\\/script')}\n</script>"
    return VENDOR_REF_RE.sub(sub, block)


def module_order(entry: Path) -> list[Path]:
    order: list[Path] = []
    seen: set[Path] = set()

    def visit(path: Path) -> None:
        if path in seen:
            return
        seen.add(path)
        for dep in IMPORT_RE.findall(path.read_text(encoding="utf-8")):
            visit((path.parent / dep).resolve())
        order.append(path)

    visit(entry.resolve())
    return order


TOP_DECL_RE = re.compile(r"^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)", re.M)


def bundle_js() -> str:
    parts = []
    declared: dict[str, str] = {}
    for path in module_order(CONFIRM_DIR / "js" / "app.js"):
        for name in TOP_DECL_RE.findall(path.read_text(encoding="utf-8")):
            if name in declared:
                raise SystemExit(f"top-level name {name!r} declared in both {declared[name]} and {path.name} "
                                 "— the offline bundle shares one scope; rename one")
            declared[name] = path.name
        src = path.read_text(encoding="utf-8")
        src = IMPORT_RE.sub("", src)
        src = EXPORT_RE.sub("", src)
        if re.search(r"^\s*(import|export)\b", src, re.M):
            raise SystemExit(f"{path.name}: unsupported import/export form for the offline bundle")
        parts.append(f"// ---- {path.relative_to(CONFIRM_DIR)} ----\n{src}")
    return "(() => {\n'use strict';\n" + "\n".join(parts) + "\n})();\n"


def inline_data() -> str:
    """data/*.json as globalThis.CONFIRM_DATA (read by js/data.js)."""
    data_dir = CONFIRM_DIR / "data"
    files = sorted(data_dir.glob("*.json")) if data_dir.exists() else []
    if not files:
        return ""
    payload = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in files}
    # "<" escaped so no string in the data can close the <script> element.
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    return f"<script>\nglobalThis.CONFIRM_DATA = {text};\n</script>\n"


def build_bundle(build: dict) -> str:
    html = (CONFIRM_DIR / "index.html").read_text(encoding="utf-8")
    # build-info.js (replaced by the CONFIRM-SCRIPT block) inlined before the app.
    js = (build_info_js(build) + bundle_js()).replace("</script", "<\\/script")
    data = inline_data()
    html, n = SCRIPT_BLOCK_RE.subn(lambda _m: f"{data}<script>\n{js}</script>", html)
    if n != 1:
        raise SystemExit("index.html: CONFIRM-SCRIPT markers not found")
    html, n = VENDOR_BLOCK_RE.subn(lambda m: inline_vendor(m.group(1)), html)
    if n != 1:
        raise SystemExit("index.html: CONFIRM-VENDOR markers not found")
    # No manifest (meaningless on file://); icon inlined so the file is self-contained.
    html = re.sub(r'\s*<link rel="manifest"[^>]*>', "", html)
    icon = base64.b64encode((CONFIRM_DIR / "icon.svg").read_bytes()).decode()
    html = html.replace('href="icon.svg"', f'href="data:image/svg+xml;base64,{icon}"')
    return html


def shipped_files() -> list[Path]:
    files = []
    for p in sorted(CONFIRM_DIR.rglob("*")):
        if p.is_file() and p.name not in EXCLUDE and p.suffix != ".md" and not p.name.startswith("."):
            files.append(p)
    return files


def main() -> None:
    # The bundle and build-info.js are excluded from the hash, so the order
    # doesn't matter: hash first, then both can carry the version.
    files = shipped_files()
    h = hashlib.sha256()
    for p in files:
        h.update(p.relative_to(CONFIRM_DIR).as_posix().encode())
        h.update(b"\0")
        h.update(p.read_bytes())
    version = h.hexdigest()[:12]
    build = {"commit": git_commit(), "version": version}

    (CONFIRM_DIR / BUILD_INFO_NAME).write_text(
        "// Generated by scripts/build_confirm.py — do not edit.\n" + build_info_js(build), encoding="utf-8")
    (CONFIRM_DIR / BUNDLE_NAME).write_text(build_bundle(build), encoding="utf-8")

    entries = ["./"] + [p.relative_to(CONFIRM_DIR).as_posix() for p in files] + UNHASHED
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
