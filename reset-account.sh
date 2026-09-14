#!/usr/bin/env bash
set -euo pipefail

STOW_SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -f "$STOW_SOURCE_DIR/../.env" ]]; then
  set -a
  source "$STOW_SOURCE_DIR/../.env"
  set +a
fi
source "$STOW_SOURCE_DIR/scripts/environment.sh"
exec "$CARGO_TARGET_DIR/release/stow-server" reset-account "$@"
