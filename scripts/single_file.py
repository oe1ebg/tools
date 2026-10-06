from __future__ import annotations

import html
import re
from pathlib import Path

# Single-file bundling for the standalone tools (build_confirm.py,
# build_adif.py). Stdlib only, no real bundler: a tool's ES modules are
# concatenated in dependency order with their import lines and `export`
# keywords stripped and wrapped in one IIFE, so the result also runs from
# file://, where module scripts don't load. Constraints this puts on the
# modules (checked here, the build fails otherwise):
#
# - only single-statement `import { a, b } from './x.js';` (or '../…')
#   imports, and only `export function|const|let|class` exports;
# - top-level names unique across all modules of one tool (one shared
#   scope), including the tools/shared/ modules it imports.

TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"

IMPORT_RE = re.compile(r"^import\s*\{[^}]*\}\s*from\s*['\"](\.\.?/[^'\"]+)['\"];?[ \t]*\n", re.M)
EXPORT_RE = re.compile(r"^export\s+(?=(async\s+)?(function|const|let|class)\b)", re.M)
TOP_DECL_RE = re.compile(r"^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)", re.M)
VENDOR_REF_RE = re.compile(r'<link rel="stylesheet" href="([^"]+)">|<script src="([^"]+)"></script>')


def script_safe(text: str) -> str:
    """Text that can't close the inline <script> element it's put in."""
    return text.replace("</script", "<\\/script")


def module_order(entry: Path) -> list[Path]:
    """entry and every module it imports (transitively), dependencies first."""
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


def bundle_modules(entry: Path) -> str:
    parts = []
    declared: dict[str, str] = {}
    for path in module_order(entry):
        label = path.relative_to(TOOLS_DIR).as_posix()
        src = path.read_text(encoding="utf-8")
        for name in TOP_DECL_RE.findall(src):
            if name in declared:
                raise SystemExit(f"top-level name {name!r} declared in both {declared[name]} and {label} "
                                 "— the single-file bundle shares one scope; rename one")
            declared[name] = label
        src = IMPORT_RE.sub("", src)
        src = EXPORT_RE.sub("", src)
        if re.search(r"^\s*(import|export)\b", src, re.M):
            raise SystemExit(f"{label}: unsupported import/export form for the single-file bundle")
        parts.append(f"// ---- {label} ----\n{src}")
    return "(() => {\n'use strict';\n" + "\n".join(parts) + "\n})();\n"


def vendor_refs(block: str) -> list[str]:
    """The href/src values of the <link>/<script> tags in an HTML block."""
    return [css or js for css, js in VENDOR_REF_RE.findall(block)]


def inline_vendor(block: str, base: Path) -> str:
    """Third-party files (e.g. Leaflet) as inline <style>/<script>; refs relative to base."""
    def sub(m: re.Match) -> str:
        css, js = m.group(1), m.group(2)
        text = (base / (css or js)).read_text(encoding="utf-8")
        if css:
            return f"<style>\n{text.replace('</style', '<\\/style')}\n</style>"
        return f"<script>\n{script_safe(text)}\n</script>"
    return VENDOR_REF_RE.sub(sub, block)


def vendor_licenses(block: str, base: Path) -> str:
    """The LICENSE files next to the third-party files in an HTML block, as
    <details> elements: the bundle redistributes that code, so its licence
    text has to travel with the file (the online link doesn't work offline)."""
    files = list(dict.fromkeys((base / ref).resolve().parent / "LICENSE" for ref in vendor_refs(block)))
    return "".join(
        f'<details class="vendor-license"><summary>Lizenztext {html.escape(p.parent.name)}</summary>'
        f"<pre>{html.escape(p.read_text(encoding='utf-8'))}</pre></details>\n"
        for p in files if p.exists())
