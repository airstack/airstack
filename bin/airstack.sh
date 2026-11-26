#!/usr/bin/env bash
# Resolve through symlinks to find the real package location
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
PKG_ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

exec bun "${PKG_ROOT}/cli/index.ts" "$@"
