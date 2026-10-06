from __future__ import annotations

import re
from pathlib import Path

from single_file import bundle_modules, inline_vendor, script_safe

# Build step for the ADIF editor (oe1ebg/tools/adif/). Writes the git-ignored
# adif-editor.html: the whole editor in ONE file (js/ modules and the
# tools/shared/ modules they import, inlined by scripts/single_file.py), so
# it can be saved and opened via file://, where module scripts don't load.
# The published /adif/ page itself loads the ES modules. Runs before
# scripts/stage_tools.py. Stdlib only.

ADIF_DIR = Path(__file__).resolve().parent.parent / "tools" / "adif"
BUNDLE_NAME = "adif-editor.html"
SCRIPT_BLOCK_RE = re.compile(r"<!-- ADIF-SCRIPT-BEGIN -->.*?<!-- ADIF-SCRIPT-END -->", re.S)
# theme script and stylesheets (tools/shared/ + the tool's style.css), inlined
VENDOR_BLOCK_RE = re.compile(r"<!-- ADIF-VENDOR-BEGIN -->(.*?)<!-- ADIF-VENDOR-END -->", re.S)


def build_bundle() -> str:
    html = (ADIF_DIR / "index.html").read_text(encoding="utf-8")
    js = script_safe(bundle_modules(ADIF_DIR / "js" / "app.js"))
    html, n = SCRIPT_BLOCK_RE.subn(lambda _m: f"<script>\n{js}</script>", html)
    if n != 1:
        raise SystemExit("index.html: ADIF-SCRIPT markers not found")
    html, n = VENDOR_BLOCK_RE.subn(lambda m: inline_vendor(m.group(1), ADIF_DIR), html)
    if n != 1:
        raise SystemExit("index.html: ADIF-VENDOR markers not found")
    return html


def main() -> None:
    html = build_bundle()
    (ADIF_DIR / BUNDLE_NAME).write_text(html, encoding="utf-8")
    print(f"adif: wrote {BUNDLE_NAME} ({len(html.encode()) / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
