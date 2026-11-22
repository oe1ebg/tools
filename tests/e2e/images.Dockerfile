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
FROM ghcr.io/validator/validator:latest@sha256:292cef9f3367a6d52447c617e65c94bca04cd3399abb37bd5d17c1c7d430525a AS vnu

FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579 AS playwright

# The webserver the browser tests run against, with
# deploy/nginx.conf.example: the bundle as a third party would serve it.
FROM nginx:1.31.9-alpine@sha256:fb4658584bd9a916ffb6f6e365f97c25cfdb2923801f551ea08356e695f14ff7 AS nginx
