#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
STOW_SOURCE_DIR="$PWD"
source "$STOW_SOURCE_DIR/scripts/environment.sh"
if [[ $# -lt 2 ]]; then
  printf 'Usage: %s PRIVATE_ENV_FILE HTTPS_ORIGIN [SERVER_OPTIONS...]\n' "$0" >&2
  exit 1
fi
STOW_LAB_ENV_FILE="$1"
STOW_LAB_PUBLIC_ORIGIN="$2"
shift 2
set -a
source "$STOW_LAB_ENV_FILE"
set +a
export STOW_ORIGIN="$STOW_LAB_PUBLIC_ORIGIN"
: "${STOW_PROXY_SECRET:?Set STOW_PROXY_SECRET in the private environment file}"
cargo build --locked --release --features test-support --bin stow-test-driver
exec "$CARGO_TARGET_DIR/release/stow-test-driver" lab "$@"
