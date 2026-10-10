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

**What the checksums and the attestation establish.** `.sha256` and
`SHA256SUMS` let you check that the tarball you downloaded is the one that
was attached to the release (an interrupted or altered download fails). The
release workflow also creates a build provenance attestation for the
tarball (`actions/attest-build-provenance`). `gh attestation verify
oe1ebg-tools-vX.Y.Z.tar.gz --repo oe1ebg/tools` checks that the tarball has
a signed attestation linked to that repository. That protects against a
substituted artifact, as long as the signer and the trust chain (the
repository, its workflows, GitHub) stay trusted; it does not protect against
a compromised repository or workflow, and by itself it does not enforce
that the build came from the intended release tag or workflow. For a tighter
policy add `--signer-workflow oe1ebg/tools/.github/workflows/release.yml`
and `--source-ref refs/tags/vX.Y.Z` (see the
[`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify)
manual). A checksum fetched from the same place as the tarball does not
protect against that place being compromised; one you pinned independently
(for example in your own build, as oe1ebg.at does) only protects against
changes from those pinned bytes, not against a bad release you pinned. Neither
says anything about the code itself, and nothing in the bundle checks files
again after they are installed (see *Why it matters* below).

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
# Apache with .htaccess only: your copy of deploy/htaccess.example, kept
# outside releases/ (the tarball has none)
cp /etc/oe1ebg-tools.htaccess releases/oe1ebg-tools-vX.Y.Z/.htaccess
ln -sfn releases/oe1ebg-tools-vX.Y.Z tools.new
mv -T tools.new tools                         # rename(2): the switch is atomic
```

`mv -T` is GNU coreutils (Linux); the first time, move a `tools` that is
still a real directory out of the way. Rolling back is the same switch to
the previous directory; delete old release directories once nobody needs
them. The webserver must follow symlinks (nginx and Apache's
`FollowSymLinks` do by default). Without symlinks, unpack next to the live
directory and swap the two with `mv`. The release CI installs every tarball
this way under `/a/b/tools/` before it is published (`validate-dist.yml`).

**Headers live outside the release.** The nginx example is server
configuration and keeps working across switches. An `.htaccess` inside the
release directory does not: each new release directory starts without one,
and after the switch the Content-Security-Policy, the framing protection
and `Cache-Control` would silently be gone. With Apache, use one of:

- the vhost: the `<IfModule mod_headers.c>` block of the example inside
  `<Directory "/srv/www/tools">`, the symlink's path (Apache matches the
  path as requested, not the release directory it points to);
- an `.htaccess` in the directory that holds the `tools` symlink: it applies
  below it, through the symlink too, but also to everything else there;
- a copy in every new release before the switch, as above.

All three were checked with Apache 2.4 against a symlinked release. Check
the headers after the first switch (`curl -I https://…/tools/confirm/`).

Why it matters: an upload over the live directory is not atomic, and for a
while the server has files of both releases. The service worker's precache
version is a hash over the files at build time; it names the cache, but the
browser does not check the bytes it downloads against it. A PWA that
installs during a partial upload can therefore keep a mix of two releases
in a cache with the new version's name until the next release. The same
can happen to the pages without a service worker in a browser that loads
them in that moment. This is a deployment hazard, not something observed
on oe1ebg.at.

**Scope of the atomic switch.** It protects against incomplete uploads and
partially populated directories: at every moment the server answers from one
complete release. It does not make a browser's multi-file load atomic. The
URLs are the same in every release, so a page or service worker can fetch
`precache.js` or HTML just before the switch and modules or data just after
it (and the other way round); the service worker caches what it gets without
digest checks or a pinned release URL. That residual race is short, but it
exists, so do not read the switch as "one coherent release in every client".
Avoid switching during a net or exercise, and check the footer version
after an update.

**Assessment: asset verification (limitation).** The bundle does not verify
its own files at runtime. Files are not content-hashed in their names, the
precache list names the files and the cache version, and the browser stores
whatever the server answers; there are no Subresource Integrity attributes
on the scripts and styles. What protects the integrity of an installation is
therefore the deployment: install the verified tarball as a whole, switch
atomically as above, serve it over HTTPS, and keep the headers in place.
Immutable, content-addressed release assets (hashed file names plus
integrity attributes or a precache that checks digests) would close the
partial-upload case on the client side, but change every URL and the
single-file bundler's assumptions, and are not done; the atomic install
covers the same case on the server side. This is a documented limitation and
a possible later hardening. No exploit is demonstrated here, and nothing was
observed on oe1ebg.at.

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

## Trust, storage and backups

What the tools can and cannot promise about the data on a device. The
manuals say the same in German, from the user's side.

- **Browser storage is isolated by origin, not by directory.** IndexedDB,
  localStorage and the Cache Storage belong to scheme + host + port. Every
  page and script served from the same origin can read and change what the
  tools stored (the logbooks, drafts, the callsign settings), whichever
  directory it lives in: another application under `https://host/`, a
  script of the surrounding site, or a compromised file. The tools cannot
  prevent that. The Content-Security-Policy of the examples only limits what
  the bundle's own pages load; it does not shield them from other pages of
  the same origin.
- **Deploy on a dedicated origin where it matters.** If the logs hold
  anything you would not want other software on the same host to touch (the
  Notfunk-Meldebuch with real operations, for example), serve the bundle
  from its own host name (`tools.example.org`, not `example.org/tools/`) and
  keep unrelated applications and user-generated content off that origin.
  A shared origin is acceptable when everything on it is under the same
  control. The relative links make either layout work. Known for
  oe1ebg.at: the tools are published under `/tools/` of that site, so they
  share its origin; the headers it actually sends were not audited for this
  documentation, and the examples in `deploy/` are examples.
- **Moving the origin starts empty.** A different host or port means empty
  logbooks; so does the `file://` single-file version, which has its own
  storage. Use the JSON backup to move data.
- **Backups are plaintext.** The JSON backups, CSV, ADIF and the automatic
  snapshots contain the logs unencrypted, and so does the browser's own
  storage on disk. Protect the device: full-disk encryption, a locked user
  account, no shared login on a shared computer (or a separate browser
  profile per person), and treat downloaded backups like the log itself.
- **Revision history is not tamper-evident.** Edits keep the previous
  version, deletes are soft, message numbers are never reused. That helps
  against mistakes, not against someone who can write to the storage or edit
  a backup file: there are no signatures or hash chains, and an imported
  backup is checked for structure, not for authenticity.
- **A download is not a retained backup.** The browser reports that a file
  download was started; the tools cannot see whether it finished, where it
  went, or whether it is still there later. "Backup" therefore means "a file
  was handed to the browser", and a copy is only a copy once it sits
  somewhere you control (another disk, a stick, another machine). Do a test
  import now and then.
- **Saved versus draft.** "Saved" means the record was committed in the
  tool's storage. A draft (half-typed form) is stored too, but in a separate
  and weaker way; it can be lost (another tab's draft, cleared site data,
  full storage), so the tools never count it as saved.
- **Without IndexedDB** (some private modes, odd `file://` setups) the tools
  fall back to localStorage and say so. It is smaller (about 5 MB per origin)
  and, without the Web Locks API (not available on plain `http://`, which is
  not a secure context), two tabs of the same tool cannot be serialised:
  they could take the same message number. This is a documented limitation;
  use one tab, and HTTPS or `localhost`. Records written in such a session
  are offered for copying into IndexedDB later; see the tools' READMEs.

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
