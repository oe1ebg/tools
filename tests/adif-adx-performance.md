# ADI/ADX browser measurements

Node v26.11.1, macOS Apple silicon; five sequential fresh-context runs per workload/engine. File:// bundles with networking unavailable. Times include browser automation and the 150 ms edit debounce. Raw results are in `timing-results/adif-adx/`; measurements are descriptive, not CI thresholds.

Baseline: specification-only branch (`e4eba11`), ADI only. Current: the ADX implementation on the statistics stack, before the final advisory-submode/frequency classification corrections (these do not change these workloads). Bundle hashes identify the measured files.

| Engine | Log | Format | Import ms | Edit/recheck ms | Export ms | Max timer delay ms | Sampled RSS MiB |
|---|---|---|---:|---:|---:|---:|---:|
| chromium | baseline official | ADI | 336 | 287 | 100 | 71 | 462 |
| chromium | baseline 50k | ADI | 964 | 585 | 133 | 340 | 639 |
| firefox | baseline official | ADI | 287 | 302 | 92 | 53 | 1228 |
| firefox | baseline 50k | ADI | 849 | 750 | 163 | 104 | 1496 |
| webkit | baseline official | ADI | 345 | 264 | 101 | 127 | 138 |
| webkit | baseline 50k | ADI | 858 | 616 | 170 | 107 | 175 |
| chromium | current official | ADI | 336 | 289 | 229 | 66 | 482 |
| chromium | current official | ADX | 535 | 195 | 230 | 103 | 547 |
| chromium | current 50k | ADI | 984 | 565 | 591 | 341 | 658 |
| chromium | current 50k | ADX | 2207 | 292 | 641 | 518 | 922 |
| firefox | current official | ADI | 286 | 303 | 227 | 52 | 1239 |
| firefox | current official | ADX | 382 | 241 | 222 | 61 | 1357 |
| firefox | current 50k | ADI | 863 | 722 | 692 | 98 | 1517 |
| firefox | current 50k | ADX | 1258 | 326 | 457 | 241 | 1980 |
| webkit | current official | ADI | 282 | 255 | 235 | 93 | 140 |
| webkit | current official | ADX | 356 | 211 | 219 | 103 | 177 |
| webkit | current 50k | ADI | 660 | 491 | 414 | 82 | 176 |
| webkit | current 50k | ADX | 1182 | 261 | 337 | 256 | 198 |

The official fixture has 6,202 rows; the synthetic log has 50,000 rows and seven fields (CALL, QSO_DATE, TIME_ON, BAND, MODE, FREQ, DXCC). Synthetic input sizes are 5.04 MB ADI and 7.69 MB ADX.

ADI import/edit performance stays comparable. Exports now spend an additional 130–530 ms on copies, explicit preflight and selected-output validation; these run in cancellable slices and report progress rather than blocking input for the complete job. The time is an intentional cost of checking the selected export before downloading.

ADX import uses more time/memory because native XML parsing materializes a DOM; 50,000-row imports take about 1.2–2.2 s versus 0.7–1.0 s for ADI. The largest whole-flow timer delay is about 0.52 s in Chromium ADX versus 0.34 s for ADI; native parsing cannot be interrupted. Traversal/validation/conversion remain sliced. Direct ADX edit checks are faster than serializing/reparsing ADI.

RSS is the summed process-tree residency, not physical memory or JavaScript heap; shared pages can be counted more than once, especially Firefox, and OS-reparented helpers may be omitted, especially on macOS. These measurements do not prove safety at the 50 MiB maximum. The limit is unchanged and that limitation is documented.

Reproduce (after `just build` / `just e2e-setup`):

```sh
node scripts/bench_adx.mjs --engine chromium,firefox,webkit --runs 5 --out /private/tmp/adx-current.json
node scripts/bench_adx.mjs --engine chromium,firefox,webkit --runs 5 --adi-only --bundle /path/to/spec-only/adif-editor.html --out /private/tmp/adx-baseline.json
```
