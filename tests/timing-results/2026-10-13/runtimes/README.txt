Runtimes, 2026-10-13, Apple M1 Max (10 CPUs), tests of commit 903770d.
node24-vs-node26.txt: alternating Node 24.21.0 / 26.11.1, wall seconds of
  `node --test tests/*.test.mjs` and of `node --test tests/backup-parts.test.mjs`.
bun-unchanged.txt: `bun test ./tests/*.test.mjs` with Bun 1.4.2, nothing adapted.
bun-parallel.txt: `bun test --parallel --timeout 120000 ./tests/*.test.mjs`.
Wall times of Bun (3 runs each, alternating with Node 26):
  sequential, --timeout 120000: 28.3, 29.3, 28.1 s (Node 26: 21.1, 21.4, 20.6 s)
  --parallel --timeout 120000: 10.4, 10.4, 10.4 s (Node 26: 20.7, 20.6, 20.3 s)
  backup-parts.test.mjs alone: 9.4 s; peak RSS 4.8 GB (Node 26: 2.3 GB)
