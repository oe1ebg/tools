# Pin of the Go image that builds the cross-check tools (go.mod in this
# directory) when no local Go is installed: build.sh reads the FROM line
# below and runs `go build` in it. Not built itself; it is a Dockerfile so
# Dependabot (docker, /tests/tools) keeps tag and digest current. CI
# uses actions/setup-go with the version from go.mod instead.

FROM golang:1.27.3-trixie@sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80 AS go
