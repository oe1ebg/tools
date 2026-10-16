# Pin of the Go image that builds the cross-check tools (go.mod in this
# directory) when no local Go is installed: build.sh reads the FROM line
# below and runs `go build` in it. Not built itself; it is a Dockerfile so
# Dependabot (docker, /tests/tools) keeps tag and digest current. CI
# uses actions/setup-go with the version from go.mod instead.

FROM golang:1.27.2-trixie@sha256:47667934874913a449b96faa7ef4777fa285d9ec29126ee80ed61c45b7cccf0e AS go
