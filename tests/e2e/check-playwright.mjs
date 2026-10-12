// Run inside the Playwright image after installing @playwright/test (CI job
// `validate`, `just e2e-docker`): the package must be exactly PW_VERSION,
// the version of the image tag in images.Dockerfile, and the image must hold
// the browser builds that version drives. A mismatch otherwise surfaces
// later as a confusing "Executable doesn't exist" per test.
//
// `--local` (`just e2e-run`): only the package versions are checked; the
// browser builds live in the user's own cache (`just e2e-setup` installs
// them) and Node is the developer's.
import { existsSync, readFileSync } from 'node:fs';

const local = process.argv.includes('--local');
const want = process.env.PW_VERSION;
const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const problems = [];
let have, core;
try {
  have = read('./node_modules/@playwright/test/package.json').version;
  core = read('./node_modules/playwright-core/package.json').version;
} catch {
  console.error('::error::Playwright is not installed in tests/e2e/node_modules (run `just e2e-setup`)');
  process.exit(1);
}
if (!want) problems.push('PW_VERSION is not set');
if (have !== want) problems.push(`@playwright/test is ${have}, the image is ${want}`);
if (core !== want) problems.push(`playwright-core is ${core}, the image is ${want}`);

const needed = ['chromium', 'chromium-headless-shell', 'firefox', 'webkit'];
for (const b of local ? [] : read('./node_modules/playwright-core/browsers.json').browsers) {
  if (!needed.includes(b.name)) continue;
  const dir = `${browsersDir}/${b.name.replaceAll('-', '_')}-${b.revision}`;
  if (!existsSync(dir)) problems.push(`the image has no ${dir} (${b.name} ${b.browserVersion})`);
  else console.log(`ok: ${b.name} ${b.browserVersion} (${dir})`);
}

// The image brings its own Node; it should be the major of .nvmrc
// (the one the unit tests and local work use). A warning: Playwright moves
// its images to a new Node line on its own schedule.
const nvmrc = readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8').trim();
const major = v => v.replace(/^v/, '').split('.')[0];
if (local) {
  // developer's own Node: not compared
} else if (major(process.version) !== major(nvmrc)) {
  console.log(`::warning::Playwright image runs Node ${process.version}, .nvmrc says ${nvmrc}`);
} else {
  console.log(`ok: Node ${process.version} (.nvmrc ${nvmrc})`);
}

if (problems.length) {
  for (const p of problems) console.error(`::error::Playwright version check: ${p}`);
  process.exit(1);
}
console.log(`ok: @playwright/test ${have} matches the image`);
