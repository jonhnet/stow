# Sourced by setup.sh and run.sh after they resolve STOW_SOURCE_DIR.
STOW_WORKSPACE_DIR=$(dirname "$STOW_SOURCE_DIR")
STOW_BUILD_DIR="$STOW_WORKSPACE_DIR/build"
mkdir -p "$STOW_BUILD_DIR/tmp"

export TMPDIR="$STOW_BUILD_DIR/tmp"
export XDG_CACHE_HOME="$STOW_BUILD_DIR/cache"
export npm_config_cache="$STOW_BUILD_DIR/npm-cache"
export PLAYWRIGHT_BROWSERS_PATH="$STOW_BUILD_DIR/browsers"
export PLAYWRIGHT_HTML_OUTPUT_DIR="$STOW_BUILD_DIR/playwright-report"
export CARGO_HOME="$STOW_BUILD_DIR/cargo-home"
export CARGO_TARGET_DIR="$STOW_BUILD_DIR/cargo-target"
export PATH="$STOW_BUILD_DIR/node_modules/.bin:$PATH"
