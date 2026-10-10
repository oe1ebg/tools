from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import markdown
from markdown.extensions import Extension
from markdown.treeprocessors import Treeprocessor

# Assembles the deployable bundle in site/tools/ (git-ignored): a copy of
# tools/<tool>/ without Markdown and dotfiles, the manuals from docs/
# rendered to <name>/index.html, their screenshots (img/), an overview page
# (index.html), manifest.json (version, commit, build time) and the
# manuals' Markdown sources in docs/, for sites that render them in their
# own theme (they link MkDocs-style, as if docs/*.md sat next to img/ and
# the tool directories, e.g. content/tools/*.md on oe1ebg.at).
#
# Runs after the data and bundle steps (they write into tools/). Every link
# inside the bundle is relative and stays inside it, so site/tools/ works
# from any directory on any static webserver, including offline ones; the
# tools reach the manuals as ../confirm-anleitung/ and ../data-sources/.
#
# `just e2e` and `just vnu` serve site/ (so the tools are at /tools/<tool>/,
# as on oe1ebg.at), `just dist` packs site/tools/.
#
# A site that embeds the bundle (oe1ebg.at) may render docs/*.md itself and
# replace index.html and the rendered manuals; the tools don't depend on
# anything but the URLs ../<manual>/ and ../.

ROOT_DIR = Path(__file__).resolve().parent.parent
TOOLS_DIR = ROOT_DIR / "tools"
DOCS_DIR = ROOT_DIR / "docs"
OUT_DIR = ROOT_DIR / "site" / "tools"

# Source repository (REPO_URL in tools/shared/js/sources.js).
REPO_URL = "https://github.com/oe1ebg/tools"

IGNORE = shutil.ignore_patterns("*.md", ".*", "__pycache__")

# docs/<name>.md -> <name>/index.html, in this order on the overview page.
MANUALS = {
    "confirm-anleitung": "Bestätigungsverkehr: Anleitung",
    "notfunk-anleitung": "Notfunk-Meldebuch: Anleitung",
    "data-sources": "Datenquellen",
}

# Tools on the overview page: directory -> (title, description).
TOOLS = {
    "confirm": ("Bestätigungsverkehr", "Offline-Logbuch für Bestätigungs- und Check-in-Runden."),
    "notfunk": ("Notfunk-Meldebuch", "Offline-Meldebuch für den Notfunk (Entwurf)."),
    "adif": ("ADIF-Editor", "ADIF-Logs (.adi) ansehen, prüfen und bearbeiten."),
    "sota-alerts": ("SOTA Alerts Map", "SOTA-Alerts auf der Karte (braucht Internet)."),
}

PAGE = """<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<script src="{up}shared/js/theme.js"></script>
<link rel="stylesheet" href="{up}shared/css/tools.css">
<link rel="stylesheet" href="{up}shared/css/docs.css">
</head>
<body>
<main class="doc">
{nav}
{body}
{footer}
</main>
</body>
</html>
"""


class RelinkProcessor(Treeprocessor):
    """Rewrites the docs' MkDocs-style links for a page at <name>/index.html:
    x.md -> ../x/, index.md -> ../, other relative URLs -> ../url."""

    def run(self, root):
        for el in root.iter():
            for attr in ("href", "src"):
                url = el.get(attr)
                if url and not re.match(r"^([a-z][a-z0-9+.-]*:|#|/)", url, re.I):
                    el.set(attr, relink(url))


def relink(url: str) -> str:
    path, _, frag = url.partition("#")
    frag = f"#{frag}" if frag else ""
    if path == "index.md":
        return f"../{frag}"
    if path.endswith(".md"):
        return f"../{path[:-3]}/{frag}"
    return f"../{path}{frag}"


class Relink(Extension):
    def extendMarkdown(self, md):
        md.treeprocessors.register(RelinkProcessor(md), "relink", 0)


def render(md_text: str) -> str:
    return markdown.markdown(
        md_text,
        extensions=["attr_list", "admonition", "tables", "toc", "md_in_html", "fenced_code", Relink()],
        output_format="html",
    )


def footer(version: str, sha: str) -> str:
    """Footer of the overview and the manuals: the source repository and
    this build's version and commit (linked when it is a real SHA, like
    commitUrl() in tools/shared/js/sources.js)."""
    commit = html.escape(sha)
    if re.fullmatch(r"[0-9a-f]{7,40}", sha):
        commit = f'<a href="{REPO_URL}/commit/{sha}">{sha[:7]}</a>'
    return (f'<footer class="doc-footer">Quellcode: <a href="{REPO_URL}">github.com/oe1ebg/tools</a>'
            f" · Version {html.escape(version)} (commit {commit})</footer>")


def page(title: str, body: str, up: str, home: bool, foot: str = "") -> str:
    nav = '<p class="doc-nav"><a href="../">← Alle Tools</a></p>' if home else ""
    return PAGE.format(title=html.escape(title), up=up, nav=nav, body=body, footer=foot)


def git_sha() -> str:
    if os.environ.get("GIT_SHA"):
        return os.environ["GIT_SHA"]
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT_DIR,
                              capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "dev"


DEV_STUB_RE = re.compile(r"\bdev\s*:\s*true\b")


def dev_stubs(tools_dir: Path = TOOLS_DIR) -> list[Path]:
    """precache.js files that are the development stub (`just dev-precache`),
    not a build's manifest: they must never be staged or released (the tool
    would never work offline)."""
    return [p for p in sorted(tools_dir.glob("*/precache.js")) if DEV_STUB_RE.search(p.read_text(encoding="utf-8"))]


def main() -> None:
    stubs = dev_stubs()
    if stubs:
        names = ", ".join(str(p.relative_to(ROOT_DIR)) for p in stubs)
        raise SystemExit(f"error: development stub {names} (just dev-precache); run `just build` first, it writes the real precache.js")
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)
    version = os.environ.get("TOOLS_VERSION", "dev")
    sha = git_sha()
    foot = footer(version, sha)

    for src in sorted(p for p in TOOLS_DIR.iterdir() if p.is_dir() and not p.name.startswith(".")):
        if src.name != "shared" and not (src / "index.html").exists():
            print(f"skipped tools/{src.name}/ (no index.html yet)")
            continue
        shutil.copytree(src, OUT_DIR / src.name, ignore=IGNORE)
        print(f"staged tools/{src.name}/")

    for name, title in MANUALS.items():
        body = render((DOCS_DIR / f"{name}.md").read_text(encoding="utf-8"))
        (OUT_DIR / name).mkdir()
        (OUT_DIR / name / "index.html").write_text(page(title, body, "../", True, foot), encoding="utf-8")
        print(f"rendered docs/{name}.md -> {name}/index.html")
    if (DOCS_DIR / "img").is_dir():
        shutil.copytree(DOCS_DIR / "img", OUT_DIR / "img")
    (OUT_DIR / "docs").mkdir()
    for name in MANUALS:
        shutil.copyfile(DOCS_DIR / f"{name}.md", OUT_DIR / "docs" / f"{name}.md")

    items = "\n".join(
        f'<li><a href="{d}/">{html.escape(t)}</a> — {html.escape(desc)}</li>'
        for d, (t, desc) in TOOLS.items() if (OUT_DIR / d).is_dir())
    docs = "\n".join(f'<li><a href="{n}/">{html.escape(t)}</a></li>' for n, t in MANUALS.items())
    body = f"<h1>Tools</h1>\n<ul>\n{items}\n</ul>\n<h2>Anleitungen</h2>\n<ul>\n{docs}\n</ul>"
    (OUT_DIR / "index.html").write_text(page("Tools", body, "", False, foot), encoding="utf-8")

    manifest = {
        "name": "oe1ebg-tools",
        "version": version,
        "commit": sha,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    n = sum(1 for p in OUT_DIR.rglob("*") if p.is_file())
    print(f"site/tools/: {n} files, version {manifest['version']} ({manifest['commit']})")


if __name__ == "__main__":
    main()
