# AGENTS.md

## Repository

Standalone browser tools for radio amateurs: Confirm (Bestätigungsverkehr), Notfunk-Meldebuch, Netlog, the ADIF editor, and the SOTA Alerts Map. Plain HTML/CSS/ES modules; no framework or server code. Releases are self-contained static bundles, consumed by oe1ebg.at and deployable elsewhere, including on webservers without internet. `README.md` covers usage, deployment, trust, stable identifiers, and releases.

## Invariants

- **Offline and relative assets.** Bundled assets and internal navigation, including rendered manuals, use relative URLs that stay inside the bundle. Never assume a host name or `/tools/` prefix; no CDN or external fonts. External links opened by users (sources, licences, specifications, maps) are allowed. Only SOTA Alerts may make runtime network requests; it is documented as online-only. Confirm, Notfunk and Netlog must work offline, including their `file://` bundles.
- **Stable identifiers.** Never rename the `oe1ebg-*` IndexedDB/localStorage/BroadcastChannel names, `OE1EBG_DATA`/`OE1EBG_SW` globals, or `APP_OE1EBG_*` ADIF fields.
- **Data preservation and recovery.** Preserve existing records, values, revisions, and supported backups. Use soft deletes; schema changes require versioned, data-preserving migrations. New resource limits must provide a supported recovery path for data previously accepted or exported. Reject oversized imports clearly before applying changes; preserve each tool's documented import transaction and recovery contracts.
- **ISO dates and times.** Show and accept dates as ISO 8601 `YYYY-MM-DD` and times as 24-hour `HH:MM` or `HH:MM:SS` in every tool, with the time zone stated where it matters (UTC for radio data). Don't use locale-dependent formatting (`toLocale*String`, `Intl.DateTimeFormat` output as is) or a visible `<input type="date|time|datetime-local">`, whose display follows the browser locale. A native picker may only supply a value (`tools/shared/js/isodate.js`). Stored and exported formats (ADIF `YYYYMMDD`/`HHMM`, backups) stay as they are.
- **Browser and HTML compatibility.** Floor: Safari 15.4 / Firefox 115 ESR / Chrome 109. Follow `tools/shared/README.md`, “HTML & interop rules”: shared theme/styles, no inline styles or handlers in source HTML, no `innerHTML` with data, labelled controls and appropriate ARIA state. Preserve keyboard navigation, focus, and edit commits.
- **Deployment headers.** `deploy/nginx.conf.example` and `deploy/htaccess.example` define CSP per location: inline scripts by sha256, `'unsafe-inline'` only for single-file bundles, SOTA network hosts only under `sota-alerts/`. Changing an inline script or SOTA host requires updating both examples and checking `tests/deploy-headers.test.mjs`.
- **Generated data and bundles.** `tools/shared/data/` and `tools/sota-alerts/data/` are generated, shipped with the bundle, and included where needed in offline bundles and precache hashes. Refreshing data requires a full rebuild. Follow `scripts/single_file.py`: named imports without aliases, no default exports, `export` only on function/const/let/class declarations, and unique top-level names across bundled modules. All four single-file outputs must remain supported: `confirm-offline.html`, `notfunk-offline.html`, `netlog-offline.html`, `adif-editor.html`.

## UX and accessibility

Baseline: [WCAG 2.2](https://www.w3.org/TR/WCAG22/) level AA (the basis of EN 301 549 and Austria's Web-Zugänglichkeits-Gesetz), the [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) for widget patterns, and [Nielsen's ten usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/). Cite the success criterion (SC) or heuristic in findings.

Context: the tools are used while operating: during a live net or exercise, often with headphones and one hand on the microphone, under time pressure and divided attention; in the field (sunlight, darkness, cold, small screens, no network); by operators of all ages, mostly in German (de-AT); in emergency exercises (Notfunk), where a wrong entry has consequences.

- **Perceivable.**
  - Text contrast at least 4.5:1, 3:1 for large text, UI components and focus indicators, in light and dark themes (SC 1.4.3, 1.4.11).
  - State never by colour alone: add text, a symbol or a shape (SC 1.4.1).
  - Reflow at 320 CSS px and text at 200 % without loss or two-way scrolling, except data tables and maps with their own scrolling (SC 1.4.4, 1.4.10).
  - Data stays readable at arm's length: body text about 14 px or larger.
- **Operable.**
  - Everything works with the keyboard, in a logical order, without traps (SC 2.1.1, 2.1.2, 2.4.3).
  - The focus is always visible and not hidden by sticky elements (SC 2.4.7, 2.4.11).
  - Single-key shortcuts only outside text fields, documented in the help (SC 2.1.4).
  - Targets at least 24×24 CSS px (SC 2.5.8); about 44 px on touch for frequent actions.
  - No drag-only actions (SC 2.5.7); no time limits that lose input.
- **Understandable.**
  - Every control has a name, a visible label where there is room; a placeholder is not a label (SC 2.5.3, 3.3.2).
  - The same words, symbols and places for the same actions in every tool, e.g. Sichern / Wiederherstellen / Exportieren / Löschen (SC 3.2.3, 3.2.4); help in the same place (SC 3.2.6).
  - Errors say what is wrong and how to fix it, in text next to the cause (SC 3.3.1, 3.3.3).
  - Irreversible actions are confirmed or undoable (SC 3.3.4); prefer undo. Never make users re-enter what they gave already (SC 3.3.7).
- **Robust.**
  - Native elements first; ARIA for names and states (`aria-expanded`, `aria-pressed`, `aria-current`), following the APG pattern of the widget (SC 4.1.2).
  - Status messages through live regions, without moving focus (SC 4.1.3).
- **For operating.**
  - Live state (who is on air, saving, offline readiness) at a fixed place, glanceable; no layout shift while working.
  - One obvious primary action per view; secondary actions quieter; destructive ones last and separated.
  - Frequent tasks in few steps: Enter commits, Esc leaves a field, unfinished input survives switching, reloads and updates.
  - Times with their zone, dates in ISO (invariant above).
  - Dense but scannable lists; nothing essential only on hover; the phone layout keeps every workflow.
- **Checks** for UI changes, in addition to "Verification":
  - axe-core with the WCAG 2.2 A/AA rules on each affected view, with realistic data (`examples/backups/`);
  - a keyboard-only walk-through;
  - 320 px width and 200 % zoom;
  - both themes and forced colours;
  - for new widgets, a screen-reader spot check (VoiceOver or NVDA).
  - Record unresolved findings in an issue with SC references.

## Read before changing an area

Read applicable nested `AGENTS.md` files and the documents below before editing. Shared changes affect every consuming tool.

| Area | Required context |
| --- | --- |
| Confirm | `tools/confirm/AGENTS.md`, `tools/confirm/README.md` |
| Notfunk | `tools/notfunk/AGENTS.md`, `tools/notfunk/README.md`; its form format remains provisional |
| Netlog | `tools/netlog/AGENTS.md`, `tools/netlog/README.md`; issue #68 is the specification |
| ADIF editor, parser, validator, exports | `tools/adif/README.md`, relevant sections of `tools/shared/README.md`; ADIF cross-check rule below |
| SOTA API, map, summit lookup | `tools/sota-alerts/AGENTS.md`, `tools/sota-alerts/README.md`; read the API inventory and static-first lookup rules before extending network usage |
| Shared code, storage, offline/update logic | `tools/shared/README.md`, affected tools' instructions |
| Manuals and screenshots | `docs/confirm-anleitung.md`, `docs/notfunk-anleitung.md`, affected tool's UI/help, `tests/e2e/manual.shots.mjs`; keep German wording consistent |
| Build, deployment, CI | `README.md`, `Justfile`, relevant scripts, deployment examples, and workflow files |

## Commands and generated files

Run `just` to list recipes; `Justfile` is authoritative for arguments and prerequisites.

| Command | Purpose |
| --- | --- |
| `just test` | Node tests in `tests/*.test.mjs` |
| `just build` | Data, offline bundles, and staged `site/tools/` |
| `just stage` | Restage tools/manuals after source changes; does not rebuild offline bundles |
| `just serve` | Serve staged `site/` locally |
| `just e2e` | Playwright browser tests against the staged bundle |
| `just vnu` | Nu Html Checker against the staged bundle |
| `just test-data` | Node suite with real-data checks required, after building |
| `just crosscheck` | Build pinned Go tools and require ADIF cross-checks |
| `just screenshots` | Regenerate committed manual screenshots |
| `just dist` | Build and package a release tarball |

Data recipes cache downloads in `.cache/`. `refresh-*` and `build-adif-spec` rewrite committed snapshots and are intentional data-maintenance operations. Edit sources rather than generated output. `scripts/build_site.py` stages tools without Markdown/dotfiles and renders manuals; generated `site/` is the browser-test target.

## Verification

Choose checks by the changed behaviour and consumers. Add regression tests for concrete failures, using public entry points where practical. For limits, test below/at/above boundaries, existing data, alternate encodings, tolerated malformed input, and export/restore compatibility as applicable.

| Change | Checks |
| --- | --- |
| Pure JS logic | Relevant Node tests; `just test` for changes affecting multiple modules/tools |
| UI behaviour | Affected Playwright specs in supported desktop/mobile browser projects |
| Shared code or bundling | Tests for all affected consumers; rebuild and check served and `file://` variants |
| HTML, CSS, inline boot scripts, CSP | Rebuild, `just vnu`, header tests, affected browser specs |
| Generated data | Full rebuild, `just test-data`, relevant gold-set/plausibility checks |
| ADIF parsing, validation, export | Conformance, official fixtures, snapshots, cross-checks, affected browser specs |
| Deployment/release workflows | Relevant workflow/header tests and validation of the exact artifact where applicable |
| Documentation only | Verify paths, commands, and consistency; rendered-manual changes also need staging/layout checks |

Browser fixtures fail on page/console errors, CSP violations, same-origin HTTP errors, and unstubbed foreign requests. SOTA tests stub APIs and tiles. Preserve these checks. Report checks run, unavailable dependencies, skipped tests, and remaining uncertainty explicitly. Real-data and Go cross-check tests can skip locally unless required; a passing suite with skips does not establish those checks passed. Update snapshots only for intended output changes.

**Confirm/Notfunk backup parts:** preserve the shared `tools/shared/js/backup-parts.js` contract and `tests/backup-parts.test.mjs`. A set is limited to 12 parts, 480 MiB, and 1,000,000 records including chunks. Export must refuse an unrestorable set or unsplittable record before any download, never omit data or produce a partial set. Long strings, including revisions, use numbered chunks; validate the complete set and reconstruct text before normal validation and one atomic import. Missing, duplicate, inconsistent, orphaned, or tampered chunks reject the whole set with a German message and no writes. Parts may contain only chunks and must stay within the same tool. Older app versions cannot safely restore chunked parts; keep the compatibility warning in the manuals. Multiple downloads may be blocked: report files started, require checking all arrived, and do not record a successful backup/export time for parts. Format details belong in the tools' READMEs.

**ADIF cross-checks:** a failing cross-check is **not automatically our bug**. Before changing validation or exports, consult ADIF 3.1.7 (https://adif.org.uk/317/ADIF_317.htm and its resources page). Either fix our behaviour or record the other tool's deviation in the test case's `differs`, citing the spec section, and in `tools/adif/README.md`, “Cross-checks with other tools”. Never flip an expectation merely to pass.

## Git and pull requests

- Use an isolated Git worktree and a dedicated branch for each PR. Preserve unrelated work and check the working tree and remote branch before updating history.
- Prefer **rebase and merge** with linear history. Update PR branches by rebasing onto their current base; resolve conflicts on the branch rather than merging the base into it. When reporting merge readiness, check that rebase merging is possible as well as checking CI and ordinary mergeability.
- When related work spans multiple active PRs, prefer **stacked PRs** where practical: the first targets `main`, each dependent PR targets the preceding branch, and each diff contains only its own change. Keep independent work based on `main` when stacking would create an artificial dependency.
- State dependencies and merge order in each stacked PR description, and link the other PRs. Review and merge from the bottom of the stack upward.
- After a parent is rebased or merged, restack its descendants onto the updated parent or `main` and update PR bases. GitHub rebase merging changes commit IDs; replay only each descendant's own commits, preserving its diff and avoiding duplicate parent commits. Recheck affected tests and CI scope after restacking.
- Push rewritten PR branches with `--force-with-lease`, checking the expected remote head so newer collaborator changes are not overwritten. Merge only when the user has authorized merging.
- Before a version release, follow `releases/README.md` and prepare `releases/vX.Y.Z.md` in a reviewed PR before tagging. Summarize user-visible changes, update steps, and limitations; link technical details and included PRs below. Check the actual changes since the previous stable tag. The release workflow reads notes from the tagged commit and appends generated PR details; preserve its validation gates and never create or push a release tag without user authorization.

## Reviews and CI

Review the current PR head against its stated scope and issue acceptance criteria. Support findings with a reproduction or specific code path and explain the impact. Separate defects from suggestions and unverified concerns. Green CI establishes coverage of the checks that ran; verify their scope and skips. Distinguish completion of a PR from completion of its parent issue.

Workflow files define CI scope. `ci.yml` checks changes, builds, and validates applicable browser projects. A run whose git tree already passed with the same or wider scope in all five browser projects skips the checks (`scripts/ci_verified.py`, marker artifacts). Keep the marker strict: same-repository `ci.yml`, a successful run, and a scope that covers the current one. Release/data workflows require real-data and ADIF cross-checks and validate the exact tarball through `validate-dist.yml` before publication. Preserve these gates. Pin actions to full SHAs with version comments, images to tag/digest pairs, and dependencies through the existing version files/locks. See `README.md`, “Releases and data refresh”, for operational details.

`pages.yml` publishes previews (`main/`, `pr/<N>/`, `release/<tag>/`, `release/data-latest/`, generated index) to the `gh-pages` branch; see `README.md`, “GitHub Pages previews”. `build` and `releases` are read-only; `deploy` (`contents: write`) treats their artifacts as data and runs only the default branch's `scripts/pages_*.py` and `build_pages_index.py` (tests: `tests/pages.test.mjs`; the index page goes through the Nu Html Checker from `tests/fixtures/pages/`). Pages sends none of the nginx headers, so previews do not replace `validate`. Concurrency is per entry (GitHub keeps one pending run per group); writes serialize through the lease push. All entries share one origin: the tools' storage and the `tools-<tool>-*` service-worker caches are shared (a worker deletes the other entries' caches on activation). Keep the identifiers and the documented warning. `pages.yml` changes need no `ci.yml` filter entry; `scripts/`, `tests/*.mjs` and `tests/fixtures/pages/` are in the `site` filter.
