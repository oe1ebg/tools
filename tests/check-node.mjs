// Is .nvmrc the newest release of the newest LTS line? Run in CI
// (docker-publish-oe1ebg.yml, job `test`) and by hand: `node tests/check-node.mjs`.
// Prints a GitHub warning annotation when it is behind (no failure: a new
// Node release must not block a deploy) and when this Node is not the one
// .nvmrc names. Dependabot does not update .nvmrc; bump it on a warning.
import { readFileSync } from 'node:fs';

const nvmrc = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim().replace(/^v/, '');
const warn = msg => console.log(`${process.env.GITHUB_ACTIONS ? '::warning file=.nvmrc::' : 'warning: '}${msg}`);

if (process.version !== `v${nvmrc}`) warn(`running Node ${process.version}, but .nvmrc says ${nvmrc}`);

let releases;
try {
  const res = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  releases = await res.json();
} catch (err) {
  warn(`cannot check for a newer Node LTS: ${err.message}`);
  process.exit(0);
}
// index.json is newest first; lts is the line's name or false
const latest = releases.find(r => r.lts);
const want = latest.version.replace(/^v/, '');
if (want !== nvmrc) warn(`.nvmrc is ${nvmrc}, the newest LTS is ${want} (${latest.lts}, ${latest.date})`);
else console.log(`ok: .nvmrc ${nvmrc} is the newest LTS (${latest.lts})`);
