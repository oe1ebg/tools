"""Generate the GitHub Pages root (index.html, 404.html) from entries.json.

    python3 scripts/build_pages_index.py --manifest entries.json --out DIR

Stdlib only, no network. The page is self-contained (inline CSS, no script,
no fonts, relative links only) and lists every entry of the Pages preview
site (README.md, "GitHub Pages previews"): main, open pull requests,
releases and the rolling data-latest build. All values come from entries.json,
and PR titles are untrusted input: every value is escaped, hrefs are built
only from names that match the patterns below, never taken from the data.

entries.json:
    {"schema": 1, "repo": "oe1ebg/tools", "generated": "<ISO UTC>",
     "entries": [{"kind": "main|pr|release|data", "name": "main|<N>|<tag>|data-latest",
                  "title": "...", "branch": "...", "sha": "<hex>",
                  "updated": "<ISO UTC>", "version": "...", "sha256": "..."}]}
Entry directories: main/, pr/<N>/, release/<tag>/ (data-latest too).
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path

SCHEMA = 1
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
TAG_RE = re.compile(r"^v\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$")
SHA_RE = re.compile(r"^[0-9a-f]{7,64}$")
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
VERSION_RE = re.compile(r"^[0-9A-Za-z._+-]{1,64}$")

# The tool pages every entry has (the tools overview is the entry itself).
TOOL_LINKS = [
    ("confirm/", "Confirmation log"),
    ("notfunk/", "Notfunk log (draft)"),
    ("adif/", "ADIF editor"),
    ("sota-alerts/", "SOTA Alerts Map"),
]

# Order and headings of the groups.
KINDS = [
    ("main", "Latest build of main"),
    ("pr", "Open pull requests"),
    ("release", "Releases"),
    ("data", "Rolling data build (data-latest)"),
]

TITLE_MAX = 200
BRANCH_MAX = 200


def clean(value, limit: int) -> str:
    """A display string: no control characters, bounded length."""
    s = "" if value is None else str(value)
    s = re.sub(r"[\x00-\x1f\x7f-\x9f  ‪-‮⁦-⁩]", " ", s)
    s = " ".join(s.split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


def entry_dir(kind: str, name: str) -> str | None:
    """Relative directory of an entry, or None when kind/name are not valid."""
    if kind == "main" and name == "main":
        return "main/"
    if kind == "pr" and re.fullmatch(r"[1-9][0-9]{0,8}", name):
        return f"pr/{name}/"
    if kind == "release" and TAG_RE.fullmatch(name):
        return f"release/{name}/"
    if kind == "data" and name == "data-latest":
        return "release/data-latest/"
    return None


def valid_entries(manifest: dict) -> list[dict]:
    """The entries that pass validation, in display order (invalid ones are dropped)."""
    out = []
    for e in manifest.get("entries", []):
        if not isinstance(e, dict):
            continue
        kind, name = str(e.get("kind", "")), str(e.get("name", ""))
        d = entry_dir(kind, name)
        if d is None:
            continue
        out.append({**e, "kind": kind, "name": name, "dir": d})

    def key(e):
        k = [k for k, _ in KINDS].index(e["kind"])
        if e["kind"] == "pr":
            return (k, -int(e["name"]))  # newest PR first
        if e["kind"] == "release":
            return (k, tuple(-int(x) for x in re.findall(r"\d+", e["name"])[:3]), e["name"])
        return (k, 0)
    return sorted(out, key=key)


def esc(s) -> str:
    return html.escape(str(s), quote=True)


def render_entry(e: dict, repo: str | None) -> str:
    kind, name, d = e["kind"], e["name"], e["dir"]
    sha = str(e.get("sha", "")).lower()
    sha = sha if SHA_RE.fullmatch(sha) else ""
    updated = str(e.get("updated", ""))
    updated = updated if STAMP_RE.fullmatch(updated) else ""
    version = str(e.get("version", ""))
    version = version if VERSION_RE.fullmatch(version) else ""
    title = clean(e.get("title"), TITLE_MAX)
    branch = clean(e.get("branch"), BRANCH_MAX)

    if kind == "pr":
        if repo:
            heading = f'<a href="https://github.com/{esc(repo)}/pull/{esc(name)}">#{esc(name)}</a>'
        else:
            heading = f"#{esc(name)}"
        head = f'<span class="num">{heading}</span> {esc(title) if title else "(no title)"}'
    elif kind == "main":
        head = "main"
    elif kind == "data":
        head = "data-latest"
    else:
        head = esc(name)
        if repo:
            head = f'<a href="https://github.com/{esc(repo)}/releases/tag/{esc(name)}">{esc(name)}</a>'

    meta = []
    if kind == "pr" and branch:
        meta.append(f"<span>branch <code>{esc(branch)}</code></span>")
    if kind in ("release", "data") and version:
        meta.append(f"<span>version <code>{esc(version)}</code></span>")
    if sha:
        short = esc(sha[:7])
        meta.append(f'<span>commit <a href="https://github.com/{esc(repo)}/commit/{esc(sha)}"><code>{short}</code></a></span>'
                    if repo else f"<span>commit <code>{short}</code></span>")
    if updated:
        meta.append(f'<span>updated <time datetime="{esc(updated)}">{esc(updated.replace("T", " ").rstrip("Z"))} UTC</time></span>')

    label = {"main": "main", "pr": f"pull request {name}", "release": f"release {name}", "data": "data-latest"}[kind]
    links = [f'<a class="open" href="{esc(d)}" aria-label="Open the tools overview of {esc(label)}">Open</a>']
    links += [f'<a href="{esc(d + p)}" aria-label="{esc(t)} of {esc(label)}">{esc(t)}</a>' for p, t in TOOL_LINKS]
    return (
        '<li class="entry">\n'
        f'<div class="head">{head}</div>\n'
        f'<div class="meta">{" ".join(meta)}</div>\n'
        f'<div class="links">{" ".join(links)}</div>\n'
        "</li>"
    )


CSS = """\
:root { color-scheme: light dark; --bg:#fff; --raised:#f5f5f7; --line:#d0d0d8; --text:#1b1b1f; --dim:#555a66;
  --accent:#3f55d9; --warn-bg:#fff4d6; --warn-line:#9a6700; --warn-text:#3d2b00; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d0e12; --raised:#171922; --line:#3a3e4c; --text:#e4e5ea;
  --dim:#a3a7b5; --accent:#8fa0ff; --warn-bg:#2d2406; --warn-line:#d4a017; --warn-text:#ffe9a8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 56rem; margin: 0 auto; padding: 1rem 1rem 4rem; }
h1 { font-size: 1.6rem; margin: 1rem 0 .25rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; }
a { color: var(--accent); }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.lead { color: var(--dim); margin: 0 0 1rem; }
.warn { background: var(--warn-bg); color: var(--warn-text); border: 2px solid var(--warn-line); border-radius: 8px; padding: .75rem 1rem; margin: 1rem 0; }
.warn p { margin: .3rem 0; }
ul.entries { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; }
.entry { background: var(--raised); border: 1px solid var(--line); border-radius: 8px; padding: .6rem .85rem; }
.head { font-weight: 600; overflow-wrap: anywhere; }
.num { margin-right: .35rem; }
.meta { color: var(--dim); font-size: .9rem; display: flex; flex-wrap: wrap; gap: .1rem 1rem; overflow-wrap: anywhere; }
.links { display: flex; flex-wrap: wrap; gap: .25rem .9rem; margin-top: .35rem; }
.links a.open { font-weight: 600; }
.empty { color: var(--dim); font-style: italic; }
footer { margin-top: 3rem; padding-top: .75rem; border-top: 1px solid var(--line); color: var(--dim); font-size: .85rem; }
a:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
"""

WARNING = (
    '<div class="warn" role="note">\n'
    "<p><strong>Do not use real data here.</strong> Every entry on this site is served from the "
    "<em>same browser origin</em>. The tools store their logbooks, drafts and settings per origin "
    "(IndexedDB, localStorage), so <strong>all entries share one local logbook</strong>, and every entry "
    "(including a pull request preview of code nobody has reviewed yet) can read and change it. "
    "Their service workers also share the origin&rsquo;s cache storage.</p>\n"
    "<p>Use a separate browser profile for trying previews, test data only. Real logbooks belong on a "
    "dedicated origin such as <a href=\"https://oe1ebg.at/tools/\">oe1ebg.at/tools/</a>.</p>\n"
    "<p>These are static previews without the security headers of the nginx example "
    "(Content-Security-Policy, framing protection); they do not replace the CI checks.</p>\n"
    "</div>"
)


def render_index(manifest: dict) -> str:
    repo = manifest.get("repo")
    repo = repo if isinstance(repo, str) and REPO_RE.fullmatch(repo) else None
    entries = valid_entries(manifest)
    generated = str(manifest.get("generated", ""))
    generated = generated if STAMP_RE.fullmatch(generated) else ""

    sections = []
    for kind, heading in KINDS:
        items = [e for e in entries if e["kind"] == kind]
        hid = f"k-{kind}"
        if items:
            body = '<ul class="entries">\n' + "\n".join(render_entry(e, repo) for e in items) + "\n</ul>"
        else:
            body = '<p class="empty">Nothing here at the moment.</p>'
        sections.append(f'<section aria-labelledby="{hid}">\n<h2 id="{hid}">{esc(heading)}</h2>\n{body}\n</section>')

    src = f'<a href="https://github.com/{esc(repo)}">github.com/{esc(repo)}</a>' if repo else "the repository"
    when = f" at {esc(generated.replace('T', ' ').rstrip('Z'))} UTC" if generated else ""
    foot = f"Generated by <code>scripts/build_pages_index.py</code>{when}. Source: {src}."
    note = (
        '<p class="lead">Builds of the oe1ebg tools: <code>main</code>, open pull requests and releases. '
        "A branch without an open pull request has no preview.</p>"
    )
    return (
        "<!doctype html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<meta name="robots" content="noindex, nofollow">\n'
        "<title>oe1ebg tools: previews and builds</title>\n"
        f"<style>\n{CSS}</style>\n</head>\n<body>\n<main>\n"
        "<h1>oe1ebg tools: previews and builds</h1>\n"
        f"{note}\n{WARNING}\n" + "\n".join(sections) + f"\n<footer>{foot}</footer>\n</main>\n</body>\n</html>\n"
    )


def render_404() -> str:
    return (
        "<!doctype html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<meta name="robots" content="noindex, nofollow">\n'
        "<title>Not found</title>\n"
        f"<style>\n{CSS}</style>\n</head>\n<body>\n<main>\n"
        "<h1>Not found</h1>\n"
        "<p>This preview does not exist (any more). Previews of pull requests are removed when the "
        "pull request is closed.</p>\n"
        # served from any path, so it cannot link relatively
        "<p>Go back to the site root for the list of builds.</p>\n"
        "</main>\n</body>\n</html>\n"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path, help="directory that receives index.html and 404.html")
    args = ap.parse_args(argv)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        print(f"{args.manifest}: unsupported schema", file=sys.stderr)
        return 1
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "index.html").write_text(render_index(manifest), encoding="utf-8")
    (args.out / "404.html").write_text(render_404(), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
