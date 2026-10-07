from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from single_file import bundle_modules, inline_vendor, module_order, script_safe, vendor_licenses, vendor_refs

# Build step shared by the offline tools (tools/confirm/, tools/notfunk/):
# scripts/build_<tool>.py describes the tool (OfflineTool) and calls build().
# Runs before scripts/stage_tools.py and `zensical build`, which copy the
# generated files into content/tools/<tool>/ and then site/.
# Stdlib only. Produces three git-ignored files in the tool's directory:
#
# 1. <bundle> (e.g. confirm-offline.html): the whole tool in ONE file (all
#    js/ modules and the tools/shared/data/ files it loads inlined, so run
#    the data steps first). Copy it to a USB stick or laptop and open it via
#    file://, where neither service workers nor ES module scripts work.
#    Modules are "bundled" by plain concatenation in dependency order with
#    import lines and `export` keywords stripped, wrapped in one IIFE
#    (scripts/single_file.py has the rules this puts on the modules).
#
# 2. precache.js: the service worker's file list plus a content-hash
#    version (self.<PREFIX>_PRECACHE, read by tools/shared/js/sw-core.js).
#    The list includes the files from tools/shared/ the tool uses (imported
#    modules, the vendor block, data) as relative URLs (../shared/…). Any
#    change to any shipped file changes the version, which makes browsers
#    install the new version in the background (activated only when the
#    user clicks "Update").
#
# 3. build-info.js: `self.<PREFIX>_BUILD = { commit, version }` for the
#    footer ("commit abc1234 · data 1a2b3c4d5e6f"). The commit comes from the
#    GIT_SHA env var (Docker build arg / Justfile; default "dev"). It is
#    deliberately NOT in precache.js and NOT part of the content hash: the
#    browser byte-compares precache.js (imported by the worker) to detect
#    updates, so a commit in there would offer a no-op "Update"
#    (re-downloading several MB of data) after every oe1ebg commit, even ones
#    that don't touch the tool. build-info.js is precached but unhashed, so
#    the footer shows the commit the installed version was built from, and
#    the version still changes only with the shipped content (incl. the
#    weekly/monthly data refreshes, which have no new commit). The
#    single-file bundle gets the same object inlined.
#
# index.html of a tool carries three markers, named by the tool's prefix
# (CONFIRM, NOTFUNK, …): <!-- <P>-VENDOR-BEGIN/END --> around theme.js, the
# stylesheets and vendored scripts (inlined into the bundle, precached),
# <!-- <P>-SCRIPT-BEGIN/END --> around build-info.js and the module script
# (replaced by the inlined data and the bundled modules), and
# <!-- <P>-LICENSES --> (replaced by the vendored code's licence texts).

OE1EBG_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = OE1EBG_DIR / "tools" / "shared" / "data"
DATA_CALL_RE = re.compile(r"""loadDataFile\(\s*['"]([\w.-]+\.json)['"]""")
PRECACHE_NAME = "precache.js"
BUILD_INFO_NAME = "build-info.js"
# Precached, but not part of the content hash (see build-info.js above).
UNHASHED = [BUILD_INFO_NAME]


@dataclass(frozen=True)
class OfflineTool:
    name: str  # directory under tools/ and URL path, e.g. "confirm"
    bundle: str  # single-file name, e.g. "confirm-offline.html"
    prefix: str  # marker and global prefix, e.g. "CONFIRM"
    recipe: str  # Justfile recipe that builds the data, for the warning

    @property
    def dir(self) -> Path:
        return OE1EBG_DIR / "tools" / self.name

    @property
    def entry(self) -> Path:
        return self.dir / "js" / "app.js"

    @property
    def exclude(self) -> set[str]:
        # Not precached by the service worker. The single-file bundle
        # duplicates everything else (incl. the multi-MB data), so it's only
        # a download. Markdown (README.md, AGENTS.md) isn't published at all
        # (scripts/stage_tools.py).
        return {"sw.js", PRECACHE_NAME, self.bundle, BUILD_INFO_NAME}

    def block_re(self, kind: str) -> re.Pattern[str]:
        return re.compile(rf"<!-- {self.prefix}-{kind}-BEGIN -->(.*?)<!-- {self.prefix}-{kind}-END -->", re.S)


def git_commit() -> str:
    """Short commit SHA (7 chars) from $GIT_SHA (full or short), else "dev"."""
    sha = os.environ.get("GIT_SHA", "").strip().lower()
    return sha[:7] if re.fullmatch(r"[0-9a-f]{7,40}", sha) else "dev"


def build_info_js(tool: OfflineTool, build: dict) -> str:
    return f"self.{tool.prefix}_BUILD = {json.dumps(build)};\n"


def data_files(tool: OfflineTool) -> list[Path]:
    """The tools/shared/data/ files the tool loads: every loadDataFile('x.json')
    literal in its modules, as far as they have been built (the tool runs
    without them, e.g. in a fresh checkout; run the data steps first)."""
    names = sorted({n for p in module_order(tool.entry) for n in DATA_CALL_RE.findall(p.read_text(encoding="utf-8"))})
    missing = [n for n in names if not (DATA_DIR / n).exists()]
    if missing:
        print(f"{tool.name}: WARNING data not built, left out: {', '.join(missing)} (run `just {tool.recipe}`)")
    return [DATA_DIR / n for n in names if n not in missing]


def inline_data(tool: OfflineTool) -> str:
    """The data files as globalThis.OE1EBG_DATA (read by shared/js/data.js);
    nothing at all when none have been built (data.js then finds no data)."""
    payload = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in data_files(tool)}
    if not payload:
        return ""
    # "<" escaped so no string in the data can close the <script> element.
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    return f"<script>\nglobalThis.OE1EBG_DATA = {text};\n</script>\n"


def build_bundle(tool: OfflineTool, build: dict) -> str:
    html = (tool.dir / "index.html").read_text(encoding="utf-8")
    # build-info.js (replaced by the SCRIPT block) inlined before the app.
    js = script_safe(build_info_js(tool, build) + bundle_modules(tool.entry))
    data = inline_data(tool)
    html, n = tool.block_re("SCRIPT").subn(lambda _m: f"{data}<script>\n{js}</script>", html)
    if n != 1:
        raise SystemExit(f"{tool.name}/index.html: {tool.prefix}-SCRIPT markers not found")
    vendor = tool.block_re("VENDOR").search(html)
    if not vendor:
        raise SystemExit(f"{tool.name}/index.html: {tool.prefix}-VENDOR markers not found")
    licenses = vendor_licenses(vendor.group(1), tool.dir)
    html = html[:vendor.start()] + inline_vendor(vendor.group(1), tool.dir) + html[vendor.end():]
    # Licence texts of the inlined third-party code, in the footer.
    marker = f"<!-- {tool.prefix}-LICENSES -->"
    if html.count(marker) != 1:
        raise SystemExit(f"{tool.name}/index.html: {marker} not found")
    html = html.replace(marker, licenses)
    # No manifest or home-screen icon (meaningless on file://); icon inlined
    # so the file is self-contained.
    html = re.sub(r'\s*<link rel="manifest"[^>]*>', "", html)
    html = re.sub(r'\s*<!-- iOS ignores [^>]*-->\s*<link rel="apple-touch-icon"[^>]*>', "", html)
    icon = base64.b64encode((tool.dir / "icon.svg").read_bytes()).decode()
    html = html.replace('href="icon.svg"', f'href="data:image/svg+xml;base64,{icon}"')
    return html


def shared_files(tool: OfflineTool) -> list[Path]:
    """Files outside the tool's directory it loads: imported modules, vendor block, data."""
    html = (tool.dir / "index.html").read_text(encoding="utf-8")
    block = tool.block_re("VENDOR").search(html)
    vendor = [(tool.dir / ref).resolve() for ref in vendor_refs(block.group(1))] if block else []
    root = tool.dir.resolve()
    return sorted({p for p in module_order(tool.entry) + vendor + data_files(tool) if not p.is_relative_to(root)})


def shipped_files(tool: OfflineTool) -> list[Path]:
    files = []
    for p in sorted(tool.dir.rglob("*")):
        if p.is_file() and p.name not in tool.exclude and p.suffix != ".md" and not p.name.startswith("."):
            files.append(p)
    return files + shared_files(tool)


def url_of(tool: OfflineTool, p: Path) -> str:
    """Precache entry: path relative to tools/<tool>/ (= /<tool>/ on the site)."""
    return Path(os.path.relpath(p.resolve(), tool.dir.resolve())).as_posix()


def build(tool: OfflineTool) -> None:
    script = f"scripts/build_{tool.name}.py"
    # The bundle and build-info.js are excluded from the hash, so the order
    # doesn't matter: hash first, then both can carry the version.
    files = shipped_files(tool)
    h = hashlib.sha256()
    for p in files:
        h.update(url_of(tool, p).encode())
        h.update(b"\0")
        h.update(p.read_bytes())
    version = h.hexdigest()[:12]
    info = {"commit": git_commit(), "version": version}

    (tool.dir / BUILD_INFO_NAME).write_text(
        f"// Generated by {script} — do not edit.\n" + build_info_js(tool, info), encoding="utf-8")
    (tool.dir / tool.bundle).write_text(build_bundle(tool, info), encoding="utf-8")

    entries = ["./"] + [url_of(tool, p) for p in files] + UNHASHED
    listing = ",\n".join(f"    {e!r}" for e in entries).replace("'", '"')
    (tool.dir / PRECACHE_NAME).write_text(
        f"// Generated by {script} — do not edit.\n"
        f'self.{tool.prefix}_PRECACHE = {{\n  version: "{version}",\n  files: [\n{listing},\n  ],\n}};\n',
        encoding="utf-8",
    )
    total = sum(p.stat().st_size for p in files)
    print(f"{tool.name}: commit {info['commit']}, version {version}, {len(files)} files, {total / 1024:.0f} KiB precached; wrote {tool.bundle}")
