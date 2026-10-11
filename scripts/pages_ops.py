"""Turn a workflow event into the operations for scripts/pages_publish.py.

    python3 scripts/pages_ops.py --out ops.json --open-prs open-prs.json [--pr-state OPEN|CLOSED|MERGED]
                                 [--entry-dir entry] [--releases-ops releases/ops.json]

The deploy job of .github/workflows/pages.yml runs this from the default
branch's checkout. The event is read from the environment (EVENT_NAME,
EVENT_ACTION, PR_NUMBER, PR_TITLE, PR_BRANCH, PR_SHA, GITHUB_SHA,
GITHUB_REF_NAME (the runner's own), DEFAULT_BRANCH, AS_OF = when the PR list was
taken: the clean-up must not remove what landed after it); PR titles and branch names are untrusted
and only ever pass through here as JSON values.

  pull_request closed       remove pr/<N>
  pull_request otherwise    put pr/<N> from --entry-dir (unless the PR is no longer open)
  push to the default branch / dispatch on it   put main from --entry-dir
  release, workflow_run, dispatch, schedule     the releases' ops (--releases-ops), if any
  always                    keep-prs: drop previews of PRs that are not open any more,
                            refresh the titles and branches of the others
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path


def plan(env: dict, open_prs: list[dict], pr_state: str = "", releases_ops: list[dict] | None = None,
         has_entry: bool = False) -> list[dict]:
    event, action = env.get("EVENT_NAME", ""), env.get("EVENT_ACTION", "")
    ops: list[dict] = []
    if event == "pull_request":
        n = env.get("PR_NUMBER", "")
        if not re.fullmatch(r"[1-9][0-9]{0,8}", n):
            raise SystemExit(f"bad PR number {n!r}")
        if action == "closed":
            ops.append({"op": "remove", "kind": "pr", "name": n})
        elif pr_state == "OPEN" and has_entry:
            ops.append({"op": "put", "kind": "pr", "name": n, "dir": "entry",
                        "meta": {"title": env.get("PR_TITLE", ""), "branch": env.get("PR_BRANCH", ""), "sha": env.get("PR_SHA", "")}})
        # not open any more (closed while the build ran): keep-prs below removes the entry
    elif event == "push" or (event == "workflow_dispatch" and env.get("GITHUB_REF_NAME") == env.get("DEFAULT_BRANCH")):
        if has_entry:
            ops.append({"op": "put", "kind": "main", "name": "main", "dir": "entry",
                        "meta": {"title": "main", "branch": env.get("GITHUB_REF_NAME", "main"), "sha": env.get("GITHUB_SHA", "")}})
    if event != "pull_request" and releases_ops:
        ops += releases_ops
    ops.append({"op": "keep-prs", "as_of": env.get("AS_OF", ""), "open": [
        {"number": p.get("number"), "title": p.get("title", ""), "branch": p.get("headRefName", "")}
        for p in open_prs if not p.get("isCrossRepository")]})
    return ops


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--open-prs", required=True, type=Path, help="`gh pr list --state open --json number,title,headRefName,isCrossRepository`")
    ap.add_argument("--pr-state", default="")
    ap.add_argument("--entry-dir", type=Path)
    ap.add_argument("--releases-ops", type=Path)
    a = ap.parse_args(argv)
    open_prs = json.loads(a.open_prs.read_text(encoding="utf-8"))
    rel = json.loads(a.releases_ops.read_text(encoding="utf-8")) if a.releases_ops and a.releases_ops.is_file() else None
    ops = plan(dict(os.environ), open_prs, a.pr_state, rel, bool(a.entry_dir and a.entry_dir.is_dir()))
    a.out.write_text(json.dumps(ops, indent=2) + "\n", encoding="utf-8")
    print(json.dumps([{k: v for k, v in o.items() if k not in ("meta", "open")} for o in ops]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
