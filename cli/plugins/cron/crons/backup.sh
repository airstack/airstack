#!/bin/bash
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/.env"
exec "${INSTALL_DIR}/plugins/backup/backup.sh" "$@"
