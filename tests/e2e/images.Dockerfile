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
FROM ghcr.io/validator/validator:latest@sha256:6986e12ec06afd6f7ca11aa4f5a4555545c55f6e0ac54d311702152cf35ab73c AS vnu

FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS playwright

# The webserver the browser tests run against, with
# deploy/nginx.conf.example: the bundle as a third party would serve it.
FROM nginx:1.31.0-alpine@sha256:2f07d83bf561b506400dc183b1b2003803e39efbd22451f848adaba14d28c7c7 AS nginx
