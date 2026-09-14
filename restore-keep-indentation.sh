#!/usr/bin/env bash
set -euo pipefail

STOW_SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -f "$STOW_SOURCE_DIR/../.env" ]]; then
  set -a
  source "$STOW_SOURCE_DIR/../.env"
  set +a
fi
source "$STOW_SOURCE_DIR/scripts/environment.sh"
STOW_TSX_LOADER=$(cd "$STOW_SOURCE_DIR" && node --input-type=module -e 'console.log(import.meta.resolve("tsx"))')
exec node --import "$STOW_TSX_LOADER" "$STOW_SOURCE_DIR/scripts/restore-keep-indentation.ts" "$@"
