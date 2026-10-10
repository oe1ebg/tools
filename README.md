# oe1ebg tools

Standalone browser tools for radio amateurs, developed for
[oe1ebg.at](https://oe1ebg.at/tools/) but usable on any static webserver,
including servers without internet access. Source code, issues and releases:
[github.com/oe1ebg/tools](https://github.com/oe1ebg/tools).

| Tool | Directory | Needs internet? |
| --- | --- | --- |
| Bestätigungsverkehr: offline logbook for check-in nets (PWA) | `tools/confirm/` | no (after the first load) |
| Notfunk-Meldebuch: offline emergency message log (PWA, draft) | `tools/notfunk/` | no (after the first load) |
| ADIF editor: view, validate and edit `.adi` logs | `tools/adif/` | no |
| SOTA Alerts Map | `tools/sota-alerts/` | **yes** (SOTA API, map tiles) |

Everything runs in the browser: plain HTML, CSS and ES modules, with no
framework and no server-side code. All data stays on the device. Each tool's
`README.md` (and `AGENTS.md`) next to its code has the details.
`tools/shared/` holds the code several tools use.

## Using a release

Each release `vX.Y.Z` provides `oe1ebg-tools-vX.Y.Z.tar.gz`, its `.sha256`,
and `SHA256SUMS`. The tarball contains the complete bundle: the tools, their
data as of the build date, the manuals, an overview page (`index.html`) and
`manifest.json` (version, commit, build time).

```sh
sha256sum -c oe1ebg-tools-vX.Y.Z.tar.gz.sha256
tar -xzf oe1ebg-tools-vX.Y.Z.tar.gz          # -> oe1ebg-tools-vX.Y.Z/
mv oe1ebg-tools-vX.Y.Z /srv/www/tools        # any directory / URL prefix
```

- **Links are all relative.** The bundle works under any URL prefix, and
  `shared/` must stay next to the tool directories. The PWAs (confirm,
  notfunk) need a secure context, which means HTTPS or `localhost`.
- **Serve pages, scripts, styles and data with revalidation.** `*.html`,
  `*.js`, `*.mjs`, `*.css`, `*.json` and `*.webmanifest` need
  `Cache-Control: no-cache`, and `.webmanifest` must be served as
  `application/manifest+json`. Otherwise a browser can mix files from an
  old and a new release after a deploy, and the PWAs only notice an update
  late. File names are not hashed; the PWAs keep each release in their own
  versioned cache. See `deploy/nginx.conf.example` and
  `deploy/htaccess.example`.
- **Security headers.** The examples send a Content-Security-Policy per
  location (bundle files only; the two inline load-failure scripts by
  sha256; the SOTA Alerts Map's API and tile hosts; `'unsafe-inline'` only
  for the three single-file versions), `frame-ancestors 'none'` and
  `X-Frame-Options: DENY` (framing can only be refused by a header),
  `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: strict-origin-when-cross-origin`, also on error
  responses. In nginx, a `location` with an `add_header` of its own drops
  all inherited ones, so the example sets them once at server level. When
  you adapt the policy, keep the hashes in step with the release
  (`tests/deploy-headers.test.mjs` checks the examples).
- **The data is frozen at build time.** Callsigns, repeaters, locations and
  summits are as of the build date. A weekly CI job rebuilds the current
  release with fresh data (see *Data refresh* below). To refresh an offline
  server, deploy a newer tarball.
- **Single-file versions for `file://` use** (USB stick, no webserver) are
  in the bundle: `confirm/confirm-offline.html`,
  `notfunk/notfunk-offline.html` and `adif/adif-editor.html`.

### Updating a deployment (atomically)

Install each release into its own directory and switch a symlink, instead
of copying a new release over the old one:

```sh
cd /srv/www                                   # the docroot, any prefix below it
sha256sum -c oe1ebg-tools-vX.Y.Z.tar.gz.sha256
mkdir -p releases && tar -C releases -xzf oe1ebg-tools-vX.Y.Z.tar.gz
ln -sfn releases/oe1ebg-tools-vX.Y.Z tools.new
mv -T tools.new tools                         # rename(2): the switch is atomic
```

`mv -T` is GNU coreutils (Linux); the first time, move a `tools` that is
still a real directory out of the way. Rolling back is the same switch to
the previous directory; delete old
release directories once nobody needs them. The webserver must follow
symlinks (nginx and Apache's `FollowSymLinks` do by default). Without
symlinks, unpack next to the live directory and swap the two with `mv`.
The release CI installs every tarball this way under `/a/b/tools/` before
it is published (`validate-dist.yml`).

Why it matters: an upload over the live directory is not atomic, and for a
while the server has files of both releases. The service worker's precache
version is a hash over the files at build time; it names the cache, but the
browser does not check the bytes it downloads against it. A PWA that
installs during a partial upload can therefore keep a mix of two releases
in a cache with the new version's name until the next release. The same
can happen to the pages without a service worker in a browser that loads
them in that moment. This is a deployment hazard, not something observed
on oe1ebg.at.

### Embedding in a site

oe1ebg.at pins a release, downloads the tarball in its Docker build, checks
the SHA-256 and unpacks it to `/tools/`. A site that embeds the bundle can
replace `index.html` (the overview) and render the manuals in its own theme
from `docs/`. The tools only rely on the relative URLs `../`,
`../confirm-anleitung/`, `../notfunk-anleitung/` and `../data-sources/`.

### Stable identifiers

These names are kept across releases and deployments so that saved
logbooks and settings survive updates. Do not rename them:

- the `oe1ebg-*` IndexedDB databases, localStorage keys and
  BroadcastChannel names;
- the `OE1EBG_DATA` and `OE1EBG_SW` globals;
- the `APP_OE1EBG_*` ADIF fields in exports.

Data is stored per origin (scheme + host + port), so moving a deployment to
another host starts with empty logbooks. Use the tools' JSON backup to move
data.

## Development

Requirements: [just](https://just.systems/), [uv](https://docs.astral.sh/uv/)
(Python per `.python-version`), Node per `.nvmrc`. Docker or podman is
optional, used for the HTML check and the ADIF cross-check tools.

```sh
just build     # data (cached in .cache/) + offline bundles + site/tools/
just serve     # http://localhost:8000/tools/
just test      # unit tests (node --test, zero dependencies)
just e2e       # browser tests (Playwright) against site/
just vnu       # HTML validation
just dist      # dist/oe1ebg-tools-<version>.tar.gz + .sha256
```

`just` lists every recipe. Repository layout:

| Path | What |
| --- | --- |
| `tools/` | the tools (source). The data and bundle steps write their git-ignored output in here. |
| `docs/` | the user manuals (German) and the data sources page, with screenshots (`just screenshots`) |
| `scripts/` | data fetch/build steps, the offline bundlers, `build_site.py` (assembles `site/tools/`) |
| `data-src/` | committed snapshots and curated inputs for the data steps (`just refresh-*` updates them) |
| `tests/` | unit tests, `e2e/` browser tests, `tools/` the Go ADIF cross-check tools |
| `deploy/` | webserver configuration examples |

## Releases and data refresh

- **`ci.yml`** runs on every push and PR: unit tests, the ADIF cross-checks,
  the bundle build with the real-data checks (`DATA_TESTS=require`), the HTML
  check and the browser tests against the bundle served by
  `deploy/nginx.conf.example`.
- **`release.yml`** runs on a `vX.Y.Z` tag. It builds the bundle with fresh
  data, runs the tests with the ADIF cross-checks and the real-data checks
  required, validates the exact tarball (`validate-dist.yml`: unpacked into
  a release directory behind a symlink, served by nginx with the example
  config, HTML check and browser tests in all five Playwright projects) and
  only then attaches that tarball and its checksums to the GitHub release.
  Any failure stops the release. The ADIF editor's compliance panel links
  the run that built it.
- **`data.yml`** runs weekly. It rebuilds the latest release tag with fresh
  data, validates the tarball the same way and uploads it to the rolling
  release `data-latest`, under the same asset name and with its own
  `SHA256SUMS` (new files first, stale ones of an older version removed
  afterwards). The data is built into the
  offline bundles and the service-worker precache hash, so it cannot be
  swapped in separately; a data refresh always means a rebuild of the whole
  bundle at a fixed code version.

## License

The code and the manuals are under the [MIT license](LICENSE). Two kinds of
content in the bundle keep their own licences:

- **Bundled data:** `tools/shared/data/` and `tools/sota-alerts/data/` (CC BY
  4.0, ODbL, …). `docs/data-sources.md` lists each dataset with its licence
  and required attribution.
- **Leaflet:** the vendored copy (`tools/shared/vendor/leaflet/`) is under
  BSD-2-Clause, with its `LICENSE` file next to it.

## History

This repository was split out of `ebirn/web_outdated_at` with its history.
The tools used to live there under `oe1ebg/tools/`, earlier under
`oe1ebg/content/<tool>/`, `oe1ebg/docs/<tool>/` and `docs/docs/<tool>/`.
Issue and PR numbers (`#57`, …) in older commit messages refer to that
repository.
