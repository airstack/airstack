#!/bin/bash
# stacks.sh — Cross-stack discovery from /etc/stacks/ manifests.
#
# Requires: STACKS_MANIFEST_DIR set in environment (sourced from .env before this file).
#
# Functions:
#   all_install_dirs         — prints one INSTALL_DIR per line
#   all_expected_containers  — prints expected container names (from docker-compose.yml)
#   get_manifest_value       — reads a key from a specific manifest file

all_install_dirs() {
  local dir="${STACKS_MANIFEST_DIR:?STACKS_MANIFEST_DIR not set}"
  [ -d "$dir" ] || return
  for manifest in "$dir"/*.env; do
    [ -f "$manifest" ] || continue
    grep '^INSTALL_DIR=' "$manifest" | cut -d= -f2-
  done
}

all_expected_containers() {
  local dir="${STACKS_MANIFEST_DIR:?STACKS_MANIFEST_DIR not set}"
  [ -d "$dir" ] || return
  for manifest in "$dir"/*.env; do
    [ -f "$manifest" ] || continue
    local install_dir
    install_dir=$(grep '^INSTALL_DIR=' "$manifest" | cut -d= -f2-)
    [ -n "$install_dir" ] || continue
    local compose="${install_dir}/docker-compose.yml"
    [ -f "$compose" ] || continue
    grep 'container_name:' "$compose" | sed 's/.*container_name:[[:space:]]*//' | tr -d ' "'"'"
  done
}

get_manifest_value() {
  local manifest="$1" key="$2"
  grep "^${key}=" "$manifest" 2>/dev/null | cut -d= -f2-
}
