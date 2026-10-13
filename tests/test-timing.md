# Test timing (issue #36)

Status: **CI baseline done** (2026-10-13, below); the local baseline on the
development machine (Apple M5 Pro, Node 24) is still to be repeated on a fixed
commit. Commands and raw results must accompany every table.

## How to measure

```sh
node scripts/bench_tests.mjs unit --runs 5 --concurrency 1,2,4,default
node scripts/bench_tests.mjs unit-files            # each test file alone: its own wall time
node scripts/bench_tests.mjs unit-focused --file tests/storage.test.mjs
node scripts/bench_tests.mjs e2e --project chromium --workers 1,2,4 --runs 5   # needs just e2e-setup + build
node scripts/bench_tests.mjs ci-runs --runs 10 --branch B --event workflow_dispatch   # jobs, steps, phases of ci.yml runs (gh)
```

Each writes `bench-tests.json` (git-ignored; `--out` renames it) with the
environment (runtimes, OS, CPUs, memory, commit, image digests, generated
data) and every individual result. Wall time is elapsed time, not summed case
durations. Peak memory is the largest single process, not the process tree.
The environment includes the load average at the start: timings of a busy
machine differ. `ci-runs` also records per run the queue time (per job; the
run itself starts at once), the wall time from the start to the last job's
end, the job that ended last (the end of the critical path), runner seconds
and billed minutes (each job rounded up to a minute), the runner and its image,
and for each `validate` job its browser step in phases from the timestamped
job log: image pull, `npm install`, Playwright start, the tests.
Warm runs: five repetitions. Cold runs (three) are done by hand and name what
is absent: package cache, generated data, or container images, one at a time.
On macOS run long series under `caffeinate -i` (e.g. `caffeinate -i node
scripts/bench_tests.mjs …`): an unattended Mac goes to sleep and then to
DarkWake, where the browsers are throttled and tests time out (the Node 24
series below).

## Local results, 2026-10-12 (partial baseline)

Machine: Apple M5 Pro, 18 CPUs, 64 GiB, macOS (Darwin 27.0.0). Node
**v24.21.0** (`.nvmrc`). Commit 33d5664 (`main`) plus the uncommitted changes
of this branch; `site/` built from it with the cached data; the ADIF
cross-check tools are not built, so 80 of 645 unit tests skip (this is not a
`DATA_TESTS=require` / `ADIF_CROSSCHECK=require` run). Raw results, every
individual run, in `tests/timing-results/2026-10-12-node24/`. An earlier
smoke run under Node 26.11.1 is discarded: it is not CI's Node.

Not yet measured: the other four browser projects, the cold-setup variants,
the GitHub runner class, queue time, the `ci-runs` sample, the Go tool build.
This is therefore **not yet the issue's baseline** and does not yet name the
three largest contributors.

### Unit tests (`node --test tests/*.test.mjs`, 5 runs each)

| `--test-concurrency` | median | range | peak RSS (largest process) |
| --- | ---: | ---: | ---: |
| 1 | 33.4 s | 32.7–33.5 s | 2.3 GiB |
| 2 | 17.8 s | 17.6–18.0 s | 2.3 GiB |
| 4 | 15.0 s | 14.9–15.0 s | 2.3 GiB |
| default | 14.9 s | 14.8–15.0 s | 2.3 GiB |

A further 15 runs at the default: median 15.4 s, range 14.7–32.3 s (one slow
run that passed). Each file run alone (one run each, 49 files; they sum to
37 s): `backup-parts` 14.1 s (2.3 GiB), `pages` 7.7 s, `confirm-offline`
3.9 s, `notfunk-offline` 2.3 s, all others under 1 s. `backup-parts` alone
is about the whole wall time of the parallel run, so more file concurrency
cannot go below it. Focused `storage.test.mjs`: 0.23 s (5 runs).

### Chromium browser tests (128 tests, 0 skipped, `playwright test --project=chromium`, no retries)

| workers | runs | median of passing runs | range of passing runs | failed runs |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 5 | 150 s | 148–155 s | 0 |
| 2 | 30 | 84.7 s | 83–117 s | **7** |
| 4 | 5 | 71 s | 69–75 s | 0 |

### All browser projects at 2 workers (as in CI; 5 runs each, no retries)

| project | passed / skipped | median, passing runs | range, passing runs | failed runs |
| --- | ---: | ---: | ---: | ---: |
| chromium (30 runs, above) | 128 / 0 | 84.7 s | 83–117 s | 7 of 30 |
| mobile-chromium | 127 / 1 | 86 s | 85–87 s | 2 of 5 |
| firefox | 79 / 49 | 50 s | 50–53 s | 0 of 5 |
| webkit | 77 / 51 | 46 s | 44–50 s | 1 of 5 |
| mobile-webkit | 76 / 52 | 45 s | 45–46 s | 3 of 5 |

The skips are by design: the service-worker tests run in Chromium only
(`test.skip(browserName !== 'chromium', …)`), plus one phone-only skip in
`sota-alerts.spec.mjs`. Runs that failed took 80–137 s (a test hitting its
60 s timeout, no retry). Failing tests: chromium and mobile-chromium
`offline-update.spec.mjs` (see below); webkit `confirm.spec.mjs` "importing
a backup that reuses a line id…"; mobile-webkit four different
`confirm.spec.mjs` tests, each a 60 s timeout ("stale counter never lowers
nextSeq", "split export beyond the set limits", "two immediate submits",
"note beyond the per-file limit"). Different tests timing out in different
runs looks like stalls, not one broken test; not yet analysed (machine load,
the single-threaded test server, or the engines). WebKit is not slower than
Firefox when it passes, but it is the least reliable here.

### Failures found while measuring

- **Unit, `tests/pages.test.mjs`:** "one bad release is skipped loudly…" failed
  1 of 35 idle runs and 2 of 10 runs under CPU load (18 busy loops). The fake `gh` rebuilt the
  tarball for the `.sha256` call and the tarball call; gzip stores the time in
  seconds, so the two differed whenever a second boundary fell between them.
  Fixed in #39 (gzip `mtime=0`), the PR below this one in the stack; 60 of
  60 runs under load pass with it.
- **Browser, `offline-update.spec.mjs`, 2 workers:** 7 of 30 runs had one
  failing test (127 of 128 passed), taking 112–1153 s instead of 85 s. In the
  5 runs where the test was recorded it was "an update from another tab: the
  tab with an unsaved draft is not reloaded" (4×) and "notfunk: update started
  in another tab while this tab has a draft conflict…" (1×). None with 1 or 4
  workers (5 runs each, too few to rule it out). Diagnosed since, see
  "Follow-up: the `offline-update.spec.mjs` failures" below: two causes, one
  fixed on `main`, one tracked in #41.

## CI sample (10 successful `ci.yml` runs up to run 38246575505)

`node scripts/bench_tests.mjs ci-runs --runs 10`, raw in
`tests/timing-results/2026-10-12-node24/ci-runs.json`. Mixed events (4 pull
requests, 5 pushes, 1 scheduled run), so descriptive only: step medians and
ranges, GitHub-hosted runners (class not recorded by the API; to be read from
the run logs). Run wall time, creation to last update (includes queueing):
335–377 s, median about 363 s.

| Step | n | median | range |
| --- | ---: | ---: | ---: |
| browser tests, mobile-chromium (container pull, `npm install`, tests) | 5 | 251 s | 249–254 s |
| browser tests, chromium | 10 | 243 s | 181–246 s |
| browser tests, firefox / webkit / mobile-webkit | 5 each | 154 / 154 / 135 s | 127–176 s |
| unit tests, job `test` | 10 | 48 s | 24–49 s |
| unit tests with the built data, job `bundle` | 10 | 49 s | 29–50 s |
| ADIF tools: set up Go | 6 | 11 s | 8–15 s |
| HTML validation (chromium job only) | 10 | 11 s | 8–14 s |
| bundle build | 10 | 10 s | 9–12 s |

Critical path, as the workflow is wired: `bundle` (about 3 + 3 s setup, 10 s
build, 49 s unit tests, upload) then the slowest `validate` job, the Chromium
or mobile-Chromium browser step (about 245–250 s). `test` runs beside
`bundle` and is not on the path. Provisional largest contributors to elapsed
time: (1) the Chromium-engine browser jobs, (2) `bundle`'s repeat of the unit
suite (49 s on the path, identical in size to `test`'s run), (3) the other
browser projects' steps (not on the path, but most of the runner minutes). The
`test-results.json` artifacts of the same runs (29 project runs; the CI step
includes container start and `npm install`) give Playwright's own duration:
chromium 150–217 s, mobile-chromium 210–225 s, firefox 94–142 s, webkit
113–148 s, mobile-webkit 96–142 s. So most of the CI browser step is test
execution, not setup: the step is about 25–90 s longer than the tests. The
same Chromium suite takes 85 s locally at two workers (Apple M5 Pro), so the
runner is roughly 2–2.5 times slower at the tests themselves.

CI scope differs from a full local run: without ADIF changes the `@adif`
tests are left out (110 instead of 128 Chromium tests in 5 of 10 runs).

### Reliability in CI (same 10 runs, 1 retry per test)

0 failed tests in 29 project runs. 1 flaky test (failed, then passed on the
retry): `offline.spec.mjs` "notfunk-offline.html downloads whole from the
installed tool" in Firefox, run 38173641850. No `offline-update.spec.mjs`
failure and no `confirm.spec.mjs` timeout. The local failures above
(7 of 30 Chromium runs, 3 of 5 mobile-WebKit runs at two workers) therefore
do not show up in CI at this sample size. CI differs from the local runs in
the server (nginx from `deploy/nginx.conf.example` in a container instead of
`tests/e2e/serve.py`), the OS and CPU count, the Playwright package and
browsers in the pinned image, and the one retry. For `offline-update.spec.mjs`
the machine load mattered, and CI fails too once the retry is off (next
section).

### Follow-up: the `offline-update.spec.mjs` failures

Two experiments, both with retries off:

- **CI** (a throwaway workflow on the CI runner, 4 vCPU AMD EPYC, 16 GB;
  bundle served by nginx as in `validate`): `offline-update.spec.mjs` with
  `--repeat-each=8` in each of 4 Chromium jobs and one mobile-Chromium job
  (about 2750 test runs), `confirm.spec.mjs` with `--repeat-each=5` in WebKit
  and mobile-WebKit.
- **Local** in the pinned Linux Playwright image under podman (4 CPUs,
  3.7 GB VM), `offline-update.spec.mjs` with `--repeat-each=5` at each of
  `--cpus` 1, 2, 4 (two workers), plus about 43 single runs without a limit.

| where | failed test runs | cause |
| --- | ---: | --- |
| CI, Chromium + mobile-Chromium | 11 of about 2750 | 1 |
| CI, WebKit + mobile-WebKit (`confirm.spec.mjs`) | 0 of 170 | – |
| podman, 1 CPU | 2 of 215 | 2 |
| podman, 2 CPUs | 0 of 215 | – |
| podman, 4 CPUs | 1 of 215 | 2 |
| podman, no limit | 2 in about 43 spec runs | 2 |

1. **A route handler outliving the test** (test bug). The workers fetch
   `precache.js` in the background; `serveNewVersion()`'s `context.route()`
   handler could still be in flight when the test ended and failed it
   ("route.fetch: Test ended", "Response has been disposed"), sometimes in
   the next test. In a normal CI run the retry would report it as flaky; the
   10-run sample above had none, so without `--repeat-each` it is rarer.
   Fixed on `main` (3f4967d: the routes are dropped after each test with
   `unrouteAll({ behavior: 'ignoreErrors' })`): 0 failures in 1720 Chromium
   test runs on CI afterwards.
2. **An Update click lost to a newer install** (app race, #41). Seen locally
   only, more often under load. The click posts `skipWaiting` to the waiting
   worker; its activation waits until the old worker has served the second
   tab's page load; meanwhile another install (started by that tab's
   `register('sw.js')`) replaces it, so nothing activates and the page never
   reloads. Temporary logging of every worker state change showed this in all
   5 failures of 40 runs at 1 CPU. The Mac's four "an update from another
   tab" failures at two workers show the same symptom (the other tab never
   reloads). Fix and a deterministic test in #41.

The local WebKit `confirm.spec.mjs` timeouts are covered in "Follow-up: the
WebKit `confirm.spec.mjs` timeouts" below.

## Baseline, CI (2026-10-13, commit e534645)

Fixed commit e534645 (`main` with #41 and #44, the large-backup and ADIF
loading tests included), pinned as branch `bench/36-ci-e534645` and run ten
times one after another with `workflow_dispatch` (every check: all five browser
projects, the ADIF cross-checks with `ADIF_CROSSCHECK=require` in `test`, the
data tests with `DATA_TESTS=require` in `bundle`). Runs 38315097585 to
38320411862, all successful. GitHub-hosted `ubuntu-latest` (image
ubuntu-24.04, version 20261004.327.1; 4 vCPU AMD EPYC, 16 GB, seen in the
earlier throwaway workflow). Raw:
`tests/timing-results/2026-10-13/ci-e534645/ci-runs.json`, from
`node scripts/bench_tests.mjs ci-runs --runs 10 --branch bench/36-ci-e534645 --event workflow_dispatch`.

| per run | median | range |
| --- | ---: | ---: |
| wall time, run start to the last job's end | 352 s | 333–390 s |
| queue time of a job (the run itself starts at once) | 2 s | 1–3 s |
| runner time, all jobs | 1206 s (20 min) | 1167–1308 s |
| billed minutes (each job rounded up) | 25 | 23–28 |

| job | start | end | duration |
| --- | ---: | ---: | ---: |
| changes | 3 s | 9 s | 6 s |
| test (unit tests, Go cross-check tools) | 10 s | 60 s | 49 s |
| bundle (build, unit tests with the data) | 10 s | 82 s | 70 s |
| validate (chromium) | 84 s | 352 s | 280 s |
| validate (mobile-chromium) | 85 s | 348 s | 281 s |
| validate (webkit) | 85 s | 274 s | 189 s |
| validate (mobile-webkit) | 85 s | 268 s | 184 s |
| validate (firefox) | 84 s | 259 s | 180 s |

Starts and ends are medians from the run start. Within the jobs:

| step | median | range |
| --- | ---: | ---: |
| `test`: unit tests (645, 9 skipped: the data tests) | 28 s | 23–49 s |
| `test`: set up Go; build the cross-check tools (cached) | 12 s; 0 s | 8–14 s; 0–1 s |
| `bundle`: build | 9 s | 7–11 s |
| `bundle`: unit tests with the data (645, 80 skipped: the cross-checks) | 37 s | 25–51 s |
| `validate`: Playwright image pull (each project) | 25 s | 23–36 s |
| `validate`: `npm install` of `@playwright/test` | 2 s | 2 s |
| `validate`: tests, chromium / mobile-chromium | 231 / 235 s | 168–251 s |
| `validate`: tests, webkit / mobile-webkit / firefox | 146 / 144 / 139 s | 98–152 s |
| `validate (chromium)`: Nu Html Checker | 10 s | 8–12 s |

Critical path: `changes`, then `bundle` (ends at about 82 s), then
`validate (chromium)` (ended last in 7 runs) or `validate (mobile-chromium)`
(3 runs). `test` runs beside `bundle` and gives the first result (unit tests
and cross-checks) after about 60 s. Reliability: no failed and no flaky test
(one retry per test in CI) in the 10 runs × 5 projects.

**The three largest contributors:**

1. **The Chromium-engine browser tests** (chromium, mobile-chromium: about
   230 s of tests each). They are the critical path after `bundle`; together
   with the other three projects the browser tests are about 900 s of the
   1206 runner seconds of a run.
2. **The unit suite repeated in `bundle`** (37 s, on the critical path before
   any browser job can start). It repeats the 556 tests `test` has already
   run and adds the 9 data tests that `test` skips (part 3: whether some of
   the repeated tests check something else once the data is there).
3. **Setup per browser job**: pulling the Playwright image (25 s × 5 = about
   2 min of runner time per run, 11 %), plus `npm install` and the Nu Html
   Checker; small per job, but paid in each of the five.

## Local, second machine (2026-10-13, commit 6797d77)

Not the development machine of the 2026-10-12 results: this session ran on
an Apple M1 Max (10 CPUs, 64 GiB, macOS 27.0.0) with **Node v26.11.1** (only
Node 26 is installed there; `.nvmrc` and CI use 24.21.0), and the machine was
busy (load average 3.5–12 at the starts). So these numbers are **not
comparable** with the 2026-10-12 table; they show the suite on slower, busier
hardware and that the browser runs no longer fail. Raw:
`tests/timing-results/2026-10-13/local-m1-node26/`.

| scenario (5 runs each) | median | range |
| --- | ---: | ---: |
| unit, concurrency 1 | 45.1 s | 44.8–45.9 s |
| unit, concurrency 2 | 24.0 s | 23.8–24.1 s |
| unit, concurrency 4 | 20.8 s | 20.6–21.2 s |
| unit, concurrency default | 20.6 s | 20.5–20.9 s |
| unit, `backup-parts.test.mjs` alone (1 run) | 19.8 s, 2.2 GiB | – |
| unit, focused `storage.test.mjs` | 0.40 s | 0.39–0.40 s |
| chromium, 1 worker (134 tests) | 169.7 s | 168.4–171.7 s |
| chromium, 2 workers | 91.1 s | 91.1–92.1 s |
| chromium, 4 workers | 76.4 s | 76.0–76.9 s |
| mobile-chromium, 2 workers | 98.2 s | 97.3–98.7 s |
| webkit, 2 workers (79 passed, 55 skipped) | 55.5 s | 54.4–55.8 s |
| mobile-webkit, 2 workers (78 passed, 56 skipped) | 53.2 s | 52.7–53.6 s |

0 failed runs in these 35 (no retries). The same scenarios on e534645, before
#45 (`before-45/`): webkit failed 3 of 5 runs and chromium at 4 workers 1 of
5 (the header jump, see "Follow-up: the WebKit `confirm.spec.mjs` timeouts").
Firefox does not start from this session on macOS 27 and is not measured.

### The same machine with Node 24 (2026-10-13, commit ead6326)

Node 24.21.0 (`brew install node@24`, as in `.nvmrc`) on the same M1 Max,
again under load (load average 3–9). Raw:
`tests/timing-results/2026-10-13/local-m1-node24/`.

| scenario (5 runs each) | median | range |
| --- | ---: | ---: |
| unit, concurrency 1 | 49.1 s | 48.9–49.4 s |
| unit, concurrency default | 28.2 s | 28.1–28.4 s |
| unit, `backup-parts.test.mjs` alone (1 run) | 27.6 s, 2.3 GiB | – |
| unit, focused `storage.test.mjs` | 0.26 s | 0.26–0.27 s |
| chromium, 1 / 2 / 4 workers | 170.8 / 91.4 / 76.5 s | within ±1 s each |
| mobile-chromium, 2 workers | 98.2 s | 97.7–98.7 s, one failed run of 1079 s |
| webkit, 2 workers | 75.0 s | 56.6–95.6 s |
| mobile-webkit, 2 workers | 111.6 s | 92.9–119.6 s, one failed run |

Two failed runs out of 30 (no retries): `notfunk.spec.mjs` "search, filter
and a status step keep the rows of unchanged messages" in both (mobile-chromium:
60 s timeout; mobile-webkit: "Clicking the checkbox did not change its
state"), plus `offline-update.spec.mjs` "a missing manifest (404)…" timing out
in the mobile-chromium run that took 1079 s. **The Mac was asleep then**
(`pmset -g log`): maintenance sleep from 10:32:45 to 10:49:04 local time,
inside that run (98 s + 979 s), and only DarkWake afterwards (display off,
processes throttled) until 19:03, when the webkit and mobile-webkit series
ran (hence their 56–120 s against 53 s). The unit and chromium series ran
before, awake. The notfunk test alone, 20 repeats each in mobile-webkit and
mobile-chromium at four workers with eight extra busy loops, awake: 40 of 40
passed. So no test or app bug is shown; the browser rows of this series are
not usable.

**This machine drifts too much for a baseline.** `backup-parts.test.mjs` run
alternately with both versions (`backup-parts-node24-vs-26.txt`, after the
series, possibly in DarkWake too): Node 26 25.8–28.0 s, Node 24 27.5–40.3 s
(median 37.6 s), at similar load; but the same file took 19.8 s under Node 26
before. So the local baseline belongs on an idle, awake, fixed machine; Node
26 was not slower than 24 on the heaviest unit file in any pair (a candidate
next to Bun in part 5, to be measured properly).

## Baseline, still to do

- [x] fixed commit, with the large-backup and ADIF loading tests (e534645)
- [x] CI: ten comparable runs; queue time, critical path, runner minutes
- [x] the three largest contributors to elapsed time and runner cost (CI)
- [ ] local on the development machine (Node 24), idle, five warm
      repetitions per scenario, on one fixed commit; Firefox
- [ ] local cold setup runs (package cache, generated data, container images)

### Local WebKit against nginx (server experiment)

The local failures could have come from `tests/e2e/serve.py` (a threaded
`http.server`). Same machine, same bundle, same flags, but the pinned nginx
image with `deploy/nginx.conf.example` (podman, port 8080, as CI serves it;
`--base-url` of `scripts/bench_tests.mjs`), 10 runs each at two workers:

| project | server | failed runs | passing-run median |
| --- | --- | ---: | ---: |
| webkit | serve.py (5 runs) | 1 | 46 s |
| webkit | nginx (10 runs) | 2 | 48 s |
| mobile-webkit | serve.py (5 runs) | 3 | 45 s |
| mobile-webkit | nginx (10 runs) | 3 | 48 s |

The failure rate did not change (3 of 15 against 4 of 15), so `serve.py` is
not the cause, at least not the only one. The failing tests are all in
`confirm.spec.mjs`, again different ones from run to run (split-export import,
split export beyond the limits, a malformed backup, a note beyond the per-file
limit, "logs a check-in and exports CSV and ADIF"), as a 60 s timeout or a
`toContainText` that never matched; several involve multi-file downloads.
Still open: the engine on this macOS machine, machine load, or a real
race that CI's slower runners (and its one retry) happen to hide. CI ran
these projects 5 times each without a failure; at a 25% rate that happens
about one time in four (0.75^5), so five runs cannot show whether CI has the
same problem at a lower or equal rate.

### Follow-up: the WebKit `confirm.spec.mjs` timeouts

Rerun in the pinned Linux image under podman (WebKit, two workers, retries
off), so the macOS engine is not needed to show them:

| `--cpus` | repeats | failed test runs |
| --- | ---: | ---: |
| 1 | 10 | 2 of 170 |
| 2 | 10 + 3 | 1 of 221 |
| 4 | 10 | 2 of 170 |

Again different tests each time, all 60 s timeouts. Two causes:

1. **A false update offer on the first visit** (app bug). In most failures the
   test hung in `openNewLog()`: the form of "+ Neues Log" never opened.
   Temporary logging showed the pointerdown on the button but the click on
   `BODY`: between WebKit's mousedown and mouseup (up to 1.5 s apart at 1 CPU)
   the button had moved down 33.5 px. "Update verfügbar" had appeared and
   wrapped the header to a second row. On the first install WebKit may already
   report the claiming worker as `navigator.serviceWorker.controller` when that
   worker's `installed` statechange arrives, while it is still `reg.waiting`;
   `offerUpdate()` took that for an update and the button stayed. At 1 CPU
   this happened in 177 of about 250 `openNewLog()` calls, so most runs only
   missed the click by luck. Fix: an update is offered only beside an active
   worker; a Chromium test makes `controller` report the waiting worker early
   (fails 10 of 10 without the fix). Afterwards: 0 of 255 at 1 CPU.
2. **A second page that stops rendering** (not explained yet). "a note beyond
   the per-file limit is chunked…" failed 2 of 170 times at 2 CPUs after the
   fix, in the click on the imported log in its second browser context
   (`confirm.spec.mjs`, "waiting for element to be visible, enabled and
   stable"): that page's screencast had stopped after the import, so its
   animation frames, which the stability check needs, presumably stopped too.
   Not seen in 30 runs of the test alone nor in a further 204 test runs of the
   whole file with a probe for it (`requestAnimationFrame`, visibility, focus,
   `bringToFront()`) in place. Open until it can be caught with the probe.

