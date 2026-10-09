# Pins of the build-time validation tools (issue #57). Not built: the
# `validate` job in .github/workflows/ci.yml reads the image references from
# the FROM lines below and `docker run`s them. They live in a Dockerfile so
# Dependabot (docker, /tests/e2e) keeps tag and digest current, like every
# other image pin in the repo.
#
# Playwright: the @playwright/test npm package must be the same version as
# the image (its browsers are built for it). CI installs
# @playwright/test@<version from the tag below> into tests/e2e/node_modules/
# (git-ignored, no package.json) and checks that the image has the browser
# builds that version expects, so a Dependabot bump of this line is all an
# update needs.

# Nu Html Checker; the project only publishes a rolling "latest" image, so
# the digest is the pin (vnu --version is printed in the job log).
FROM ghcr.io/validator/validator:latest@sha256:3cb7d2f446677b84fb123427bc029e535739e2314b035b5824a4eb0557803761 AS vnu

FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f AS playwright

# The webserver the browser tests run against, with
# deploy/nginx.conf.example: the bundle as a third party would serve it.
FROM nginx:1.31.0-alpine@sha256:2f07d83bf561b506400dc183b1b2003803e39efbd22451f848adaba14d28c7c7 AS nginx
