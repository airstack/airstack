#!/bin/bash
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/.env"
exec "${INSTALL_DIR}/plugins/cron/host-status/host_alerter.sh" "$@"
