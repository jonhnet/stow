#!/bin/sh
set -eu
STOW_SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$STOW_SOURCE_DIR/scripts/environment.sh"
cd "$STOW_SOURCE_DIR"
scanner=${GITLEAKS_BIN:-gitleaks}
mkdir -p "$STOW_BUILD_DIR/logs"
# Export tracked files so ignored local vaults and secrets are never scanned or uploaded.
tree=$(mktemp -d "$STOW_BUILD_DIR/tmp/secret-scan.XXXXXX")
trap 'rm -rf "$tree"' EXIT HUP INT TERM
git archive HEAD | tar -xf - -C "$tree"
"$scanner" dir "$tree" --redact=100 --report-format=json --report-path="$STOW_BUILD_DIR/logs/secrets-tree.json"
"$scanner" git . --log-opts='--all --full-history -m' --redact=100 --report-format=json --report-path="$STOW_BUILD_DIR/logs/secrets-history.json"
