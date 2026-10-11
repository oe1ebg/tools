"""Apply changes to the `gh-pages` branch of the GitHub Pages preview site.

    python3 scripts/pages_publish.py --repo DIR --ops ops.json [--incoming DIR] [--slug owner/name] [--branch gh-pages]
                                     [--remote origin] [--retries 6] [--message TEXT] [--no-push]

Run by .github/workflows/pages.yml (job `deploy`, from the default branch's
checkout) and by tests/pages-publish.test.mjs against a throwaway bare
repository. Stdlib and git only, no network besides the git remote.

The tree of the branch is the site (README.md, "GitHub Pages previews"):
    index.html 404.html robots.txt .nojekyll entries.json
    main/  pr/<N>/  release/<tag>/  release/data-latest/
Everything else in the branch (a CNAME file Pages wrote, say) is kept as it is.

--ops files are JSON lists (concatenated in order), `dir` is relative to --incoming:
    [
       {"op": "put", "kind": "pr", "name": "12", "dir": "<built site/tools>",
        "meta": {"title": "...", "branch": "...", "sha": "<hex>", "updated": "<ISO>"}},
       {"op": "remove", "kind": "pr", "name": "12"},
       {"op": "keep-prs", "open": [{"number": 12, "title": "...", "branch": "..."}]},
       {"op": "keep-releases", "tags": ["v1.0.0", "data-latest"]}]

Everything under "dir" and every value in "meta" is data, never trusted: the
directory must be a plain tree (no symlinks or special files, bounded size,
has index.html), kind and name must match the patterns of
build_pages_index.entry_dir, and strings are sanitised before they reach
entries.json (and the index page escapes them again).

History: the branch is always ONE orphan commit. The new commit is pushed
with `--force-with-lease=<branch>:<sha we based it on>`: if anything else
pushed in the meantime the push is refused, and the whole change is applied
again on the fresh state (the operations are idempotent), up to --retries
times. So concurrent runs serialize through git's compare-and-swap instead of
a lock. A change that leaves the tree identical pushes nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pages_index as idx  # noqa: E402

SCHEMA = idx.SCHEMA
MANAGED_FILES = ("index.html", "404.html", "robots.txt", ".nojekyll", "entries.json")
MAX_ENTRY_BYTES = int(os.environ.get("PAGES_MAX_ENTRY_MB", "300")) * 1024 * 1024
MAX_TOTAL_BYTES = int(os.environ.get("PAGES_MAX_TOTAL_MB", "900")) * 1024 * 1024  # Pages: 1 GB published site
MAX_ENTRY_FILES = 20000
ROBOTS = "User-agent: *\nDisallow: /\n"


class PagesError(Exception):
    pass


def now_iso() -> str:
    return os.environ.get("PAGES_NOW") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- validation of the untrusted input

def check_tree(src: Path) -> tuple[int, int]:
    """Refuse anything but plain files and directories; (files, bytes)."""
    if src.is_symlink() or not src.is_dir():
        raise PagesError(f"{src}: not a directory")
    if not (src / "index.html").is_file():
        raise PagesError(f"{src}: no index.html")
    files = size = 0
    stack = [src]
    while stack:
        d = stack.pop()
        with os.scandir(d) as it:
            for e in it:
                st = e.stat(follow_symlinks=False)
                if e.name in (".git", ".", "..") or "\x00" in e.name:
                    raise PagesError(f"{e.path}: forbidden name")
                if stat.S_ISDIR(st.st_mode):
                    stack.append(Path(e.path))
                elif stat.S_ISREG(st.st_mode):
                    files += 1
                    size += st.st_size
                else:
                    raise PagesError(f"{e.path}: not a regular file or directory (symlink or special file)")
                if files > MAX_ENTRY_FILES or size > MAX_ENTRY_BYTES:
                    raise PagesError(f"{src}: too large (limits: {MAX_ENTRY_FILES} files, {MAX_ENTRY_BYTES // 2**20} MB)")
    return files, size


def tree_bytes(root: Path) -> int:
    total = 0
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d != ".git"]
        for f in fn:
            try:
                total += os.lstat(os.path.join(dp, f)).st_size
            except OSError:
                pass
    return total


def sanitize_meta(kind: str, meta: dict, built: dict) -> dict:
    """The fields of an entry, from untrusted `meta` and the build's own manifest.json."""
    out = {}
    out["title"] = idx.clean(meta.get("title"), idx.TITLE_MAX)
    out["branch"] = idx.clean(meta.get("branch"), idx.BRANCH_MAX)
    sha = str(meta.get("sha") or built.get("commit") or "").lower()
    out["sha"] = sha if idx.SHA_RE.fullmatch(sha) else ""
    updated = str(meta.get("updated") or built.get("built") or now_iso())
    out["updated"] = updated if idx.STAMP_RE.fullmatch(updated) else now_iso()
    version = str(meta.get("version") or built.get("version") or "")
    out["version"] = version if idx.VERSION_RE.fullmatch(version) else ""
    sha256 = str(meta.get("sha256") or "").lower()
    out["sha256"] = sha256 if re.fullmatch(r"[0-9a-f]{64}", sha256) else ""
    return {k: v for k, v in out.items() if v != ""}


# --- the tree

def load_manifest(root: Path) -> dict | None:
    p = root / "entries.json"
    if not p.is_file():
        return None
    try:
        m = json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return None
    return m if isinstance(m, dict) and m.get("schema") == SCHEMA else None


def resolve_incoming(incoming: Path | None, rel) -> Path:
    """`dir` of a put op: a relative path inside the incoming directory, nothing else."""
    if incoming is None:
        raise PagesError("put needs --incoming")
    base = incoming.resolve()
    p = (base / str(rel))
    if os.path.isabs(str(rel)) or ".." in Path(str(rel)).parts:
        raise PagesError(f"{rel!r}: must be a relative path inside the incoming directory")
    if p.is_symlink() or base not in p.resolve().parents:
        raise PagesError(f"{rel!r}: outside the incoming directory")
    return p


def apply_ops(root: Path, ops: list[dict], repo: str | None, incoming: Path | None = None) -> dict:
    """Apply ops to the site tree in `root` and rewrite the generated files."""
    old = load_manifest(root)
    entries: dict[tuple[str, str], dict] = {}
    for e in (old or {}).get("entries", []):
        if isinstance(e, dict) and idx.entry_dir(str(e.get("kind")), str(e.get("name"))):
            entries[(e["kind"], e["name"])] = e

    def dest_of(kind, name) -> Path:
        d = idx.entry_dir(str(kind), str(name))
        if d is None:
            raise PagesError(f"invalid entry {kind!r}/{name!r}")
        return root / d

    def drop(kind, name):
        shutil.rmtree(dest_of(kind, name), ignore_errors=True)
        entries.pop((kind, name), None)

    for op in ops:
        kind, name = str(op.get("kind", "")), str(op.get("name", ""))
        which = op.get("op")
        if which == "put":
            dest = dest_of(kind, name)
            src = resolve_incoming(incoming, op.get("dir"))
            check_tree(src)
            built = {}
            try:
                built = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
                if not isinstance(built, dict):
                    built = {}
            except (OSError, ValueError):
                pass
            shutil.rmtree(dest, ignore_errors=True)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src, dest, symlinks=True)
            entries[(kind, name)] = {"kind": kind, "name": name, **sanitize_meta(kind, op.get("meta") or {}, built)}
        elif which == "remove":
            drop(kind, name)
        elif which == "keep-prs":
            current = {}
            for p in op.get("open", []):
                n = str(p.get("number", ""))
                if idx.entry_dir("pr", n):
                    current[n] = p
            for (k, n) in list(entries):
                if k != "pr":
                    continue
                if n not in current:
                    drop(k, n)
                else:  # titles and branches change without a new build
                    e = entries[(k, n)]
                    e["title"] = idx.clean(current[n].get("title"), idx.TITLE_MAX)
                    e["branch"] = idx.clean(current[n].get("branch"), idx.BRANCH_MAX)
        elif which == "keep-releases":
            keep = {str(t) for t in op.get("tags", [])}
            for (k, n) in list(entries):
                if k in ("release", "data") and n not in keep:
                    drop(k, n)
        else:
            raise PagesError(f"unknown op {which!r}")

    # Directories without an entry (a half-finished earlier write, a removed
    # entry's leftovers) go; only when there was a manifest to go by.
    if old is not None:
        known = {idx.entry_dir(k, n).rstrip("/") for (k, n) in entries}
        for group in ("pr", "release"):
            g = root / group
            if g.is_dir():
                for child in g.iterdir():
                    if f"{group}/{child.name}" not in known:
                        shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
                if not any(g.iterdir()):
                    g.rmdir()
        m = root / "main"
        if m.is_dir() and "main" not in known:
            shutil.rmtree(m)

    listed = sorted(entries.values(), key=lambda e: (e["kind"], e["name"]))
    doc = {"schema": SCHEMA, "repo": repo, "entries": listed}
    # `generated` only moves when something else did: an unchanged site must
    # produce an identical tree (nothing to push).
    same = old is not None and old.get("entries") == listed and old.get("repo") == repo
    doc["generated"] = old.get("generated") if same and old.get("generated") else now_iso()
    (root / "entries.json").write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    idx.main(["--manifest", str(root / "entries.json"), "--out", str(root)])
    (root / "robots.txt").write_text(ROBOTS, encoding="utf-8")
    (root / ".nojekyll").write_text("", encoding="utf-8")
    total = tree_bytes(root)
    if total > MAX_TOTAL_BYTES:
        raise PagesError(f"the site would be {total // 2**20} MB (limit {MAX_TOTAL_BYTES // 2**20} MB): remove entries or lower PAGES_MAX_RELEASES")
    return doc


# --- git

def git(repo: Path, *args: str, check=True, cwd: Path | None = None, capture=True) -> subprocess.CompletedProcess:
    env = {**os.environ,
           "GIT_AUTHOR_NAME": os.environ.get("GIT_AUTHOR_NAME", "github-actions[bot]"),
           "GIT_AUTHOR_EMAIL": os.environ.get("GIT_AUTHOR_EMAIL", "41898282+github-actions[bot]@users.noreply.github.com")}
    env.setdefault("GIT_COMMITTER_NAME", env["GIT_AUTHOR_NAME"])
    env.setdefault("GIT_COMMITTER_EMAIL", env["GIT_AUTHOR_EMAIL"])
    r = subprocess.run(["git", "-C", str(cwd or repo), *args], env=env, text=True,
                       stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None)
    if check and r.returncode:
        raise PagesError(f"git {' '.join(args)}: {(r.stderr or '').strip()}")
    return r


def publish_once(repo: Path, ops: list[dict], slug: str | None, incoming: Path | None, remote: str, branch: str, message: str, push: bool) -> str:
    """One attempt: returns 'pushed <sha>', 'unchanged' or raises (LeaseLost when the push lost the race)."""
    ref = f"refs/pages-publish/{branch}"
    fetched = git(repo, "fetch", "--no-tags", "--depth=1", remote, f"+refs/heads/{branch}:{ref}", check=False)
    old = git(repo, "rev-parse", "--verify", "-q", ref, check=False).stdout.strip() if fetched.returncode == 0 else ""
    if fetched.returncode and "couldn't find remote ref" not in (fetched.stderr or ""):
        raise PagesError(f"fetch {remote} {branch}: {fetched.stderr.strip()}")
    work = Path(tempfile.mkdtemp(prefix="pages-work-"))
    wt = work / "tree"
    try:
        if old:
            git(repo, "worktree", "add", "--detach", str(wt), old)
        else:
            git(repo, "worktree", "add", "--detach", str(wt), "HEAD")
            for child in wt.iterdir():  # an empty tree to start from
                if child.name != ".git":
                    shutil.rmtree(child) if child.is_dir() else child.unlink()
        apply_ops(wt, ops, slug, incoming)
        git(repo, "checkout", "-q", "--orphan", "pages-publish-new", cwd=wt)
        git(repo, "add", "-A", "--force", cwd=wt)
        tree = git(repo, "write-tree", cwd=wt).stdout.strip()
        if old and git(repo, "rev-parse", f"{old}^{{tree}}").stdout.strip() == tree:
            return "unchanged"
        commit = git(repo, "commit-tree", tree, "-m", message, cwd=wt).stdout.strip()
        if not push:
            git(repo, "update-ref", f"refs/pages-publish/new-{branch}", commit)
            return f"committed {commit}"
        lease = f"--force-with-lease=refs/heads/{branch}:{old}"
        r = git(repo, "push", "--porcelain", lease, remote, f"{commit}:refs/heads/{branch}", check=False)
        if r.returncode:
            raise LeaseLost(r.stderr.strip() or r.stdout.strip())
        return f"pushed {commit}"
    finally:
        git(repo, "worktree", "remove", "--force", str(wt), check=False)
        shutil.rmtree(work, ignore_errors=True)
        git(repo, "worktree", "prune", check=False)


class LeaseLost(PagesError):
    pass


def publish(repo: Path, ops: list[dict], slug: str | None, incoming: Path | None = None, remote="origin", branch="gh-pages",
            message="Update the Pages site", retries=6, push=True, sleep=time.sleep) -> str:
    last = ""
    for attempt in range(1, retries + 1):
        try:
            return publish_once(repo, ops, slug, incoming, remote, branch, message, push)
        except LeaseLost as e:
            last = str(e)
            print(f"attempt {attempt}: push refused ({last.splitlines()[-1] if last else 'lease'}), applying again on the new state", file=sys.stderr)
            sleep(random.uniform(0.5, 2.0) * attempt)
    raise PagesError(f"gave up after {retries} attempts: {last}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", required=True, type=Path, help="git checkout with the remote's credentials")
    ap.add_argument("--ops", required=True, type=Path, action="append", help="JSON list of operations (repeatable)")
    ap.add_argument("--incoming", type=Path, help="directory the `dir` of put ops is relative to")
    ap.add_argument("--slug", help="owner/name, for the links of the index page")
    ap.add_argument("--remote", default="origin")
    ap.add_argument("--branch", default="gh-pages")
    ap.add_argument("--retries", type=int, default=6)
    ap.add_argument("--message", default=os.environ.get("PAGES_MESSAGE", "Update the Pages site"))
    ap.add_argument("--no-push", action="store_true", help="build the commit, do not push (refs/pages-publish/new-<branch>)")
    a = ap.parse_args(argv)
    ops = []
    for f in a.ops:
        part = json.loads(f.read_text(encoding="utf-8"))
        if not isinstance(part, list):
            print(f"{f}: not a JSON list", file=sys.stderr)
            return 1
        ops += part
    slug = a.slug if a.slug and idx.REPO_RE.fullmatch(a.slug) else None
    try:
        print(publish(a.repo, ops, slug, a.incoming, a.remote, a.branch, idx.clean(a.message, 200), a.retries, not a.no_push))
    except PagesError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
