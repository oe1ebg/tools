"""The sticky preview comment of a pull request (one comment, updated in place).

    python3 scripts/pages_comment.py --slug owner/name --pr N --state STATE [--sha SHA] [--base URL] [--detail-file F]

STATE: published | removed | build-failed | full | error. The body is made from
the PR number, the commit sha and, for `full`, the detail line of
pages_publish.py (entry names and sizes only); never from PR-controlled text.
`gh` posts it (GH_TOKEN). A failure to comment is a warning, not an error.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

MARKER = "<!-- oe1ebg-pages-preview -->"


def body(state: str, pr: str, sha: str = "", base: str = "", detail: str = "") -> str:
    sha = sha if re.fullmatch(r"[0-9a-f]{7,64}", sha or "") else ""
    short = sha[:7]
    url = f"{base.rstrip('/')}/pr/{pr}/" if base else ""
    warn = "Shared browser origin with all other previews: use test data and a throwaway browser profile only."
    if state == "published":
        return f"{MARKER}\nPreview of {short}: {url}\n\n{warn}"
    if state == "removed":
        return f"{MARKER}\nPreview removed (pull request closed)."
    if state == "build-failed":
        return (f"{MARKER}\nThe build of {short} failed, so the preview was not updated: {url}\n\n"
                "If that link works at all it shows an EARLIER commit (the index of the site names the commit of each entry). "
                "See the failed run for the reason.")
    if state == "full":
        return (f"{MARKER}\nNo preview of {short}: the Pages site is full.\n\n{detail.strip()}\n\n"
                "Entries are removed when their pull request is closed; the maintainers can also lower the number of releases kept.")
    return f"{MARKER}\nThe preview of {short} could not be published (see the workflow run). {url} may show an earlier commit."


def gh(*args: str) -> str:
    r = subprocess.run(["gh", *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode:
        raise RuntimeError(re.sub(r"[\x00-\x1f]+", " ", r.stderr.strip()))
    return r.stdout


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--slug", required=True)
    ap.add_argument("--pr", required=True)
    ap.add_argument("--state", required=True, choices=["published", "removed", "build-failed", "full", "error"])
    ap.add_argument("--sha", default="")
    ap.add_argument("--base", default="")
    ap.add_argument("--detail-file", type=Path)
    a = ap.parse_args(argv)
    if not re.fullmatch(r"[1-9][0-9]{0,8}", a.pr):
        raise SystemExit("bad --pr")
    detail = a.detail_file.read_text(encoding="utf-8")[:1500] if a.detail_file and a.detail_file.is_file() else ""
    text = body(a.state, a.pr, a.sha, a.base, detail)
    try:
        found = gh("api", f"repos/{a.slug}/issues/{a.pr}/comments", "--paginate", "--jq",
                   f'[.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("{MARKER}")))][0].id // empty').split()
        if found:
            gh("api", "-X", "PATCH", f"repos/{a.slug}/issues/comments/{found[0]}", "-f", f"body={text}")
        elif a.state != "removed":
            gh("api", "-X", "POST", f"repos/{a.slug}/issues/{a.pr}/comments", "-f", f"body={text}")
    except RuntimeError as e:
        print(f"::warning::could not update the preview comment: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
