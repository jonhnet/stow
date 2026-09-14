#!/bin/sh
set -eu

STOW_SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$STOW_SOURCE_DIR/scripts/environment.sh"

# Node resolves dependencies through the workspace's ancestor node_modules link.
# Both the link and its generated target stay outside the source repository.
dependency_link="$STOW_WORKSPACE_DIR/node_modules"
if [ -L "$dependency_link" ]; then
  if [ "$(readlink "$dependency_link")" != 'build/node_modules' ]; then
    printf '%s\n' 'The workspace node_modules link must point to build/node_modules.' >&2
    exit 1
  fi
elif [ -e "$dependency_link" ]; then
  printf '%s\n' 'The workspace node_modules path is occupied; it must be a link to build/node_modules.' >&2
  exit 1
else
  ln -s build/node_modules "$dependency_link"
fi

if [ -e "$STOW_SOURCE_DIR/node_modules" ] || [ -L "$STOW_SOURCE_DIR/node_modules" ]; then
  printf '%s\n' 'Dependencies belong in ../build, not the source repository. Remove the source node_modules directory before running setup.' >&2
  exit 1
fi

cp "$STOW_SOURCE_DIR/package.json" "$STOW_SOURCE_DIR/package-lock.json" "$STOW_BUILD_DIR/"
npm ci --prefix "$STOW_BUILD_DIR" "$@"
cd "$STOW_SOURCE_DIR"
exec cargo build --locked
