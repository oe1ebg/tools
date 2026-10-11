"""Fetch the published release tarballs for the Pages site.

    python3 scripts/pages_releases.py --slug owner/name --out DIR [--current entries.json] [--max-releases 3]

Read-only part of .github/workflows/pages.yml (job `releases`, `gh` with a
read token): lists the releases, picks the newest --max-releases `vX.Y.Z`
releases plus the rolling prerelease `data-latest`, and for each one whose
tarball differs from what the site shows (entries.json: `sha256`) downloads
`oe1ebg-tools-*.tar.gz` and its `.sha256`, verifies the checksum, unpacks it
safely and writes

    DIR/ops.json                     list of ops for scripts/pages_publish.py
    DIR/release/<tag>/...            the unpacked bundle of each changed one

so the Pages site shows exactly the published artifact, not a rebuild. A
`keep-releases` op lists everything that stays; releases that are not on it
(older ones, deleted ones) are removed from the site. Nothing is written to
the ops file if the release list cannot be read: a failed listing must never
look like "all releases deleted".

Stdlib only; `gh` does the network. GH_TOKEN/GITHUB_TOKEN as usual.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pages_index as idx  # noqa: E402

DATA_TAG = "data-latest"
MAX_UNPACKED = 400 * 1024 * 1024


def oneline(text) -> str:
    """Messages carry asset and member names: one line, so a name cannot start a workflow command."""
    return re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]+", " ", str(text)).strip()


def gh(*args: str) -> str:
    r = subprocess.run(["gh", *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode:
        raise SystemExit(oneline(f"gh {' '.join(args)}: {r.stderr.strip()}"))
    return r.stdout


def version_key(tag: str):
    return tuple(int(x) for x in re.findall(r"\d+", tag)[:3])


def select(releases: list[dict], max_releases: int) -> list[tuple[str, str]]:
    """[(kind, tag)]: the newest stable vX.Y.Z releases and data-latest; drafts and everything else ignored."""
    out = []
    stable = [r["tagName"] for r in releases
              if not r.get("isDraft") and not r.get("isPrerelease") and idx.TAG_RE.fullmatch(r.get("tagName", ""))]
    for tag in sorted(stable, key=version_key, reverse=True)[:max_releases]:
        out.append(("release", tag))
    if any(r.get("tagName") == DATA_TAG and not r.get("isDraft") for r in releases):
        out.append(("data", DATA_TAG))
    return out


def parse_sha256(text: str, tarball: str) -> str:
    """The digest from `<sha256>  <name>` for exactly this tarball, else ''."""
    for line in text.splitlines():
        m = re.fullmatch(r"([0-9a-fA-F]{64}) [ *]?(\S+)", line.strip())
        if m and m.group(2) == tarball:
            return m.group(1).lower()
    return ""


def safe_extract(tarball: Path, dest: Path) -> Path:
    """Unpack into dest; only regular files and directories under one top directory. Returns that directory."""
    total = 0
    top = None
    with tarfile.open(tarball, "r:gz") as tf:
        members = tf.getmembers()
        for m in members:
            p = Path(m.name)
            if p.is_absolute() or ".." in p.parts or not p.parts:
                raise SystemExit(oneline(f"{tarball.name}: unsafe member {m.name!r}"))
            if not (m.isfile() or m.isdir()):
                raise SystemExit(oneline(f"{tarball.name}: member {m.name!r} is not a regular file or directory"))
            if top is None:
                top = p.parts[0]
            elif p.parts[0] != top:
                raise SystemExit(f"{tarball.name}: more than one top-level entry")
            total += m.size
            if total > MAX_UNPACKED:
                raise SystemExit(f"{tarball.name}: unpacks to more than {MAX_UNPACKED // 2**20} MB")
        if top is None:
            raise SystemExit(f"{tarball.name}: empty")
        tf.extractall(dest, members=members, filter="data") if sys.version_info >= (3, 12) else tf.extractall(dest, members=members)
    return dest / top


def fetch_one(slug: str, tag: str, work: Path, current_sha256: str) -> tuple[Path, str] | None:
    """Download and verify the tarball of `tag`; None when it is what the site has already."""
    d = work / tag
    d.mkdir(parents=True)
    gh("release", "download", tag, "--repo", slug, "--pattern", "oe1ebg-tools-*.tar.gz.sha256", "--dir", str(d))
    sums = sorted(d.glob("oe1ebg-tools-*.tar.gz.sha256"))
    if len(sums) != 1:
        raise SystemExit(f"{tag}: expected one .sha256 asset, found {len(sums)}")
    tarball_name = sums[0].name.removesuffix(".sha256")
    digest = parse_sha256(sums[0].read_text(encoding="utf-8"), tarball_name)
    if not digest:
        raise SystemExit(f"{tag}: cannot read {sums[0].name}")
    if digest == current_sha256:
        return None
    gh("release", "download", tag, "--repo", slug, "--pattern", tarball_name, "--dir", str(d))
    tb = d / tarball_name
    h = hashlib.sha256()
    with tb.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != digest:
        raise SystemExit(f"{tag}: {tarball_name} does not match its .sha256")
    return safe_extract(tb, d / "unpacked"), digest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--slug", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--current", type=Path, help="entries.json of the site as it is now")
    ap.add_argument("--max-releases", type=int, default=3)
    ap.add_argument("--dir-prefix", default="", help="prefix of the ops' `dir` (where the artifact lands below pages_publish's --incoming)")
    a = ap.parse_args(argv)
    if not idx.REPO_RE.fullmatch(a.slug):
        raise SystemExit("bad --slug")

    have = {}
    if a.current and a.current.is_file():
        try:
            for e in json.loads(a.current.read_text(encoding="utf-8")).get("entries", []):
                have[(e.get("kind"), e.get("name"))] = e.get("sha256", "")
        except (ValueError, AttributeError):
            pass

    as_of = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    releases = json.loads(gh("release", "list", "--repo", a.slug, "--limit", "200", "--json", "tagName,isPrerelease,isDraft"))
    chosen = select(releases, a.max_releases)
    a.out.mkdir(parents=True, exist_ok=True)
    ops = []
    work = Path(tempfile.mkdtemp(prefix="pages-releases-"))
    try:
        for kind, tag in chosen:
            # One bad release (no or two .sha256 assets, as data-latest is for a
            # moment while data.yml swaps its assets, a checksum mismatch, a failed
            # download) must not stop the others: it is skipped loudly and keeps
            # its old entry, which stays on the keep list. Never published unverified.
            try:
                got = fetch_one(a.slug, tag, work, have.get((kind, tag), ""))
            except SystemExit as e:
                print(f"::warning title=Pages: {tag} skipped::{oneline(e)}")
                shutil.rmtree(work / tag, ignore_errors=True)
                continue
            if got is None:
                print(f"{tag}: unchanged")
                continue
            tree, digest = got
            if not (tree / "index.html").is_file():
                print(f"::warning title=Pages: {tag} skipped::no index.html in the tarball")
                continue
            target = a.out / "release" / tag
            shutil.rmtree(target, ignore_errors=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(tree), str(target))
            ops.append({"op": "put", "kind": kind, "name": tag, "dir": f"{a.dir_prefix}release/{tag}", "meta": {"title": tag, "sha256": digest}})
            print(f"{tag}: fetched")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    ops.append({"op": "keep-releases", "as_of": as_of, "tags": [t for _, t in chosen]})
    (a.out / "ops.json").write_text(json.dumps(ops, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
