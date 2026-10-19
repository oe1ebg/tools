"""The images the manuals use (docs/*.md: ![..](img/NAME.png)) against a
directory of images, by default the staged bundle's site/tools/img/.

    python3 scripts/check_manual_images.py [DIR]

Exits 1 and lists what is missing. `just dist` runs it: a release without
its screenshots is not published (the screenshots are generated during the
build, tests/e2e/manual.shots.mjs, and not committed). build_site.py prints
the same list as a warning.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DOCS_DIR = ROOT_DIR / "docs"
IMG_RE = re.compile(r"\]\(img/([A-Za-z0-9._-]+)\)")


def referenced(docs_dir: Path = DOCS_DIR) -> dict[str, list[str]]:
    """image name -> manuals that use it"""
    out: dict[str, list[str]] = {}
    for md in sorted(docs_dir.glob("*.md")):
        for name in IMG_RE.findall(md.read_text(encoding="utf-8")):
            out.setdefault(name, []).append(md.name)
    return out


def missing(img_dir: Path, docs_dir: Path = DOCS_DIR) -> list[str]:
    return sorted(name for name in referenced(docs_dir) if not (img_dir / name).is_file())


def main(argv: list[str]) -> int:
    img_dir = Path(argv[1]) if len(argv) > 1 else ROOT_DIR / "site" / "tools" / "img"
    gone = missing(img_dir)
    if gone:
        print(f"error: {len(gone)} manual screenshot(s) missing in {img_dir}: {', '.join(gone)}", file=sys.stderr)
        print("they are generated during `just build` (MANUAL_IMAGES=require just build, or `just screenshots`)", file=sys.stderr)
        return 1
    print(f"manual screenshots: all {len(referenced())} present in {img_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
