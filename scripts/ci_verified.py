"""Has CI already checked this exact content? (.github/workflows/ci.yml)

    python3 scripts/ci_verified.py name   --tree TREE --adif BOOL --site BOOL
    python3 scripts/ci_verified.py lookup --tree TREE --adif BOOL --site BOOL --repo owner/name

A rebase merge gives every commit a new id, but a clean one keeps its
content: the git *tree* of the merged commit is the tree the pull request's
run tested. So is a restacked pull request whose content did not change.
A run that passed with all five browser projects leaves a marker artifact,
`name` prints its name: ci-verified-<tree>-a<0|1>s<0|1>, the tree and the
scope that run checked (a: ADIF checks, s: bundle, HTML check and browser
tests; see the `changes` job). `lookup` looks for a marker of this tree whose
scope covers the one this run needs, writes verified=true|false and run-url
to GITHUB_OUTPUT (stdout without it), and accepts a marker only when:

- it has not expired, and its run is of this repository's head (no fork:
  a fork's pull request runs its own copy of ci.yml),
- that run is .github/workflows/ci.yml and concluded `success`.

Stdlib only; `gh` does the network (GH_TOKEN). Any API failure means "not
verified": the full run is always the fallback.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

WORKFLOW_PATH = ".github/workflows/ci.yml"


def flag(value: str | bool) -> bool:
    return value is True or str(value).lower() == "true"


def marker_name(tree: str, adif: bool, site: bool) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", tree):
        raise ValueError(f"not a tree id: {tree!r}")
    return f"ci-verified-{tree}-a{int(adif)}s{int(site)}"


def covering_names(tree: str, adif: bool, site: bool) -> list[str]:
    """Marker names whose scope includes this one, the exact scope first."""
    return [marker_name(tree, a, s)
            for a in ([adif] if adif else [False, True])
            for s in ([site] if site else [False, True])]


def accept(artifact: dict, run: dict | None, repo_id: int) -> bool:
    """A marker artifact and its workflow run (GitHub REST shapes)."""
    wr = artifact.get("workflow_run") or {}
    if artifact.get("expired") or wr.get("repository_id") != repo_id or wr.get("head_repository_id") != repo_id:
        return False
    if not run or run.get("id") != wr.get("id"):
        return False
    return run.get("path") == WORKFLOW_PATH and run.get("conclusion") == "success" \
        and (run.get("head_repository") or {}).get("id") == repo_id


def find(names: list[str], artifacts_of, run_of, repo_id: int) -> dict | None:
    """The first accepted marker's run, or None. artifacts_of(name) -> list,
    run_of(id) -> dict | None (injected: the tests have no network)."""
    for name in names:
        for artifact in artifacts_of(name):
            if artifact.get("name") != name:
                continue
            run = run_of((artifact.get("workflow_run") or {}).get("id"))
            if accept(artifact, run, repo_id):
                return run
    return None


def gh_json(*args: str):
    r = subprocess.run(["gh", "api", *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"gh api {' '.join(args)} failed")
    return json.loads(r.stdout)


def lookup(repo: str, names: list[str]) -> dict | None:
    repo_id = gh_json(f"repos/{repo}")["id"]
    artifacts_of = lambda name: gh_json(f"repos/{repo}/actions/artifacts?name={name}&per_page=20").get("artifacts", [])
    run_of = lambda run_id: gh_json(f"repos/{repo}/actions/runs/{int(run_id)}") if run_id else None
    return find(names, artifacts_of, run_of, repo_id)


def output(**values: str) -> None:
    lines = "".join(f"{k}={v}\n" for k, v in values.items())
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(lines)
    else:
        sys.stdout.write(lines)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("command", choices=["name", "lookup"])
    p.add_argument("--tree", required=True)
    p.add_argument("--adif", required=True)
    p.add_argument("--site", required=True)
    p.add_argument("--repo")
    a = p.parse_args(argv)
    adif, site = flag(a.adif), flag(a.site)
    if a.command == "name":
        print(marker_name(a.tree, adif, site))
        return 0
    if not a.repo:
        p.error("lookup needs --repo")
    try:
        run = lookup(a.repo, covering_names(a.tree, adif, site))
    except Exception as e:  # noqa: BLE001 - any failure: run everything
        print(f"::warning::verified-tree lookup failed, running all checks: {e}")
        run = None
    output(verified="true" if run else "false", **{"run-url": run.get("html_url", "") if run else ""})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
