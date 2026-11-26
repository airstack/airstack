#!/bin/bash
# check-health.sh — Backup health check for host alerter.
# Reads ${STATE_DIR}/backup/last-run.json.
# Outputs: one-line status. Exit 0=healthy, 1=unhealthy.
set -euo pipefail

STATE_DIR="${STATE_DIR:?STATE_DIR not set}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-36}"

LAST_RUN="${STATE_DIR}/backup/last-run.json"

if [[ ! -f "$LAST_RUN" ]]; then
  echo "MISSING"
  exit 1
fi

# Check age
age_seconds=$(( $(date +%s) - $(stat -c %Y "$LAST_RUN" 2>/dev/null || stat -f %m "$LAST_RUN" 2>/dev/null || echo 0) ))
age_hours=$(( age_seconds / 3600 ))

if (( age_hours > BACKUP_MAX_AGE_HOURS )); then
  echo "STALE ${age_hours}h"
  exit 1
fi

# Check for failures (simple grep — avoids python/jq dependency)
if grep -q '"status": "failed"' "$LAST_RUN"; then
  failed_set=$(grep -B1 '"status": "failed"' "$LAST_RUN" | head -1 | tr -d ' ":{' || echo "unknown")
  echo "FAILED ${failed_set}"
  exit 1
fi

echo "OK ${age_hours}h"
exit 0
