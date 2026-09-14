#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# Optional private settings live outside the source checkout.
if [[ -f ../.env ]]; then
  set -a
  source ../.env
  set +a
fi
export STOW_AUTH_MODE="${STOW_AUTH_MODE:-password}"
case "$STOW_AUTH_MODE" in
  proxy)
    : "${STOW_PROXY_SECRET:?Set STOW_PROXY_SECRET to the private secret nginx sends in X-Stow-Proxy-Secret}"
    export STOW_PROXY_SECRET
    ;;
  password)
    : "${STOW_PASSWORD:?Set STOW_PASSWORD to your existing Stow password before running this script}"
    export STOW_PASSWORD
    ;;
  *) printf 'STOW_AUTH_MODE must be proxy or password.\n' >&2; exit 1 ;;
esac

if [[ -n "${STOW_ORIGIN:-}" ]]; then
  exec npm run dev:lan
fi
exec npm run dev
