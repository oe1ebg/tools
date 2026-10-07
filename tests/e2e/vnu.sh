#!/bin/sh
# Nu Html Checker (vnu) on the built tool pages (issue #57).
#
#   vnu.sh <docroot>      e.g. site/ (`just build`) or the production image's
#                         /usr/share/nginx/html copied out by CI
#
# VNU is the checker command (default: `vnu`, as in the validator image;
# locally e.g. VNU="java -jar .e2e/vnu.jar"). Errors fail (exit 1),
# warnings are printed only. Messages listed in vnu-filter.txt are dropped.
set -eu

root=${1:?usage: vnu.sh <docroot>}
here=$(cd "$(dirname "$0")" && pwd)
vnu=${VNU:-vnu}

$vnu --version
# shellcheck disable=SC2086  # $vnu may be "java -jar …"
$vnu --filterfile "$here/vnu-filter.txt" \
  "$root/confirm/index.html" \
  "$root/confirm/confirm-offline.html" \
  "$root/adif/index.html" \
  "$root/adif/adif-editor.html" \
  "$root/sota-alerts/index.html"
echo "vnu: no errors"
