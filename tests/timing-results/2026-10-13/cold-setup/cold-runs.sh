#!/bin/bash
# Cold setup runs (#36): each run says what is absent. Wall seconds.
set -u
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
W=$SCRATCH/cold
cd "$W"
IMG=$(sed -nE 's#^FROM (mcr\.microsoft\.com/playwright:[^ ]+) AS playwright#\1#p' tests/e2e/images.Dockerfile)
V=$(echo "$IMG" | sed -E 's#.*:v([0-9.]+)-.*#\1#')
t() { local s e; s=$(python3 -c 'import time;print(time.time())'); "$@" >$SCRATCH/cold-last.log 2>&1; local rc=$?; e=$(python3 -c 'import time;print(time.time())'); python3 -c "print(f'{$e-$s:.1f}s rc=$rc')"; }
echo "node $(node --version), playwright $V, $(date)"
for i in 1 2 3; do
  rm -rf $SCRATCH/cold/tools/shared/data $SCRATCH/cold/tools/sota-alerts/data $SCRATCH/cold/site
  echo "build, no generated data (download cache kept) #$i: $(t just build)"
done
for i in 1 2 3; do echo "build, warm (everything present) #$i: $(t just build)"; done
for i in 1 2 3; do
  rm -rf $SCRATCH/cold/tests/e2e/node_modules $SCRATCH/cold-npm-cache
  echo "npm install @playwright/test, empty npm cache #$i: $(cd tests/e2e && npm_config_cache=$SCRATCH/cold-npm-cache t npm install --no-save --no-package-lock --no-audit --no-fund @playwright/test@$V)"
done
for i in 1 2 3; do
  rm -rf $SCRATCH/cold/tests/e2e/node_modules
  echo "npm install @playwright/test, warm npm cache #$i: $(cd tests/e2e && npm_config_cache=$SCRATCH/cold-npm-cache t npm install --no-save --no-package-lock --no-audit --no-fund @playwright/test@$V)"
done
for i in 1 2 3; do
  rm -rf $SCRATCH/cold-browsers
  echo "playwright install chromium firefox webkit, no browsers #$i: $(cd tests/e2e && PLAYWRIGHT_BROWSERS_PATH=$SCRATCH/cold-browsers t npx playwright install chromium firefox webkit)"
done
echo "browsers size: $(du -sh $SCRATCH/cold-browsers | cut -f1)"
for i in 1 2 3; do
  podman rmi -f "$IMG" >/dev/null 2>&1
  echo "podman pull of the Playwright image, absent #$i: $(t podman pull -q "$IMG")"
done
echo "podman pull, present: $(t podman pull -q "$IMG")"
rm -rf $SCRATCH/cold-browsers $SCRATCH/cold-npm-cache
echo DONE
