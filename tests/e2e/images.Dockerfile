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
FROM ghcr.io/validator/validator:latest@sha256:0af71abb9e40083cc0e8b3fcbe51a55a45889c662a3f507fbf1f9f013a109842 AS vnu

FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579 AS playwright

# The webserver the browser tests run against, with
# deploy/nginx.conf.example: the bundle as a third party would serve it.
FROM nginx:1.31.8-alpine@sha256:fed7e14be83cbd2661a75cdc5b872d936cf155d46c327084d30b8df19ae88d72 AS nginx
