# ADI/ADX browser measurements

Node v26.11.1, macOS Apple silicon; five sequential fresh-context runs per workload/engine. File:// bundles with networking unavailable. Times include browser automation and the 150 ms edit debounce. Raw results are in `timing-results/adif-adx/`; measurements are descriptive, not CI thresholds.

Baseline: specification-only branch (`e4eba11`), ADI only. Current: the verified staged bundle of `6e8aa46`, after the preservation regressions and restacking onto `136502f`. No builds or browser tests ran during measurement. Bundle hashes identify the measured files.

| Engine | Log | Format | Import ms | Edit/recheck ms | Export ms | Max timer delay ms | Sampled RSS MiB |
|---|---|---|---:|---:|---:|---:|---:|
| chromium | baseline official | ADI | 336 | 287 | 100 | 71 | 462 |
| chromium | baseline 50k | ADI | 964 | 585 | 133 | 340 | 639 |
| firefox | baseline official | ADI | 287 | 302 | 92 | 53 | 1228 |
| firefox | baseline 50k | ADI | 849 | 750 | 163 | 104 | 1496 |
| webkit | baseline official | ADI | 345 | 264 | 101 | 127 | 138 |
| webkit | baseline 50k | ADI | 858 | 616 | 170 | 107 | 175 |
| chromium | current official | ADI | 255 | 266 | 164 | 48 | 474 |
| chromium | current official | ADX | 432 | 195 | 201 | 79 | 548 |
| chromium | current 50k | ADI | 773 | 477 | 472 | 264 | 639 |
| chromium | current 50k | ADX | 1747 | 273 | 549 | 412 | 928 |
| firefox | current official | ADI | 262 | 273 | 202 | 54 | 1224 |
| firefox | current official | ADX | 332 | 202 | 197 | 50 | 1360 |
| firefox | current 50k | ADI | 733 | 620 | 583 | 73 | 1530 |
| firefox | current 50k | ADX | 1343 | 308 | 447 | 254 | 1980 |
| webkit | current official | ADI | 268 | 250 | 202 | 88 | 140 |
| webkit | current official | ADX | 333 | 198 | 203 | 91 | 177 |
| webkit | current 50k | ADI | 650 | 465 | 449 | 91 | 177 |
| webkit | current 50k | ADX | 1139 | 280 | 319 | 251 | 208 |

The official fixture has 6,202 rows; the synthetic log has 50,000 rows and seven fields (CALL, QSO_DATE, TIME_ON, BAND, MODE, FREQ, DXCC). Synthetic input sizes are 5.04 MB ADI and 7.69 MB ADX.

ADI import/edit performance stays comparable. Exports now spend an additional 130–530 ms on copies, explicit preflight and selected-output validation; these run in cancellable slices and report progress rather than blocking input for the complete job. The time is an intentional cost of checking the selected export before downloading.

ADX import uses more time/memory because native XML parsing materializes a DOM; 50,000-row imports take about 1.1–2.2 s versus 0.7–1.0 s for ADI. The largest whole-flow timer delay is about 0.52 s in Chromium ADX versus 0.34 s for ADI; native parsing cannot be interrupted. Traversal/validation/conversion remain sliced. Direct ADX edit checks are faster than serializing/reparsing ADI.

RSS is the summed process-tree residency, not physical memory or JavaScript heap; shared pages can be counted more than once, especially Firefox, and OS-reparented helpers may be omitted, especially on macOS. These measurements do not prove safety at the 50 MiB maximum. The limit is unchanged and that limitation is documented.

Reproduce (after `just build` / `just e2e-setup`):

```sh
node scripts/bench_adx.mjs --engine chromium,firefox,webkit --runs 5 --out /private/tmp/adx-current.json
node scripts/bench_adx.mjs --engine chromium,firefox,webkit --runs 5 --adi-only --bundle /path/to/spec-only/adif-editor.html --out /private/tmp/adx-baseline.json
```
