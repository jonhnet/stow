#!/bin/sh
set -eu

STOW_SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$STOW_SOURCE_DIR/scripts/environment.sh"
cd "$STOW_SOURCE_DIR"

if [ ! -d "$STOW_BUILD_DIR/node_modules" ]; then
  printf '%s\n' 'Dependencies are missing. Run ./setup.sh to recreate ../build first.' >&2
  exit 1
fi

task=${1:?A task is required}
shift
case "$task" in
  dev) exec concurrently -k 'node scripts/watch-server.mjs' 'vite --host 127.0.0.1' "$@" ;;
  dev:lan) exec concurrently -k 'node scripts/watch-server.mjs' 'vite --host 0.0.0.0' "$@" ;;
  build) cargo build --locked --release; tsc --noEmit; exec vite build "$@" ;;
  start) exec "$CARGO_TARGET_DIR/release/stow-server" "$@" ;;
  test) cargo test --locked --all-features; cargo build --locked --features test-support; exec node --import tsx --test --test-concurrency=4 "$@" tests/*.test.ts ;;
  test:e2e) cargo build --locked --features test-support; exec playwright test "$@" ;;
  test:sync)
    cargo build --locked --features test-support
    tsc --noEmit
    vite build
    node --import tsx --test tests/sync-schedule.test.ts tests/sync-crash.test.ts tests/sync-transfer.test.ts tests/sync-reducer.test.ts
    playwright test sync-schedules.spec.ts "$@"
    if [ -z "${STOW_TEST_BROWSER:-}" ]; then STOW_TEST_BROWSER=firefox playwright test sync-schedules.spec.ts "$@"; fi
    ;;
  browsers:install) exec playwright install chromium "$@" ;;
  *) printf 'Unknown task: %s\n' "$task" >&2; exit 1 ;;
esac
