// Timing of the test workflows (issue #36): wall time, peak memory and
// pass/fail/skip counts of repeated runs, with the environment recorded.
// Not part of `just test` or CI; the results go in tests/test-timing.md.
//
//   node scripts/bench_tests.mjs unit [--runs 5] [--concurrency 1,2,4,default]
//   node scripts/bench_tests.mjs unit-files [--runs 1]      each file alone: its own wall time
//   node scripts/bench_tests.mjs unit-focused --file tests/storage.test.mjs [--runs 5]
//   node scripts/bench_tests.mjs e2e [--runs 5] [--project chromium] [--workers 1,2,4] [--grep text] [--base-url http://localhost:8080/]
//   node scripts/bench_tests.mjs ci-runs [--runs 10] [--branch B] [--event E]   jobs and steps of successful ci.yml runs (gh)
//   common: --out bench-tests.json (default; individual results are kept)
//
// Warm runs: 5 repetitions (the default); cold setup runs (3) are done by hand
// and recorded with the same --out, because "cold" must say what is absent
// (package cache, generated data, container images) and each needs its own
// preparation. Wall time is the run's elapsed time, not summed case
// durations. Peak memory is the largest resident set of any single process
// in the run (getrusage of the waited-for children), not the sum over the
// process tree. The e2e scenario needs `just e2e-setup` and a built site/
// (the same checks as `just e2e-run`) and serves it on its own free port
// (a leftover server on :8000 cannot answer).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, release, loadavg } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const scenario = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const OUT = opt('out', 'bench-tests.json');
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

function environment() {
  const dockerfile = readFileSync(join(ROOT, 'tests/e2e/images.Dockerfile'), 'utf8');
  const dataDir = join(ROOT, 'tools/shared/data');
  return {
    when: new Date().toISOString(),
    node: process.version,
    python: sh('python3', ['--version']),
    uv: sh('uv', ['--version']),
    os: `${platform()} ${release()}`,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model,
    memoryGiB: +(totalmem() / 2 ** 30).toFixed(1),
    // other load on the machine at the start (1, 5, 15 min): timings of a busy machine differ
    loadAvg: loadavg().map(x => +x.toFixed(2)),
    commit: sh('git', ['rev-parse', 'HEAD']),
    dirty: !!sh('git', ['status', '--porcelain', '--untracked-files=no']),
    playwrightImages: dockerfile.split('\n').filter(l => /^FROM .*@sha256:/.test(l)).map(l => l.split(' ')[1]),
    generatedData: existsSync(dataDir) ? readdirSync(dataDir).sort() : null,
    manifest: existsSync(join(ROOT, 'site/tools/manifest.json'))
      ? JSON.parse(readFileSync(join(ROOT, 'site/tools/manifest.json'), 'utf8')) : null,
  };
}

// Runs a command under /usr/bin/time for the peak memory; resolves with the
// wall time, exit status and peak RSS (MiB) of the largest process.
function timed(cmd, args, env = {}, cwd = ROOT) {
  const mac = platform() === 'darwin';
  const wrapper = existsSync('/usr/bin/time') ? ['/usr/bin/time', mac ? '-l' : '-v'] : [];
  return new Promise(resolve => {
    const t0 = performance.now();
    const p = spawn(wrapper[0] ?? cmd, [...wrapper.slice(1), ...(wrapper.length ? [cmd] : []), ...args],
      { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('close', status => {
      const wallMs = performance.now() - t0;
      const m = mac ? stderr.match(/(\d+)\s+maximum resident set size/) : stderr.match(/Maximum resident set size \(kbytes\): (\d+)/);
      const peakMiB = m ? +(Number(m[1]) / (mac ? 2 ** 20 : 1024)).toFixed(1) : null;
      resolve({ status, wallMs: Math.round(wallMs), peakMiB, stdout, stderr });
    });
  });
}

const freePort = () => new Promise(res => {
  const srv = createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
});

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
function summarize(runs) {
  const wall = runs.map(r => r.wallMs);
  const mem = runs.map(r => r.peakMiB).filter(x => x != null);
  return {
    runs: runs.length,
    wallMs: { median: median(wall), min: Math.min(...wall), max: Math.max(...wall) },
    peakMiB: mem.length ? { median: median(mem), min: Math.min(...mem), max: Math.max(...mem) } : null,
    failedRuns: runs.filter(r => r.status !== 0).length,
  };
}

// counts from the repo's JUnit reporter (tests/junit-reporter.mjs)
function junitCounts(xml) {
  const sum = attr => [...xml.matchAll(new RegExp(`<testsuite [^>]*\\b${attr}="(\\d+)"`, 'g'))].reduce((t, m) => t + Number(m[1]), 0);
  return { tests: sum('tests'), failures: sum('failures'), skipped: sum('skipped') };
}

function row(label, s, extra = '') {
  const w = s.wallMs;
  const mem = s.peakMiB ? `${s.peakMiB.median} MiB` : 'n/a';
  console.log(`${label.padEnd(26)} median ${(w.median / 1000).toFixed(2)} s  range ${(w.min / 1000).toFixed(2)}–${(w.max / 1000).toFixed(2)} s  peak ${mem}${s.failedRuns ? `  FAILED RUNS: ${s.failedRuns}` : ''}${extra}`);
}

async function repeat(n, once) {
  const runs = [];
  for (let i = 0; i < n; i++) runs.push(await once(i));
  return runs;
}

async function nodeTest(files, concurrency, dir) {
  const xml = join(dir, `node-${Math.random().toString(36).slice(2)}.xml`);
  const args = ['--test', '--test-reporter=./tests/junit-reporter.mjs', `--test-reporter-destination=${xml}`];
  if (concurrency && concurrency !== 'default') args.push(`--test-concurrency=${concurrency}`);
  const r = await timed('node', [...args, ...files]);
  // a run that left no report counts as failed whatever its exit status
  const report = existsSync(xml) ? readFileSync(xml, 'utf8') : null;
  r.counts = report ? junitCounts(report) : null;
  // which cases failed: a failing run's timing is not comparable, and the cause is lost otherwise
  r.failed = report ? [...report.matchAll(/<testcase name="([^"]*)" classname="([^"]*)"[^>]*>\s*<failure message="([^"]*)"/g)].map(m => `${m[2]}: ${m[1]} (${m[3]})`) : [];
  if (!r.counts && r.status === 0) r.status = 1;
  return r;
}

const testFiles = () => readdirSync(join(ROOT, 'tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `tests/${f}`);
const keep = r => ({
  wallMs: r.wallMs, peakMiB: r.peakMiB, status: r.status, counts: r.counts,
  // failed runs keep what failed and the end of the output
  ...(r.status !== 0 ? { failed: r.failed, outputTail: `${r.stdout}\n${r.stderr}`.slice(-4000) } : {}),
});
// The browser step of a validate job in phases, from its timestamped log:
// Playwright image pull, npm install, the tests (until Playwright's summary).
// Also the runner image of the job. Null phases where a marker is missing.
function browserPhases(jobId) {
  const log = sh('gh', ['api', '--allow-escape-sequences', `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`]);
  if (!log) return { phases: null };
  const lines = log.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
  const at = re => { const l = lines.find(x => re.test(x)); return l ? Date.parse(l.slice(0, 28)) : null; };
  const step = at(/##\[group\]Run docker run --rm --network host/);
  const pulled = at(/Status: (Downloaded newer|Image is up to date) .*playwright/);
  const installed = at(/added \d+ packages? in/);
  const running = at(/Running \d+ tests? using/);
  const done = at(/^\S+\s+\d+ (passed|failed|flaky)/);
  const d = (a, b) => (a && b ? Math.round((b - a) / 1000) : null);
  return {
    runnerImage: lines.find(x => /\bImage: /.test(x))?.split('Image: ')[1]?.trim() ?? null,
    runnerImageVersion: lines.find((x, i) => i > 0 && /\bVersion: /.test(x) && /\bImage: /.test(lines[i - 1]))?.split('Version: ')[1]?.trim() ?? null,
    phases: { pullS: d(step, pulled), npmS: d(pulled, installed), startS: d(installed, running), testsS: d(running, done) },
  };
}

const results = { scenario, environment: environment(), measurements: [] };
const dir = mkdtempSync(join(tmpdir(), 'bench-tests-'));
const runsN = Number(opt('runs', scenario === 'unit-files' ? 1 : scenario === 'ci-runs' ? 10 : 5));

try {
  if (scenario === 'unit') {
    for (const c of opt('concurrency', '1,2,4,default').split(',')) {
      const runs = await repeat(runsN, () => nodeTest(testFiles(), c, dir));
      const s = { concurrency: c, ...summarize(runs), results: runs.map(keep) };
      results.measurements.push(s);
      row(`unit, concurrency ${c}`, s, `  ${runs[0].counts ? `${runs[0].counts.tests} tests, ${runs[0].counts.skipped} skipped` : 'no report'}`);
    }
  } else if (scenario === 'unit-files') {
    // each file in its own process: wall time per file (files overlap in `unit`)
    for (const f of testFiles()) {
      const runs = await repeat(runsN, () => nodeTest([f], 1, dir));
      const s = { file: f, ...summarize(runs), results: runs.map(keep) };
      results.measurements.push(s);
    }
    results.measurements.sort((a, b) => b.wallMs.median - a.wallMs.median);
    for (const s of results.measurements.slice(0, 15)) row(s.file, s, `  ${s.results[0].counts?.tests ?? '?'} tests`);
  } else if (scenario === 'unit-focused') {
    const file = opt('file');
    if (!file) throw new Error('unit-focused needs --file tests/<name>.test.mjs');
    const runs = await repeat(runsN, () => nodeTest([file], 1, dir));
    const s = { file, ...summarize(runs), results: runs.map(keep) };
    results.measurements.push(s);
    row(`focused ${file}`, s);
  } else if (scenario === 'e2e') {
    const e2e = join(ROOT, 'tests/e2e');
    const version = sh('sed', ['-nE', 's#^FROM mcr\\.microsoft\\.com/playwright:v([0-9]+\\.[0-9]+\\.[0-9]+)-.*#\\1#p', 'tests/e2e/images.Dockerfile']);
    const check = spawnSync('node', ['check-playwright.mjs', '--local'], { cwd: e2e, env: { ...process.env, PW_VERSION: version }, encoding: 'utf8' });
    if (check.status !== 0 || !existsSync(join(ROOT, 'site/tools/index.html'))) {
      throw new Error(`run \`just e2e-setup\` and \`just build\` first (${check.stderr.trim() || 'site/tools/ missing'})`);
    }
    // own server on a free port: nothing left over on :8000 can answer
    // --base-url: an already running server (e.g. nginx with deploy/nginx.conf.example, as in CI)
    const external = opt('base-url');
    const port = external ? null : await freePort();
    const base = external ?? `http://127.0.0.1:${port}/`;
    const server = external ? null : spawn('python3', ['tests/e2e/serve.py', 'site', String(port)], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; ; i++) {
      if ((await fetch(`${base}tools/manifest.json`).catch(() => null))?.ok) break;
      if (i >= 50) { server?.kill(); throw new Error(`no server at ${base}`); }
      await new Promise(r => setTimeout(r, 100));
    }
    results.server = external ? `external ${base}` : 'tests/e2e/serve.py';
    try {
      for (const w of opt('workers', '1,2,4').split(',')) {
        const args = ['playwright', 'test', `--workers=${w}`, '--reporter=json'];
        if (opt('project')) args.push(`--project=${opt('project')}`);
        if (opt('grep')) args.push('--grep', opt('grep'));
        const runs = await repeat(runsN, async () => {
          const r = await timed('npx', args, { BASE_URL: base, CI: '' }, e2e);
          try {
            const report = JSON.parse(r.stdout);
            const stats = report.stats;
            // failing specs: file, title, first line of the error, for a run that did not pass
            r.failed = [];
            const walk = suite => {
              for (const spec of suite.specs ?? []) {
                if (spec.ok) continue;
                const err = spec.tests?.flatMap(t => t.results ?? []).find(x => x.error)?.error?.message ?? '';
                r.failed.push(`${suite.file ?? spec.file}: ${spec.title} (${err.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0]})`);
              }
              for (const child of suite.suites ?? []) walk(child);
            };
            for (const suite of report.suites ?? []) walk(suite);
            r.counts = { expected: stats.expected, unexpected: stats.unexpected, flaky: stats.flaky, skipped: stats.skipped, durationMs: Math.round(stats.duration) };
          } catch { r.counts = null; if (r.status === 0) r.status = 1; }
          return r;
        });
        const s = { workers: Number(w), project: opt('project', 'all'), ...summarize(runs), results: runs.map(keep) };
        results.measurements.push(s);
        row(`e2e, ${s.project}, ${w} workers`, s, `  ${runs[0].counts ? `${runs[0].counts.expected} passed, ${runs[0].counts.skipped} skipped, ${runs[0].counts.flaky} flaky` : 'no report'}`);
      }
    } finally {
      server?.kill();
    }
  } else if (scenario === 'ci-runs') {
    // --branch / --event: comparable runs only (e.g. workflow_dispatch on a pinned branch)
    const filter = [...(opt('branch') ? ['--branch', opt('branch')] : []), ...(opt('event') ? ['--event', opt('event')] : [])];
    const list = sh('gh', ['run', 'list', '--workflow', 'ci.yml', '--status', 'success', ...filter, '--limit', String(runsN), '--json', 'databaseId,headSha,event']);
    if (!list) throw new Error('gh run list failed (is gh installed and authenticated?)');
    // the API answers 502 now and then: retry, and stop rather than record an empty run
    const api = path => {
      for (let i = 0; i < 3; i++) {
        const out = sh('gh', ['api', '--paginate', '--slurp', path]);
        if (out) return JSON.parse(out);
        spawnSync('sleep', [String(5 * (i + 1))]);
      }
      throw new Error(`gh api ${path} failed three times`);
    };
    const secs = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 1000);
    const steps = new Map();
    const jobTimes = new Map();
    for (const run of JSON.parse(list)) {
      const info = api(`repos/{owner}/{repo}/actions/runs/${run.databaseId}`)[0];
      const jobs = api(`repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs`).flatMap(p => p.jobs)
        .filter(j => j.started_at && j.completed_at && j.conclusion !== 'skipped');
      const start = info.run_started_at;
      const end = jobs.reduce((t, j) => (j.completed_at > t ? j.completed_at : t), start);
      for (const j of jobs) {
        if (!jobTimes.has(j.name)) jobTimes.set(j.name, []);
        jobTimes.get(j.name).push(secs(j.started_at, j.completed_at));
        for (const st of j.steps ?? []) {
          if (!st.started_at || !st.completed_at || st.conclusion !== 'success') continue;
          const key = `${j.name} / ${st.name}`;
          if (!steps.has(key)) steps.set(key, []);
          steps.get(key).push(secs(st.started_at, st.completed_at));
        }
      }
      const last = jobs.reduce((a, j) => (!a || j.completed_at > a.completed_at ? j : a), null);
      results.measurements.push({
        run: run.databaseId, sha: run.headSha, event: run.event,
        // queued: created until the run started; wall: run start until the last job ended
        queueS: secs(info.created_at, start),
        wallS: secs(start, end),
        // the job that ended last ends the critical path; its start shows what it waited for
        lastJob: last && { name: last.name, startS: secs(start, last.started_at), endS: secs(start, last.completed_at) },
        // runner minutes: job durations summed (GitHub bills each job rounded up to a minute)
        runnerS: jobs.reduce((t, j) => t + secs(j.started_at, j.completed_at), 0),
        billedMin: jobs.reduce((t, j) => t + Math.ceil(secs(j.started_at, j.completed_at) / 60), 0),
        jobs: jobs.map(j => ({
          name: j.name, runner: j.runner_name, labels: j.labels,
          queueS: secs(j.created_at, j.started_at), startS: secs(start, j.started_at), endS: secs(start, j.completed_at),
          ...(j.name.startsWith('validate') ? browserPhases(j.id) : {}),
        })),
      });
    }
    // descriptive only: small sample, steps present in some runs only
    const stats = ([name, xs]) => ({ name, n: xs.length, medianS: median(xs), minS: Math.min(...xs), maxS: Math.max(...xs), values: xs });
    results.steps = [...steps].map(stats).sort((a, b) => b.medianS - a.medianS);
    results.jobs = [...jobTimes].map(stats).sort((a, b) => b.medianS - a.medianS);
    const m = results.measurements;
    const desc = k => { const xs = m.map(x => x[k]); return `median ${median(xs)}, range ${Math.min(...xs)}–${Math.max(...xs)}`; };
    console.log(`${m.length} runs; queue s ${desc('queueS')}; wall s ${desc('wallS')}; runner s ${desc('runnerS')}; billed min ${desc('billedMin')}`);
    for (const s of results.jobs) console.log(`job ${s.name.padEnd(40)} n=${s.n} median ${s.medianS} s  range ${s.minS}–${s.maxS} s`);
    for (const s of results.steps.slice(0, 20)) console.log(`${s.name.padEnd(70)} n=${s.n} median ${s.medianS} s  range ${s.minS}–${s.maxS} s`);
  } else {
    console.error('usage: bench_tests.mjs unit | unit-files | unit-focused --file F | e2e | ci-runs  (see the header)');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`bench_tests: ${err.message}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// timings of failing runs are not comparable: say so in the exit status
if (results.measurements.some(m => m.failedRuns)) process.exitCode = 1;

if (results.measurements.length) {
  writeFileSync(resolve(ROOT, OUT), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nwrote ${OUT} (${results.measurements.length} measurements; individual results kept)`);
}
