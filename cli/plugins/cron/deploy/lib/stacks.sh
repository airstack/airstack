#!/bin/bash
# stacks.sh — Cross-stack discovery from /etc/airstack/stacks/ manifests (one per deploy unit).
#
# Requires: STACKS_MANIFEST_DIR set in environment (sourced from .env before this file).
#
# Functions:
#   all_install_dirs         — prints one INSTALL_DIR per line
#   all_expected_containers  — prints expected container names (from docker-compose.yml)
#   get_manifest_value       — reads a key from a specific manifest file

all_install_dirs() {
  local dir="${STACKS_MANIFEST_DIR:?STACKS_MANIFEST_DIR not set}"
  [ -d "$dir" ] || return 0
  for manifest in "$dir"/*.env; do
    [ -f "$manifest" ] || continue
    get_manifest_value "$manifest" INSTALL_DIR
  done
}

# Containers the ROOT daemon should be running. Stacks run by a dev user (RUN_USER_KIND=dev) live
# in that user's rootless daemon, which root's `docker ps` cannot see, so they are skipped here.
all_expected_containers() {
  local dir="${STACKS_MANIFEST_DIR:?STACKS_MANIFEST_DIR not set}"
  [ -d "$dir" ] || return 0
  for manifest in "$dir"/*.env; do
    [ -f "$manifest" ] || continue
    [ "$(get_manifest_value "$manifest" RUN_USER_KIND)" = "dev" ] && continue
    local install_dir
    install_dir=$(get_manifest_value "$manifest" INSTALL_DIR)
    [ -n "$install_dir" ] || continue
    local compose="${install_dir}/docker-compose.yml"
    [ -f "$compose" ] || continue
    { grep 'container_name:' "$compose" || true; } | sed 's/.*container_name:[[:space:]]*//' | tr -d ' "'"'"
  done
}

# Prints the value, or nothing when the key is absent. Never fails: callers run under
# `set -euo pipefail`, and with one manifest per stack instance most manifests lack most keys.
get_manifest_value() {
  local manifest="$1" key="$2"
  { grep "^${key}=" "$manifest" 2>/dev/null || true; } | cut -d= -f2-
}
