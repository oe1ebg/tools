// JUnit XML reporter for `node --test`, for the test report in CI
// (docker-publish-oe1ebg.yml, job `test`):
//
//   node --test --test-reporter=./tests/junit-reporter.mjs \
//     --test-reporter-destination=tests/reports/node.xml 'tests/*.test.mjs'
//
// Node's built-in junit reporter puts every test straight under
// <testsuites>, all with classname "test". Here each test file is one
// <testsuite> (named by its path), nested tests (t.test, describe) become
// "parent › child" cases, and diagnostics (t.diagnostic) go to the suite's
// <system-out>.
import { relative } from 'node:path';
import { inspect } from 'node:util';

const esc = s => String(s)
  // characters XML 1.0 does not allow at all
  .replace(/[^\x09\x0a\x0d\x20-퟿-�\u{10000}-\u{10ffff}]/gu, '�')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function testCase(data, failed) {
  const c = { name: data.name, time: (data.details?.duration_ms ?? 0) / 1000 };
  if (data.skip !== undefined || data.todo !== undefined) {
    const why = data.skip ?? data.todo;
    c.skipped = typeof why === 'string' ? why : (data.skip !== undefined ? 'skipped' : 'todo');
  }
  if (failed) {
    const err = data.details?.error;
    const cause = err?.cause ?? err;
    // the attribute gets the first line, the body the whole error (with diff)
    const message = String(cause?.message ?? cause).split('\n')[0];
    c.failure = { type: cause?.name ?? 'Error', message, body: inspect(cause, { depth: 4 }) };
  }
  return c;
}

export default async function* junitReporter(source) {
  const files = new Map();
  const fileOf = file => {
    if (!files.has(file)) files.set(file, { cases: [], levels: [], out: [] });
    return files.get(file);
  };
  for await (const { type, data } of source) {
    if (type === 'test:diagnostic' && data.file) fileOf(data.file).out.push(data.message);
    if ((type !== 'test:pass' && type !== 'test:fail') || !data.file) continue;
    // A test's subtests finish (and are reported) before it, one level deeper.
    const f = fileOf(data.file);
    const n = data.nesting;
    const kids = f.levels[n + 1] ?? [];
    f.levels[n + 1] = [];
    const failed = type === 'test:fail';
    const cases = kids.map(k => ({ ...k, name: `${data.name} › ${k.name}` }));
    // a parent counts only when it failed by itself (a hook, its own code)
    if (!kids.length || (failed && data.details?.error?.failureType !== 'subtestsFailed')) cases.push(testCase(data, failed));
    if (n === 0) f.cases.push(...cases);
    else (f.levels[n] ??= []).push(...cases);
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n';
  for (const [file, f] of files) {
    const name = relative(process.cwd(), file);
    const count = pred => f.cases.filter(pred).length;
    const time = f.cases.reduce((t, c) => t + c.time, 0);
    xml += `  <testsuite name="${esc(name)}" tests="${f.cases.length}" failures="${count(c => c.failure)}" errors="0"` +
      ` skipped="${count(c => c.skipped !== undefined && !c.failure)}" time="${time.toFixed(3)}">\n`;
    for (const c of f.cases) {
      xml += `    <testcase name="${esc(c.name)}" classname="${esc(name)}" file="${esc(name)}" time="${c.time.toFixed(3)}"`;
      if (c.failure) {
        xml += `>\n      <failure message="${esc(c.failure.message)}" type="${esc(c.failure.type)}">${esc(c.failure.body)}</failure>\n    </testcase>\n`;
      } else if (c.skipped !== undefined) {
        xml += `>\n      <skipped message="${esc(c.skipped)}"/>\n    </testcase>\n`;
      } else {
        xml += '/>\n';
      }
    }
    if (f.out.length) xml += `    <system-out>${esc(f.out.join('\n'))}</system-out>\n`;
    xml += '  </testsuite>\n';
  }
  yield `${xml}</testsuites>\n`;
}
