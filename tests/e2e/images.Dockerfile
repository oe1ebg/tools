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
FROM ghcr.io/validator/validator:latest@sha256:8f21030474e68e06905cfa801b37376e99c0e37867c653c5b6cd7e2dcaf3f503 AS vnu

FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea AS playwright

# The webserver the browser tests run against, with
# deploy/nginx.conf.example: the bundle as a third party would serve it.
FROM nginx:1.31.0-alpine@sha256:2f07d83bf561b506400dc183b1b2003803e39efbd22451f848adaba14d28c7c7 AS nginx
