#!/bin/sh
# Bump the pinned usage-server release in cli/plugins/cliproxyapi/usage-server-pin.ts.
# Usage: devutils/bump-usage-server.sh [X.Y.Z] [--commit]
#   no version  -> newest vX.Y.Z tag on the remote
# Needs only git + network. Does not touch the VPS; the next deploy builds the new tag there.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="$ROOT/cli/plugins/cliproxyapi/usage-server-pin.ts"
REPO="$(sed -n "s/^export const USAGE_SERVER_REPO = '\(.*\)'/\1/p" "$FILE")"
CUR="$(sed -n "s/^export const USAGE_SERVER_PIN = '\(.*\)'/\1/p" "$FILE")"
V=""; COMMIT=0
for a in "$@"; do case "$a" in --commit) COMMIT=1;; *) V="$a";; esac; done
TAGS="$(git ls-remote --tags --refs "$REPO" 'v*' | sed 's|.*refs/tags/v||' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V)"
[ -n "$TAGS" ] || { echo "no release tags found at $REPO" >&2; exit 1; }
[ -n "$V" ] || V="$(echo "$TAGS" | tail -1)"
echo "$TAGS" | grep -qx "$V" || { echo "tag v$V not found at $REPO. Available:" >&2; echo "$TAGS" | tail -5 >&2; exit 1; }
if [ "$V" = "$CUR" ]; then echo "already pinned to $V"; exit 0; fi
sed -i.bak "s/^export const USAGE_SERVER_PIN = '.*'/export const USAGE_SERVER_PIN = '$V'/" "$FILE" && rm -f "$FILE.bak"
echo "usage-server pin: $CUR -> $V"
if [ "$COMMIT" = 1 ]; then
  git -C "$ROOT" add "$FILE"
  git -C "$ROOT" commit -q -m "chore: bump usage-server pin to v$V"
  echo "committed"
else
  echo "review, then commit (or rerun with --commit)"
fi
