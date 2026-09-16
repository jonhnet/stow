#!/bin/sh
set -eu
STOW_SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$STOW_SOURCE_DIR/scripts/environment.sh"
cd "$STOW_SOURCE_DIR"
mkdir -p "$STOW_BUILD_DIR/logs"
check() {
  name=$1
  shift
  printf 'Running %s…\n' "$name"
  if "$@" > "$STOW_BUILD_DIR/logs/$name.log" 2>&1; then
    tail -n 8 "$STOW_BUILD_DIR/logs/$name.log"
  else
    cat "$STOW_BUILD_DIR/logs/$name.log"
    return 1
  fi
}
check format cargo fmt --all -- --check
check hosting python3 -B -m unittest discover -s tests/hosting -p 'test_*.py'
check clippy cargo clippy --locked --all-targets --all-features -- -D warnings
check tests npm test
check build npm run build
check tools python3 scripts/check-tools.py
check browser npm run test:e2e
check browser-sync-firefox env STOW_TEST_BROWSER=firefox npm run test:e2e -- sync-schedules.spec.ts
