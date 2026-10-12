// The GitHub Pages preview site (.github/workflows/pages.yml): the index
// generator (scripts/build_pages_index.py), the event -> operations plan
// (pages_ops.py), the release picking (pages_releases.py) and the writes to
// the gh-pages branch (pages_publish.py) against a throwaway bare
// repository acting as `origin`. Stdlib Python and git only; the tests skip
// when either is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const have = cmd => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const SKIP = have('python3') && have('git') ? false : 'needs python3 and git';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const py = (code, ...args) => sh('python3', ['-c', `import sys, json; sys.path.insert(0, "scripts"); ${code}`, ...args]);
const tmp = () => mkdtempSync(join(tmpdir(), 'oe1ebg-pages-'));

const NOW = '2026-10-11T10:00:00Z';
const ENV = { ...process.env, PAGES_NOW: NOW, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function render(manifest) {
  const d = tmp();
  writeFileSync(join(d, 'entries.json'), JSON.stringify({ schema: 1, repo: 'oe1ebg/tools', generated: NOW, ...manifest }));
  sh('python3', ['scripts/build_pages_index.py', '--manifest', join(d, 'entries.json'), '--out', d]);
  return readFileSync(join(d, 'index.html'), 'utf8');
}

// --- index

test('index: groups, order, links, the shared-origin notice', { skip: SKIP }, () => {
  const html = render({ entries: [
    { kind: 'release', name: 'v1.2.0', version: 'v1.2.0', sha: 'a'.repeat(40), updated: NOW },
    { kind: 'release', name: 'v1.10.0', version: 'v1.10.0', sha: 'b'.repeat(40), updated: NOW },
    { kind: 'pr', name: '7', title: 'Fix the thing', branch: 'fix/thing', sha: 'c'.repeat(40), updated: NOW },
    { kind: 'pr', name: '12', title: 'Another', branch: 'feat/x', sha: 'd'.repeat(40), updated: NOW },
    { kind: 'main', name: 'main', sha: 'e'.repeat(40), updated: NOW },
    { kind: 'data', name: 'data-latest', version: 'v1.10.0', updated: NOW },
  ] });
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.ok(!/<script|https?:\/\/(?!github\.com|oe1ebg\.at)/.test(html), 'no script, no foreign host');
  assert.match(html, /same browser origin/);
  assert.match(html, /all entries share one local logbook/);
  assert.ok(html.indexOf('Latest build of main') < html.indexOf('Open pull requests'));
  assert.ok(html.indexOf('Open pull requests') < html.indexOf('>Releases<'));
  assert.ok(html.indexOf('>Releases<') < html.indexOf('Rolling data build'));
  assert.ok(html.indexOf('/pull/12"') < html.indexOf('/pull/7"'), 'newest PR first');
  assert.ok(html.indexOf('releases/tag/v1.10.0') < html.indexOf('releases/tag/v1.2.0'), 'numeric version order');
  for (const href of ['main/', 'pr/12/', 'pr/12/confirm/', 'pr/12/notfunk/', 'pr/12/adif/', 'pr/12/sota-alerts/', 'release/v1.2.0/', 'release/data-latest/adif/']) {
    assert.ok(html.includes(`href="${href}"`), href);
  }
  assert.match(html, /branch <code><bdi>fix\/thing<\/bdi><\/code>/);
  assert.match(html, /<time datetime="2026-10-11T10:00:00Z">/);
  assert.ok(![...html.matchAll(/href="([^"]*)"/g)].some(([, h]) => h.startsWith('/')), 'no absolute paths');
});

test('index: titles are untrusted, everything is escaped, hrefs come from patterns only', { skip: SKIP }, () => {
  const evil = '<img src=x onerror=alert(1)>"\'&<script>alert(2)</script>‮\x00';
  const html = render({ entries: [
    { kind: 'pr', name: '5', title: evil, branch: evil, sha: 'f'.repeat(40), updated: NOW, dir: '../x', href: 'javascript:alert(1)' },
    { kind: 'pr', name: '../../etc', title: 'path' },
    { kind: 'pr', name: '6" onclick="x', title: 'attr' },
    { kind: 'release', name: 'v1.0.0"><script>', title: 'tag' },
    { kind: 'bogus', name: 'x' },
    { kind: 'pr', name: '8', title: 'x'.repeat(5000), sha: '<b>', updated: '<i>' },
  ] });
  assert.ok(!html.includes('<img'), 'no tag from a title');
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('onclick='));
  assert.ok(!html.includes('../'));
  assert.ok(!html.includes('‮') && !html.includes('\x00'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#x27;&amp;&lt;script&gt;/);
  assert.ok(!html.includes('pr/6'), 'invalid names dropped');
  assert.ok(html.includes('pr/8/'), 'the valid one stays');
  assert.ok(!html.includes('<b>') && !html.includes('<i>'), 'sha and updated are pattern-checked');
  assert.ok(html.length < 40000, 'long titles are cut');
});

test('index: an empty site and an unsupported schema', { skip: SKIP }, () => {
  const html = render({ entries: [] });
  assert.equal([...html.matchAll(/Nothing here at the moment/g)].length, 4);
  const d = tmp();
  writeFileSync(join(d, 'm.json'), '{"schema": 99}');
  const r = spawnSync('python3', ['scripts/build_pages_index.py', '--manifest', join(d, 'm.json'), '--out', d], { cwd: ROOT });
  assert.equal(r.status, 1);
});

// --- plan

const plan = (env, extra = {}) => JSON.parse(py(
  'import pages_ops as p; a = json.loads(sys.argv[1]); print(json.dumps(p.plan(a["env"], a.get("open", []), a.get("state", ""), a.get("rel"), a.get("entry", False))))',
  JSON.stringify({ env, ...extra })));

test('plan: pull requests, main, releases and the clean-up', { skip: SKIP }, () => {
  const open = [{ number: 7, title: 'T', headRefName: 'b' }, { number: 9, title: 'fork', headRefName: 'f', isCrossRepository: true }];
  const pr = { EVENT_NAME: 'pull_request', EVENT_ACTION: 'synchronize', PR_NUMBER: '7', PR_TITLE: 'T', PR_BRANCH: 'b', PR_SHA: 'a'.repeat(40) };
  let ops = plan(pr, { open, state: 'OPEN', entry: true });
  assert.deepEqual(ops.map(o => o.op), ['put', 'keep-prs']);
  assert.deepEqual([ops[0].kind, ops[0].name, ops[0].dir], ['pr', '7', 'entry']);
  assert.deepEqual(ops[1].open.map(p => p.number), [7], 'fork PRs are not listed');
  // closed while building: no put, the clean-up removes it
  assert.deepEqual(plan(pr, { open: [], state: 'CLOSED', entry: true }).map(o => o.op), ['keep-prs']);
  ops = plan({ ...pr, EVENT_ACTION: 'closed' }, { open: [] });
  assert.deepEqual(ops.map(o => `${o.op}:${o.name || ''}`), ['remove:7', 'keep-prs:']);
  assert.throws(() => plan({ ...pr, PR_NUMBER: '7/../x' }));
  // main
  ops = plan({ EVENT_NAME: 'push', GITHUB_SHA: 'b'.repeat(40), GITHUB_REF_NAME: 'main', DEFAULT_BRANCH: 'main' }, { entry: true });
  assert.deepEqual(ops.map(o => o.op + ':' + (o.kind || '')), ['put:main', 'keep-prs:']);
  // dispatch on another branch: no main entry; schedule: releases only
  assert.deepEqual(plan({ EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'x', DEFAULT_BRANCH: 'main' }, { entry: true }).map(o => o.op), ['keep-prs']);
  const rel = [{ op: 'keep-releases', tags: ['v1.0.0'] }];
  assert.deepEqual(plan({ EVENT_NAME: 'schedule' }, { rel }).map(o => o.op), ['keep-releases', 'keep-prs']);
  // a pull request run never takes the release ops of an artifact
  assert.ok(!plan(pr, { rel, open, state: 'OPEN', entry: true }).some(o => o.op === 'keep-releases'));
});

// --- releases

test('releases: which ones are published, checksum parsing', { skip: SKIP }, () => {
  const rel = JSON.parse(py(
    'import pages_releases as r; print(json.dumps(r.select(json.loads(sys.argv[1]), 2)))',
    JSON.stringify([
      { tagName: 'v1.9.0' }, { tagName: 'v1.10.0' }, { tagName: 'v1.2.0' }, { tagName: 'v2.0.0', isDraft: true },
      { tagName: 'v3.0.0-rc1', isPrerelease: true }, { tagName: 'data-latest', isPrerelease: true }, { tagName: 'nightly' },
    ])));
  assert.deepEqual(rel, [['release', 'v1.10.0'], ['release', 'v1.9.0'], ['data', 'data-latest']]);
  const h = 'ab'.repeat(32);
  const out = JSON.parse(py('import pages_releases as r; print(json.dumps([r.parse_sha256(sys.argv[1], "oe1ebg-tools-v1.tar.gz"), r.parse_sha256(sys.argv[2], "oe1ebg-tools-v1.tar.gz")]))',
    `${h}  oe1ebg-tools-v1.tar.gz\n`, `${h}  other.tar.gz\n`));
  assert.deepEqual(out, [h, '']);
});

test('releases: tarball members are checked before unpacking', { skip: SKIP }, () => {
  const d = tmp();
  const code = `
import io, tarfile, pages_releases as r, pathlib
d = pathlib.Path(sys.argv[1])
def mk(name, members):
    with tarfile.open(d / name, "w:gz") as tf:
        for n, kind in members:
            ti = tarfile.TarInfo(n)
            if kind == "link": ti.type = tarfile.SYMTYPE; ti.linkname = "/etc/passwd"; tf.addfile(ti)
            else: data = b"x"; ti.size = 1; tf.addfile(ti, io.BytesIO(data))
res = {}
for name, members in {"ok.tgz": [("t/index.html", "f")], "up.tgz": [("t/../../x", "f")], "abs.tgz": [("/etc/x", "f")],
                      "link.tgz": [("t/l", "link")], "two.tgz": [("a/x", "f"), ("b/x", "f")]}.items():
    mk(name, members)
    try: r.safe_extract(d / name, d / ("out-" + name)); res[name] = "ok"
    except SystemExit as e: res[name] = "refused"
print(json.dumps(res))`;
  const res = JSON.parse(py(code, d));
  assert.deepEqual(res, { 'ok.tgz': 'ok', 'up.tgz': 'refused', 'abs.tgz': 'refused', 'link.tgz': 'refused', 'two.tgz': 'refused' });
});

// --- publish against a bare origin

function setup() {
  const base = tmp();
  const origin = join(base, 'origin.git');
  sh('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: ENV });
  // the "checkout" the workflow runs in: a clone of the default branch
  const seed = join(base, 'seed');
  sh('git', ['init', '-q', '-b', 'main', seed], { env: ENV });
  sh('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { env: ENV });
  sh('git', ['-C', seed, 'push', '-q', origin, 'main'], { env: ENV });
  const repo = join(base, 'checkout');
  sh('git', ['clone', '-q', origin, repo], { env: ENV });
  return { base, origin, repo };
}

function bundle(base, name, extra = {}) {
  const d = join(base, 'incoming', name);
  mkdirSync(join(d, 'confirm'), { recursive: true });
  writeFileSync(join(d, 'index.html'), `<!doctype html><title>${name}</title>`);
  writeFileSync(join(d, 'confirm', 'sw.js'), '// sw');
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ name: 'oe1ebg-tools', version: name, commit: 'a'.repeat(40), built: '2026-10-01T00:00:00Z', ...extra }));
  return d;
}

function publish(ctx, ops, { expectFail = false, env = {} } = {}) {
  const f = join(ctx.base, `ops-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(ops));
  const r = spawnSync('python3', ['scripts/pages_publish.py', '--repo', ctx.repo, '--ops', f, '--incoming', join(ctx.base, 'incoming'), '--slug', 'oe1ebg/tools', '--message', 'test'],
    { cwd: ROOT, encoding: 'utf8', env: { ...ENV, ...env } });
  if (expectFail) { assert.notEqual(r.status, 0, r.stdout); return r; }
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r;
}

const files = (origin, rev = 'gh-pages') => sh('git', ['--git-dir', origin, 'ls-tree', '-r', '--name-only', rev], { env: ENV }).split('\n').filter(Boolean);
const show = (origin, path) => sh('git', ['--git-dir', origin, 'show', `gh-pages:${path}`], { env: ENV });
const commits = origin => sh('git', ['--git-dir', origin, 'rev-list', '--count', 'gh-pages'], { env: ENV }).trim();
const put = (kind, name, dir, meta = {}) => ({ op: 'put', kind, name, dir, meta });

test('publish: first entry creates the branch, more entries and removals, one orphan commit', { skip: SKIP }, () => {
  const ctx = setup();
  bundle(ctx.base, 'entry');
  bundle(ctx.base, 'second');
  let r = publish(ctx, [put('pr', '12', 'entry', { title: 'First <b>', branch: 'feat/a', sha: 'c'.repeat(40) })]);
  assert.match(r.stdout, /^pushed /);
  assert.deepEqual(files(ctx.origin).filter(f => !f.startsWith('pr/12/')),
    ['.nojekyll', '404.html', 'entries.json', 'index.html', 'robots.txt']);
  assert.ok(files(ctx.origin).includes('pr/12/confirm/sw.js'));
  assert.equal(show(ctx.origin, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  assert.match(show(ctx.origin, 'index.html'), /First &lt;b&gt;/);
  assert.equal(commits(ctx.origin), '1');

  publish(ctx, [put('main', 'main', 'second', { title: 'main', sha: 'e'.repeat(40) }), { op: 'keep-prs', open: [{ number: 12, title: 'Renamed', branch: 'feat/a' }] }]);
  const m = JSON.parse(show(ctx.origin, 'entries.json'));
  assert.deepEqual(m.entries.map(e => `${e.kind}/${e.name}`), ['main/main', 'pr/12']);
  assert.equal(m.entries[1].title, 'Renamed');
  assert.equal(commits(ctx.origin), '1', 'history stays one commit');
  assert.ok(files(ctx.origin).includes('main/index.html'));

  // removing the PR (closed), a no-op afterwards pushes nothing
  publish(ctx, [{ op: 'remove', kind: 'pr', name: '12' }]);
  assert.ok(!files(ctx.origin).some(f => f.startsWith('pr/')));
  assert.ok(files(ctx.origin).includes('main/index.html'));
  const before = sh('git', ['--git-dir', ctx.origin, 'rev-parse', 'gh-pages'], { env: ENV });
  r = publish(ctx, [{ op: 'remove', kind: 'pr', name: '12' }]);
  assert.match(r.stdout, /^unchanged/);
  assert.equal(sh('git', ['--git-dir', ctx.origin, 'rev-parse', 'gh-pages'], { env: ENV }), before);
  assert.doesNotMatch(show(ctx.origin, 'index.html'), /pull\/12/);
});

test('publish: reconcile drops closed PRs and vanished releases, keeps foreign files', { skip: SKIP }, () => {
  const ctx = setup();
  bundle(ctx.base, 'a');
  publish(ctx, [put('pr', '1', 'a'), put('pr', '2', 'a'), put('release', 'v1.0.0', 'a', { sha256: '1'.repeat(64) }), put('release', 'v0.9.0', 'a'), put('data', 'data-latest', 'a')]);
  // Pages itself adds a CNAME to the branch for a custom domain: it must survive
  const wt = join(ctx.base, 'cname');
  sh('git', ['clone', '-q', '-b', 'gh-pages', ctx.origin, wt], { env: ENV });
  writeFileSync(join(wt, 'CNAME'), 'previews.example.org\n');
  sh('git', ['-C', wt, 'add', 'CNAME'], { env: ENV });
  sh('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'cname'], { env: ENV });
  sh('git', ['-C', wt, 'push', '-q', 'origin', 'gh-pages'], { env: ENV });
  assert.equal(commits(ctx.origin), '2');

  publish(ctx, [{ op: 'keep-releases', tags: ['v1.0.0', 'data-latest'] }, { op: 'keep-prs', open: [{ number: 2, title: 'two', branch: 'b' }] }]);
  const names = JSON.parse(show(ctx.origin, 'entries.json')).entries.map(e => `${e.kind}/${e.name}`);
  assert.deepEqual(names, ['data/data-latest', 'pr/2', 'release/v1.0.0']);
  const fl = files(ctx.origin);
  assert.ok(!fl.some(f => f.startsWith('pr/1/') || f.startsWith('release/v0.9.0/')));
  assert.ok(fl.includes('release/data-latest/index.html') && fl.includes('CNAME'));
  assert.equal(commits(ctx.origin), '1', 'squashed to one orphan commit again');
  // a leftover directory without an entry is cleaned up
  const stray = join(ctx.base, 'stray');
  sh('git', ['clone', '-q', '-b', 'gh-pages', ctx.origin, stray], { env: ENV });
  mkdirSync(join(stray, 'pr', '99'), { recursive: true });
  writeFileSync(join(stray, 'pr', '99', 'index.html'), 'x');
  sh('git', ['-C', stray, 'add', '-A'], { env: ENV });
  sh('git', ['-C', stray, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'stray'], { env: ENV });
  sh('git', ['-C', stray, 'push', '-q', 'origin', 'gh-pages'], { env: ENV });
  publish(ctx, [{ op: 'keep-prs', open: [{ number: 2, title: 'two', branch: 'b' }] }]);
  assert.ok(!files(ctx.origin).some(f => f.startsWith('pr/99/')));
});

test('publish: refuses symlinks, special names, escapes and bad kinds; nothing is pushed', { skip: SKIP }, () => {
  const ctx = setup();
  const d = bundle(ctx.base, 'evil');
  symlinkSync('/etc/passwd', join(d, 'link'));
  publish(ctx, [put('pr', '3', 'evil')], { expectFail: true });
  rmSync(join(d, 'link'));
  const good = bundle(ctx.base, 'good');
  for (const op of [put('pr', '3', '../good'), put('pr', '3', join(ctx.base, 'incoming', 'good')), put('pr', '../3', 'good'), put('pr', '3/x', 'good'), put('main', 'other', 'good'), put('pr', '3', 'nonexistent'), { op: 'nope' }]) {
    publish(ctx, [op], { expectFail: true });
  }
  mkdirSync(join(good, '.git'));
  writeFileSync(join(good, '.git', 'config'), '');
  publish(ctx, [put('pr', '3', 'good')], { expectFail: true });
  const heads = sh('git', ['--git-dir', ctx.origin, 'branch', '--list', 'gh-pages'], { env: ENV });
  assert.equal(heads.trim(), '', 'gh-pages was never created');
});

test('publish: a lost race (someone else pushed) is applied again on the new state', { skip: SKIP }, () => {
  const ctx = setup();
  bundle(ctx.base, 'a');
  bundle(ctx.base, 'b');
  publish(ctx, [put('pr', '1', 'a')]);
  // A driver that, right before our first `git push`, lets another writer push a change.
  const intruder = join(ctx.base, 'intruder');
  const code = `
import json, os, subprocess, sys, pathlib
import pages_publish as p
repo, incoming, origin, intruder = sys.argv[1:5]
subprocess.run(["git", "clone", "-q", "-b", "gh-pages", origin, intruder], check=True)
real = p.git
state = {"pushes": 0}
def git(r, *args, **kw):
    if args and args[0] == "push" and state["pushes"] == 0:
        state["pushes"] += 1
        # another run lands first: its own commit on top of what we fetched
        pathlib.Path(intruder, "pr", "2").mkdir(parents=True)
        pathlib.Path(intruder, "pr", "2", "index.html").write_text("x")
        subprocess.run(["git", "-C", intruder, "add", "-A"], check=True)
        subprocess.run(["git", "-C", intruder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "other"], check=True)
        subprocess.run(["git", "-C", intruder, "push", "-q", "origin", "gh-pages"], check=True)
    return real(r, *args, **kw)
p.git = git
ops = [{"op": "put", "kind": "pr", "name": "3", "dir": "b", "meta": {"title": "late"}}]
print(p.publish(pathlib.Path(repo), ops, "oe1ebg/tools", pathlib.Path(incoming), sleep=lambda s: None))
print(state["pushes"])`;
  const out = sh('python3', ['-c', `import sys; sys.path.insert(0, "scripts"); ${code}`, ctx.repo, join(ctx.base, 'incoming'), ctx.origin, intruder], { env: ENV });
  assert.match(out, /pushed /);
  assert.match(sh('git', ['--git-dir', ctx.origin, 'log', '-1', '--format=%s', 'gh-pages'], { env: ENV }), /^Update the Pages site/);
  const fl = files(ctx.origin);
  assert.ok(fl.includes('pr/3/index.html'), 'our change landed');
  assert.ok(fl.includes('pr/1/index.html'), 'the earlier entry is still there');
  // the intruder's pr/2 had no entry in entries.json: it is cleaned up, not trusted
  assert.ok(!fl.includes('pr/2/index.html'));
  assert.equal(commits(ctx.origin), '1');
});

test('publish: gives up after the retries when every push loses', { skip: SKIP }, () => {
  const ctx = setup();
  bundle(ctx.base, 'a');
  const code = `
import pathlib, sys
import pages_publish as p
real = p.git
def git(r, *args, **kw):
    if args and args[0] == "push":
        return type("R", (), {"returncode": 1, "stderr": "stale info", "stdout": ""})()
    return real(r, *args, **kw)
p.git = git
try:
    p.publish(pathlib.Path(sys.argv[1]), [{"op": "put", "kind": "pr", "name": "1", "dir": "a", "meta": {}}], None, pathlib.Path(sys.argv[2]), retries=3, sleep=lambda s: None)
except p.PagesError as e:
    print("gave up:", e)`;
  const out = sh('python3', ['-c', `import sys; sys.path.insert(0, "scripts"); ${code}`, ctx.repo, join(ctx.base, 'incoming')], { env: ENV });
  assert.match(out, /gave up after 3 attempts/);
  assert.ok(!existsSync(join(ctx.repo, '.git', 'worktrees')) || sh('git', ['-C', ctx.repo, 'worktree', 'list'], { env: ENV }).trim().split('\n').length === 1, 'no worktree left behind');
});

// --- review follow-ups

test('index: direction and zero-width characters are stripped, titles are isolated with <bdi>', { skip: SKIP }, () => {
  const html = render({ entries: [{ kind: 'pr', name: '5', title: 'a\u200bb\u200ec\u200fd\u061ce\ufeff\u202efdp.exe', branch: 'x\u200d/y', sha: 'f'.repeat(40) }] });
  for (const ch of ['\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u061c', '\ufeff', '\u202e']) assert.ok(!html.includes(ch), `U+${ch.charCodeAt(0).toString(16)}`);
  assert.match(html, /<bdi>abcde fdp\.exe<\/bdi>/);
  assert.match(html, /<code><bdi>x\/y<\/bdi><\/code>/);
});

test('publish: errors that name artifact files are one line (no workflow command injection)', { skip: SKIP }, () => {
  const ctx = setup();
  const d = bundle(ctx.base, 'evil');
  symlinkSync('/etc/passwd', join(d, 'x\n::error::pwned\n::set-output name=a::b'));
  const r = publish(ctx, [put('pr', '3', 'evil')], { expectFail: true });
  assert.ok(!/^::/m.test(r.stderr + r.stdout), r.stderr);
  assert.match(r.stderr, /^error: .*pwned/m);
});

test('publish: a full site fails with a clear message listing the entries (exit 3, error file)', { skip: SKIP }, () => {
  const ctx = setup();
  const big = bundle(ctx.base, 'big');
  writeFileSync(join(big, 'data.bin'), Buffer.alloc(700 * 1024));
  publish(ctx, [put('main', 'main', 'big'), put('pr', '1', 'big')], { env: { PAGES_MAX_TOTAL_MB: '2' } });
  const err = join(ctx.base, 'err.txt');
  const f = join(ctx.base, 'ops-full.json');
  writeFileSync(f, JSON.stringify([put('pr', '2', 'big'), put('pr', '3', 'big')]));
  const r = spawnSync('python3', ['scripts/pages_publish.py', '--repo', ctx.repo, '--ops', f, '--incoming', join(ctx.base, 'incoming'), '--error-file', err],
    { cwd: ROOT, encoding: 'utf8', env: { ...ENV, PAGES_MAX_TOTAL_MB: '2' } });
  assert.equal(r.status, 3, r.stderr);
  const msg = readFileSync(err, 'utf8');
  assert.match(msg, /the Pages site is full/);
  for (const n of ['main/main', 'pr/1', 'pr/2']) assert.ok(msg.includes(n), n);
  assert.match(msg, /MB/);
  assert.ok(!files(ctx.origin).includes('pr/2/index.html'), 'nothing was pushed');
});

test('publish: a stale clean-up snapshot does not drop what landed after it (lost-race retry)', { skip: SKIP }, () => {
  const ctx = setup();
  bundle(ctx.base, 'a');
  publish(ctx, [put('pr', '1', 'a'), put('pr', '8', 'a')]); // published at NOW (10:00)
  const intruder = join(ctx.base, 'intruder');
  // the plan was taken at 11:00 (no PR open); at 12:00 another run published PR 7, just before our push
  const code = `
import json, pathlib, subprocess, sys
import pages_publish as p
repo, incoming, origin, intruder = sys.argv[1:5]
subprocess.run(["git", "clone", "-q", "-b", "gh-pages", origin, intruder], check=True)
real = p.git
state = {"n": 0}
def git(r, *args, **kw):
    if args and args[0] == "push" and state["n"] == 0:
        state["n"] += 1
        root = pathlib.Path(intruder)
        (root / "pr" / "7").mkdir(parents=True)
        (root / "pr" / "7" / "index.html").write_text("x")
        m = json.loads((root / "entries.json").read_text())
        m["entries"].append({"kind": "pr", "name": "7", "title": "new", "published": "2026-10-11T12:00:00Z"})
        (root / "entries.json").write_text(json.dumps(m))
        for c in (["add", "-A"], ["commit", "-q", "-m", "other"], ["push", "-q", "origin", "gh-pages"]):
            subprocess.run(["git", "-C", intruder, "-c", "user.name=t", "-c", "user.email=t@t", *c], check=True)
    return real(r, *args, **kw)
p.git = git
ops = [{"op": "keep-prs", "as_of": "2026-10-11T11:00:00Z", "open": []}]
print(p.publish(pathlib.Path(repo), ops, None, pathlib.Path(incoming), sleep=lambda s: None))
print(state["n"])`;
  const out = sh('python3', ['-c', `import sys; sys.path.insert(0, "scripts"); ${code}`, ctx.repo, join(ctx.base, 'incoming'), ctx.origin, intruder], { env: ENV });
  assert.match(out, /pushed /);
  const names = JSON.parse(show(ctx.origin, 'entries.json')).entries.map(e => e.name);
  assert.deepEqual(names, ['7'], 'PR 1 and 8 (older than the snapshot, not open) are gone, PR 7 (newer) stays');
  assert.ok(files(ctx.origin).includes('pr/7/index.html'));
});

test('releases: one bad release is skipped loudly, the others go on, nothing unverified is published', { skip: SKIP }, () => {
  const d = tmp();
  // a fake `gh`: `release list` and `release download` over a table of releases
  const bin = join(d, 'bin');
  mkdirSync(bin);
  const code = `#!/usr/bin/env python3
import gzip, hashlib, io, json, sys, tarfile, pathlib
a = sys.argv[1:]
def tarball(tag):
    # byte-identical on every call: the checksum and the tarball are fetched by
    # separate gh calls, and gzip's header holds the time in seconds (mtime=0)
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tf:
        for n, data in ((f"oe1ebg-tools-{tag}/index.html", b"<title>x</title>"),
                        (f"oe1ebg-tools-{tag}/manifest.json", json.dumps({"version": tag, "commit": "a" * 40, "built": "2026-10-01T00:00:00Z"}).encode())):
            ti = tarfile.TarInfo(n); ti.size = len(data); tf.addfile(ti, io.BytesIO(data))
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        gz.write(raw.getvalue())
    return buf.getvalue()
if a[:2] == ["release", "list"]:
    print(json.dumps([{"tagName": t, "isPrerelease": t == "data-latest", "isDraft": False} for t in ("v1.2.0", "v1.1.0", "v1.0.0", "v0.9.0", "data-latest")]))
elif a[:2] == ["release", "download"]:
    tag = a[2]; pat = a[a.index("--pattern") + 1]; out = pathlib.Path(a[a.index("--dir") + 1]); out.mkdir(parents=True, exist_ok=True)
    name = f"oe1ebg-tools-{tag}.tar.gz"
    data = b"this is not a gzip tarball" if tag == "v0.9.0" else tarball(tag)  # corrupt, but its checksum matches
    digest = hashlib.sha256(data).hexdigest()
    if tag == "v1.0.0" and pat.endswith(".sha256"):            # two checksum assets
        (out / "oe1ebg-tools-a.tar.gz.sha256").write_text(f"{digest}  oe1ebg-tools-a.tar.gz\\n")
        (out / "oe1ebg-tools-b.tar.gz.sha256").write_text(f"{digest}  oe1ebg-tools-b.tar.gz\\n")
    elif tag == "data-latest" and pat.endswith(".sha256"):     # checksum that does not match the tarball
        (out / (name + ".sha256")).write_text("0" * 64 + f"  {name}\\n")
    elif pat.endswith(".sha256"):
        (out / (name + ".sha256")).write_text(f"{digest}  {name}\\n")
    elif tag == "v1.1.0":                                      # failed download
        sys.exit("HTTP 502")
    else:
        (out / name).write_bytes(data)
else:
    sys.exit("unexpected " + " ".join(a))
`;
  writeFileSync(join(bin, 'gh'), code, { mode: 0o755 });
  const out = join(d, 'out');
  const r = spawnSync('python3', ['scripts/pages_releases.py', '--slug', 'oe1ebg/tools', '--out', out, '--max-releases', '4'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const tag of ['v1.1.0', 'v1.0.0', 'v0.9.0', 'data-latest']) assert.match(r.stdout, new RegExp(`::warning title=Pages: ${tag} skipped::`), tag);
  const ops = JSON.parse(readFileSync(join(out, 'ops.json'), 'utf8'));
  assert.deepEqual(ops.filter(o => o.op === 'put').map(o => o.name), ['v1.2.0'], 'only the good release is published');
  const keep = ops.find(o => o.op === 'keep-releases');
  assert.deepEqual(keep.tags, ['v1.2.0', 'v1.1.0', 'v1.0.0', 'v0.9.0', 'data-latest'], 'skipped ones keep their old entry');
  assert.match(keep.as_of, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(existsSync(join(out, 'release', 'v1.2.0', 'index.html')));
  assert.ok(!existsSync(join(out, 'release', 'data-latest')) && !existsSync(join(out, 'release', 'v1.0.0')) && !existsSync(join(out, 'release', 'v0.9.0')), 'the mismatching or corrupt tarball is not published');
});

test('comment: bodies for every state, built from the number and sha only', { skip: SKIP }, () => {
  const body = (state, extra = '') => py('import pages_comment as c; print(c.body(sys.argv[1], "12", "ab" * 20, "https://o.github.io/tools/", sys.argv[2]))', state, extra);
  assert.match(body('published'), /^<!-- oe1ebg-pages-preview -->\nPreview of abababa: https:\/\/o\.github\.io\/tools\/pr\/12\//);
  assert.match(body('build-failed'), /build of abababa failed.*EARLIER commit/s);
  assert.match(body('full', 'the Pages site is full: main/main 49 MB'), /No preview of abababa: the Pages site is full\.\n\nthe Pages site is full: main\/main 49 MB/);
  assert.match(body('removed'), /Preview removed/);
  assert.match(body('error'), /could not be published/);
});
