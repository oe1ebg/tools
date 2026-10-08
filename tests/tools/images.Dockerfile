# Pin of the Go image that builds the cross-check tools (go.mod in this
# directory) when no local Go is installed: build.sh reads the FROM line
# below and runs `go build` in it. Not built itself; it is a Dockerfile so
# Dependabot (docker, /oe1ebg/tests/tools) keeps tag and digest current. CI
# uses actions/setup-go with the version from go.mod instead.

FROM golang:1.27.1-trixie@sha256:8f58fd67ea075142d947a60e0caa4317746a55118d312f027793d382c7741734 AS go
