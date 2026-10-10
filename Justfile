# Recipes for the oe1ebg tools; run `just` to list them.
# No explicit `uv sync` step: `uv run` syncs the venv from uv.lock itself.

port := "8000"

# Prefer docker if both are installed; fall back to podman.
container_tool := `command -v docker >/dev/null 2>&1 && echo docker || command -v podman >/dev/null 2>&1 && echo podman || echo none`

# Commit shown in the offline tools' footer (scripts/offline_tool.py) and in
# site/tools/manifest.json; full SHA, shortened where shown (GitHub's
# /commit/<sha>/checks needs the full one). Locally it's HEAD, or "dev" outside a git
# checkout. An exported GIT_SHA wins.
git_sha := env("GIT_SHA", `git rev-parse HEAD 2>/dev/null || echo dev`)

# The CI run that builds the bundle, shown in the ADIF editor's compliance
# panel (scripts/build_adif.py): from GitHub Actions' own variables, empty
# (= "local build") elsewhere. An exported BUILD_RUN_URL wins.
build_run := env("BUILD_RUN_URL", if env("GITHUB_RUN_ID", "") == "" { "" } else { env("GITHUB_SERVER_URL", "https://github.com") + "/" + env("GITHUB_REPOSITORY", "") + "/actions/runs/" + env("GITHUB_RUN_ID") })

# Release version written into manifest.json and the tarball names; CI sets
# it from the tag. Defaults to `git describe`.
version := env("TOOLS_VERSION", `git describe --tags --always --dirty 2>/dev/null || echo dev`)

[private]
default:
    @just --list

# --- data (needs internet, except build-areas; results are cached in .cache/)

# Fetch/refresh the SOTA summit database for the SOTA Alerts Map's "all
# summits" overlay. The ~24MB CSV is cached in .cache/sota-summits/ (7-day
# max age) — set SOTA_SUMMITS_FORCE_REFRESH=1 to bypass.
[doc("Fetch/refresh the (cached) SOTA summit database (tools/sota-alerts/data/)")]
fetch-summits:
    uv run python scripts/fetch_summits.py

# Austrian callsign list (Fernmeldebüro PDF -> compact JSON). Cached in
# .cache/callsigns/ (7 days) — CALLSIGNS_FORCE_REFRESH=1 bypasses.
[doc("Fetch/refresh the (cached) Austrian callsign list (tools/shared/data/)")]
fetch-callsigns:
    uv run python scripts/fetch_callsigns.py

# All Austrian voice repeaters from the ÖVSV repeater database. Cached in
# .cache/repeaters/ (7 days) — REPEATERS_FORCE_REFRESH=1 bypasses.
[doc("Fetch/refresh the (cached) ÖVSV repeater list (tools/shared/data/)")]
fetch-repeaters:
    uv run python scripts/fetch_repeaters.py

# Offline Vienna location data: Stadt Wien addresses, GIP place names and
# Wiener Linien stops + the committed snapshots data-src/location-pois.json
# and data-src/location-aliases.toml. Downloads cached in
# .cache/vienna-location/ (30 days) — VIENNA_LOCATION_FORCE_REFRESH=1 bypasses.
[doc("Build the (cached) offline Vienna location data (tools/shared/data/)")]
build-location:
    uv run python scripts/build_location_data.py

# Austria-wide PLZ/Bezirk areas from the committed snapshot
# data-src/austria-areas.json. No network.
[doc("Build the offline Austria PLZ/Bezirk data (from the committed snapshot)")]
build-areas:
    uv run python scripts/build_austria_areas.py

# Offline basemap for the confirmation log's map view: Stadt Wien district
# boundaries (cached 30 days, VIENNA_MAP_FORCE_REFRESH=1) + the committed
# snapshot data-src/map-osm.json.
[doc("Build the (cached) offline basemap (tools/shared/data/)")]
build-map:
    uv run python scripts/build_map_data.py

# Every data step.
[doc("Fetch and build all data the tools ship (tools/shared/data/, tools/sota-alerts/data/)")]
data: fetch-summits fetch-callsigns fetch-repeaters build-location build-areas build-map

# --- committed snapshots, refreshed by hand (commit the result)

# Re-query OpenStreetMap (Overpass) for Vienna landmarks and places around
# Vienna (~25 km). Manual on purpose: Overpass is often overloaded.
[doc("Refresh the committed OSM landmark snapshot (data-src/location-pois.json)")]
refresh-pois:
    uv run python scripts/build_location_data.py --refresh-pois

# Re-download the BEV address register (~100 MB ZIP, cached 30 days;
# AUSTRIA_AREAS_FORCE_REFRESH=1 bypasses) and Statistik Austria's Bezirk
# list. pyproj is only needed here, hence --with.
[doc("Refresh the committed Austria PLZ/Bezirk snapshot (data-src/austria-areas.json)")]
refresh-areas:
    uv run --with pyproj python scripts/build_austria_areas.py --refresh

# Re-query OpenStreetMap (Overpass) for Vienna's main roads and waters.
[doc("Refresh the committed OSM basemap snapshot (data-src/map-osm.json)")]
refresh-map:
    uv run python scripts/build_map_data.py --refresh-osm

# Regenerate the ADIF validator's spec data (tools/shared/js/adif-spec-data.js)
# and its official test QSOs (tests/fixtures/adif-spec/) from adif.org.uk.
# Cached in .cache/adif-spec/ (ADIF_SPEC_FORCE_REFRESH=1 bypasses).
[doc("Regenerate the committed ADIF spec data (adif-spec-data.js) and official test QSOs")]
build-adif-spec:
    uv run python scripts/build_adif_spec.py

# --- bundle

# The confirmation log's offline files (precache.js, build-info.js,
# confirm-offline.html). Needs the data: they are inlined and hashed.
[doc("Build the confirmation log's offline bundle + service-worker precache list")]
build-confirm: fetch-callsigns fetch-repeaters build-location build-areas build-map
    GIT_SHA={{git_sha}} uv run python scripts/build_confirm.py

# The Notfunk-Meldebuch's offline files; same data as the confirmation log.
[doc("Build the Notfunk-Meldebuch's offline bundle + service-worker precache list")]
build-notfunk: fetch-callsigns fetch-repeaters build-location build-areas
    GIT_SHA={{git_sha}} uv run python scripts/build_notfunk.py

# The ADIF editor's single-file version (tools/adif/adif-editor.html) and
# build-info.js (commit, CI run, cross-check tool versions).
[doc("Build the ADIF editor's single-file adif-editor.html + build-info.js")]
build-adif:
    GIT_SHA={{git_sha}} BUILD_RUN_URL={{quote(build_run)}} uv run python scripts/build_adif.py

# Assemble site/tools/ (scripts/build_site.py): the tools without Markdown,
# the rendered manuals, the overview page and manifest.json. Re-run after
# editing anything in tools/ or docs/.
[doc("Assemble the deployable bundle in site/tools/")]
stage:
    GIT_SHA={{git_sha}} TOOLS_VERSION={{version}} uv run python scripts/build_site.py

# Everything: data, generated files, site/tools/.
[doc("Build the whole bundle (data + offline files + site/tools/)")]
build: fetch-summits build-confirm build-notfunk build-adif stage

# Release tarball of site/tools/ (top directory oe1ebg-tools-<version>/) and
# its SHA-256, in dist/. Untar it anywhere on a static webserver.
[doc("Pack site/tools/ into dist/oe1ebg-tools-<version>.tar.gz (+ .sha256)")]
dist: build
    #!/usr/bin/env sh
    set -eu
    name="oe1ebg-tools-{{version}}"
    mkdir -p dist
    rm -rf "dist/$name" && cp -R site/tools "dist/$name"
    tar -C dist -czf "dist/$name.tar.gz" "$name"
    rm -rf "dist/$name"
    (cd dist && shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256")
    cat "dist/$name.tar.gz.sha256"

# Serve site/ (the bundle at /tools/, as on oe1ebg.at) like the e2e tests do.
[doc("Serve site/ at http://localhost:8000/tools/ (needs `just stage` or `just build`)")]
serve:
    @echo "Serving http://localhost:{{port}}/tools/"
    python3 tests/e2e/serve.py site {{port}}

# --- checks

# Unit tests (node --test, zero dependencies). The ADIF cross-checks skip
# themselves without `crosscheck-tools`, the real-data checks without `data`
# (DATA_TESTS=require, as `test-data` and CI set it, makes that a failure).
[doc("Run the test suite (node --test)")]
test:
    node --test 'tests/*.test.mjs'

# The test suite with the real-data checks required (tests/real-data.mjs):
# after `just build`, nothing may skip for want of data.
[doc("Run the test suite with the built data required (after `just build`)")]
test-data:
    DATA_TESTS=require node --test 'tests/*.test.mjs'

# Build adifmt and adif-checker (pinned in tests/tools/go.mod) into
# tests/tools/bin/ (git-ignored): with a local Go, else in the golang image
# pinned in tests/tools/images.Dockerfile.
[doc("Build the ADIF cross-check tools (adifmt, adif-checker) into tests/tools/bin/")]
crosscheck-tools:
    tests/tools/build.sh

# The ADIF validator and exports against adifmt and adif-checker; fails
# instead of skipping without them.
[doc("Cross-check the ADIF validator and exports against adifmt and adif-checker")]
crosscheck: crosscheck-tools
    ADIF_CROSSCHECK=require node --test tests/adif-crosscheck.test.mjs

# Score the location lookup against the gold set tests/location-goldset.txt
# (needs `data`). `just eval-location -v` lists every failing case.
[doc("Score the offline location lookup against the gold set (tests/location-goldset.txt)")]
eval-location *args:
    node scripts/eval_location.mjs {{args}}

# Version of the pinned Playwright image (tests/e2e/images.Dockerfile); the
# npm package must match it.
playwright_version := `sed -nE 's#^FROM mcr\.microsoft\.com/playwright:v([0-9]+\.[0-9]+\.[0-9]+)-.*#\1#p' tests/e2e/images.Dockerfile`

# Browser tests (tests/e2e/, Playwright) against site/ from `just build`,
# served by tests/e2e/serve.py. Installs @playwright/test at the image's
# version into the ignored tests/e2e/node_modules/ (no package.json).
# Extra args go to `playwright test`, e.g. `just e2e --project=chromium
# confirm`. BASE_URL=… tests another server (the tools at <BASE_URL>tools/).
[doc("Browser tests of the tools (Playwright, needs `just build` first)")]
e2e *args:
    cd tests/e2e && npm install --no-save --no-package-lock --no-audit --no-fund @playwright/test@{{playwright_version}}
    cd tests/e2e && npx playwright install chromium firefox webkit
    cd tests/e2e && npx playwright test {{args}}

# Screenshots for the manuals (docs/img/, committed), from site/ of `just
# build`; re-run after visible changes to confirm or notfunk.
screenshots *args:
    cd tests/e2e && npm install --no-save --no-package-lock --no-audit --no-fund @playwright/test@{{playwright_version}}
    cd tests/e2e && npx playwright install chromium
    cd tests/e2e && npx playwright test --config shots.config.mjs {{args}}

# Nu Html Checker on the tool pages in site/ (tests/e2e/vnu.sh; errors fail,
# warnings are printed). Uses the pinned validator image when docker or
# podman is installed, as in CI; otherwise the vnu-jar npm package.
[doc("HTML validation (Nu Html Checker) of the tool pages, needs `just build` first")]
vnu:
    #!/usr/bin/env sh
    set -eu
    if [ "{{container_tool}}" != none ]; then
      image=$(awk '$1 == "FROM" && $4 == "vnu" { print $2 }' tests/e2e/images.Dockerfile)
      {{container_tool}} run --rm -v "$PWD/site:/site:ro" -v "$PWD/tests/e2e:/e2e:ro" "$image" sh /e2e/vnu.sh /site
    else
      npm install --prefix .e2e --no-save --no-package-lock --no-audit --no-fund vnu-jar
      VNU="java -jar .e2e/node_modules/vnu-jar/build/dist/vnu.jar" sh tests/e2e/vnu.sh site
    fi

# Remove generated files (keeps .cache/, so the data steps stay cheap).
[doc("Remove generated files and the bundle (keeps .cache/)")]
clean:
    rm -rf site dist tools/sota-alerts/data tools/shared/data tools/confirm/precache.js tools/confirm/confirm-offline.html tools/confirm/build-info.js tools/notfunk/precache.js tools/notfunk/notfunk-offline.html tools/notfunk/build-info.js tools/adif/adif-editor.html tools/adif/build-info.js tests/e2e/report tests/e2e/test-results tests/e2e/test-results.json
