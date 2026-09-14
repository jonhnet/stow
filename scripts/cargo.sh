#!/bin/sh
set -eu
STOW_SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$STOW_SOURCE_DIR/scripts/environment.sh"
cd "$STOW_SOURCE_DIR"
exec cargo "$@"
