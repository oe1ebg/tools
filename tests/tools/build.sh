#!/bin/sh
# Builds the ADIF cross-check tools pinned in go.mod (adifmt, adif-checker;
# `tool` directives, kept current by Dependabot) into bin/, for
# tests/adif-crosscheck.test.mjs. With a local Go (any version: GOTOOLCHAIN
# fetches the one go.mod asks for), else in the golang image pinned in
# images.Dockerfile via docker or podman (CONTAINER_TOOL overrides).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

if command -v go >/dev/null 2>&1; then
  CGO_ENABLED=0 go build -o bin/ tool
else
  ctr=${CONTAINER_TOOL:-}
  if [ -z "$ctr" ]; then
    for c in docker podman; do
      if command -v "$c" >/dev/null 2>&1 && "$c" info >/dev/null 2>&1; then ctr=$c; break; fi
    done
  fi
  if [ -z "$ctr" ]; then
    echo "build.sh: needs Go (https://go.dev/dl/) or a running docker/podman" >&2
    exit 1
  fi
  image=$(awk '$1 == "FROM" && $4 == "go" { print $2 }' images.Dockerfile)
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case $(uname -m) in
    x86_64 | amd64) arch=amd64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) arch=$(uname -m) ;;
  esac
  # Cross-compiled for this host; caches in /tmp, files owned by the caller.
  "$ctr" run --rm --user "$(id -u):$(id -g)" -v "$here:/w" -w /w \
    -e HOME=/tmp -e GOPATH=/tmp/go -e GOCACHE=/tmp/gocache -e CGO_ENABLED=0 -e GOOS="$os" -e GOARCH="$arch" \
    "$image" go build -o bin/ tool
fi
bin/adifmt version | head -1
