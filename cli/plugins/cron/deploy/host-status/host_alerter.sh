#!/bin/bash
# Host resource monitoring — sends Telegram alerts on threshold breaches.
# Runs via cron (typically every 15 minutes).
#
# Sources from .env: INSTALL_DIR, PROJECT_NAME, STATE_DIR, STACKS_MANIFEST_DIR
# Optional env overrides: DISK_THRESHOLD (85), MEMORY_THRESHOLD (90),
#   DISK_FREE_MIN_GB (0 = off): alert when free space on / drops below this many GB,
#   INODE_FREE_MIN_PCT (10): alert when free inodes on a watched mount drop below this %,
#   ALERT_MOUNTS ("/ /tmp"): mounts watched for inodes and space (deduplicated by mount point)
# Security (docs/HOST-SECURITY.md):
#   SECURITY_REPORT (auto): --report appends host_security.sh's "Security" section; auto = on when
#     the script exists, false = off, true = on (a missing script then shows as a failed check)
#   SECURITY_SCRIPT (${INSTALL_DIR}/plugins/cron/host-status/host_security.sh): override the path
#   SECURITY_SAMPLE (true): the 15-minute run also records outbound connections (host_security.sh --sample)
#   All SECURITY_* knobs of host_security.sh pass through (SECURITY_SKIP, SECURITY_PUBLIC_PORTS, ...).
# Cron env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#
# NOTE: Linux-only — uses /proc/meminfo, df --output, md5sum, stat -c
#
# Usage:
#   host_alerter.sh           Normal mode — alert on state changes only
#   host_alerter.sh --report  Daily report — send full status summary
set -euo pipefail

REPORT_MODE=false
if [[ "${1:-}" == "--report" ]]; then
  REPORT_MODE=true
fi

# Expects INSTALL_DIR, STATE_DIR, STACKS_MANIFEST_DIR etc in environment (set by cron shim via .env)
INSTALL_DIR="${INSTALL_DIR:?INSTALL_DIR not set}"
STATE_DIR="${STATE_DIR:?STATE_DIR not set}"
STACKS_MANIFEST_DIR="${STACKS_MANIFEST_DIR:?STACKS_MANIFEST_DIR not set}"
source "${INSTALL_DIR}/plugins/cron/lib/stacks.sh"

STATE_FILE="${STATE_DIR}/host-health/alert-state"
DISK_THRESHOLD="${DISK_THRESHOLD:-85}"
MEMORY_THRESHOLD="${MEMORY_THRESHOLD:-90}"
DISK_FREE_MIN_GB="${DISK_FREE_MIN_GB:-0}"
INODE_FREE_MIN_PCT="${INODE_FREE_MIN_PCT:-10}"
ALERT_MOUNTS="${ALERT_MOUNTS:-/ /tmp}"

# --- Collect metrics ---
alerts=()

# Disk usage (root partition)
disk_pct=$(df / --output=pcent | tail -1 | tr -dc '0-9')
disk_total_gb=$(df / --output=size | tail -1 | awk '{printf "%.0f", $1/1024/1024}')
if (( disk_pct > DISK_THRESHOLD )); then
  alerts+=("⚠️ Disk usage at ${disk_pct}% of ${disk_total_gb} GB (threshold: ${DISK_THRESHOLD}%)")
fi

# Free space in GB on / (an absolute floor catches a shrinking disk earlier than a percentage).
# Alert text uses a 5 GB bucket, not the live number: the alert fires on a change of text,
# so a live number would re-alert every run.
disk_free_gb=$(df / --output=avail | tail -1 | awk '{printf "%d", $1/1024/1024}')
if (( DISK_FREE_MIN_GB > 0 && disk_free_gb < DISK_FREE_MIN_GB )); then
  bucket=$(( disk_free_gb / 5 * 5 ))
  alerts+=("⚠️ Disk free space below ${DISK_FREE_MIN_GB} GB on / (about ${bucket}-$((bucket + 5)) GB free)")
fi

# Inodes and space per watched mount (/tmp is often its own tmpfs and runs out of inodes first).
# mount_stats MOUNT -> "TARGET SPACE_USED_PCT INODE_FREE_PCT" (inode free is 100 if the filesystem has no inode counts)
mount_stats() {
  local target pcent iused iavail ifree=100
  read -r target pcent iused iavail < <(df --output=target,pcent,iused,iavail "$1" 2>/dev/null | tail -1)
  [[ "$iused" =~ ^[0-9]+$ && "$iavail" =~ ^[0-9]+$ ]] && (( iused + iavail > 0 )) && ifree=$(( iavail * 100 / (iused + iavail) ))
  echo "$target ${pcent//[^0-9]/} $ifree"
}
mounts_json=""
declare -A seen_mounts=()
for m in $ALERT_MOUNTS; do
  [[ -d "$m" ]] || continue
  read -r target space_used inode_free < <(mount_stats "$m")
  [[ -n "${seen_mounts[$target]:-}" ]] && continue
  seen_mounts[$target]=1
  inode_bucket=$(( inode_free / 5 * 5 ))
  if (( inode_free < INODE_FREE_MIN_PCT )); then
    alerts+=("⚠️ Inodes low on $target (about ${inode_bucket}-$((inode_bucket + 5))% free, threshold ${INODE_FREE_MIN_PCT}%)")
  fi
  if [[ "$target" != "/" ]] && (( space_used > DISK_THRESHOLD )); then
    alerts+=("⚠️ Space on $target is above ${DISK_THRESHOLD}% used")
  fi
  mounts_json+="    \"$target\": {\"space_used_pct\": ${space_used}, \"inode_free_pct\": ${inode_free}},"$'\n'
done
mounts_json=$(printf '%s' "$mounts_json" | sed '$ s/,$//')

# Memory usage
mem_total=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
mem_available=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
mem_pct=$(( (mem_total - mem_available) * 100 / mem_total ))
mem_total_gb=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo)
if (( mem_pct > MEMORY_THRESHOLD )); then
  alerts+=("⚠️ Memory usage at ${mem_pct}% (threshold: ${MEMORY_THRESHOLD}%)")
fi

# Load average (5-min) vs CPU count
cpu_count=$(nproc)
load_avg=$(awk '{print $2}' /proc/loadavg)
load_int=${load_avg%%.*}
if (( load_int >= cpu_count )); then
  alerts+=("⚠️ Load average: ${load_avg} (CPUs: ${cpu_count})")
fi

# Docker daemon health
docker_ok=true
if ! docker info >/dev/null 2>&1; then
  alerts+=("🔴 Docker daemon is not responding")
  docker_ok=false
fi

# --- Per-container status check via manifests ---
containers_json=""
containers_all_ok=true
if $docker_ok; then
  running=$(docker ps --format '{{.Names}}' 2>/dev/null || true)
  restarting=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | awk '/Restarting/ {print $1}' || true)

  while IFS= read -r expected; do
    [ -n "$expected" ] || continue
    if echo "$restarting" | grep -qx "$expected"; then
      status="restarting"
      alerts+=("🔴 Container restarting: $expected")
      containers_all_ok=false
    elif echo "$running" | grep -qx "$expected"; then
      status="running"
    else
      status="stopped"
      alerts+=("🔴 Container not running: $expected")
      containers_all_ok=false
    fi
    containers_json+="    \"${expected}\": \"${status}\","$'\n'
  done < <(all_expected_containers)

  containers_json=$(printf '%s' "$containers_json" | sed '$ s/,$//')
fi

# Detect unexpected restarting containers
crashed=""
if $docker_ok; then
  all_restarting=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | \
    awk '/Restarting/ {print $1}' || true)
  extra_crashed=""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if ! echo "$containers_json" | grep -q "\"${name}\""; then
      extra_crashed+="${name},"
    fi
  done <<< "$all_restarting"
  crashed=$(echo "$extra_crashed" | sed 's/,$//')
  if [[ -n "$crashed" ]]; then
    alerts+=("⚠️ Unexpected containers restarting: $crashed")
  fi
fi

# --- Backup health check (cross-stack via manifests) ---
backup_ok=true
backup_status_text=""
for manifest in "${STACKS_MANIFEST_DIR}"/*.env; do
  [ -f "$manifest" ] || continue
  health_check=$(get_manifest_value "$manifest" BACKUP_HEALTH_CHECK)
  [ -n "$health_check" ] && [ -x "$health_check" ] || continue
  stack_state_dir=$(get_manifest_value "$manifest" STATE_DIR)
  stack_name=$(get_manifest_value "$manifest" PROJECT_NAME)
  result=$(STATE_DIR="$stack_state_dir" "$health_check" 2>/dev/null) || true
  case "$result" in
    OK*) backup_status_text="${result#OK }" ;;
    STALE*) alerts+=("⚠️ Backup stale for ${stack_name}: ${result}"); backup_ok=false ;;
    MISSING*) alerts+=("⚠️ No backup data for ${stack_name}"); backup_ok=false ;;
    FAILED*) alerts+=("⚠️ Backup failed for ${stack_name}: ${result}"); backup_ok=false ;;
  esac
done

# --- Write health.json to own stack ---
health_json="{
  \"timestamp\": \"$(date -Iseconds)\",
  \"disk_pct\": ${disk_pct},
  \"disk_total_gb\": ${disk_total_gb},
  \"disk_threshold\": ${DISK_THRESHOLD},
  \"disk_free_gb\": ${disk_free_gb},
  \"disk_free_min_gb\": ${DISK_FREE_MIN_GB},
  \"mounts\": {
${mounts_json}
  },
  \"memory_pct\": ${mem_pct},
  \"memory_total_gb\": ${mem_total_gb},
  \"memory_threshold\": ${MEMORY_THRESHOLD},
  \"load_avg\": \"${load_avg}\",
  \"cpu_count\": ${cpu_count},
  \"docker_ok\": ${docker_ok},
  \"containers\": {
${containers_json}
  },
  \"containers_ok\": ${containers_all_ok},
  \"crashed\": \"${crashed}\",
  \"backup_ok\": ${backup_ok},
  \"backup_status\": \"${backup_status_text}\"
}"

if [[ -n "${STATE_DIR:-}" ]]; then
  health_dir="${STATE_DIR}/host-health"
  mkdir -p "$health_dir"
  echo "$health_json" > "${health_dir}/health.json"
  chmod 644 "${health_dir}/health.json"
fi

# >>> security-section (test/cli/plugins/host-security.test.ts runs this block on its own)
# security_section USED_CHARS -> sets SECURITY_SECTION (Telegram HTML) and SECURITY_ISSUES (count).
# Never fails: a crash or timeout of the script becomes one "failed to run" line counted as 1 issue.
security_section() {
  local script="${SECURITY_SCRIPT:-${INSTALL_DIR}/plugins/cron/host-status/host_security.sh}"
  local budget=$(( 3900 - $1 - 150 )) out rc=0 last
  if (( budget < 500 )); then budget=500; fi
  SECURITY_SECTION="⚠️ Security checks failed to run"
  SECURITY_ISSUES=1
  if command -v timeout >/dev/null 2>&1; then
    out=$(SECURITY_TELEGRAM_BUDGET=$budget timeout -k 5 60 bash "$script" --telegram 2>/dev/null) || rc=$?
  else
    out=$(SECURITY_TELEGRAM_BUDGET=$budget bash "$script" --telegram 2>/dev/null) || rc=$?
  fi
  last="${out##*$'\n'}"
  if (( rc != 0 )) || [[ ! "$last" =~ ^ISSUES=[0-9]+$ ]] || [[ "$out" == "$last" ]]; then
    return 0
  fi
  SECURITY_ISSUES="${last#ISSUES=}"
  SECURITY_SECTION="${out%$'\n'*}"
}
# <<< security-section

# Best-effort outbound sampler for the 15-minute run. Never changes this script's exit status.
security_sample() {
  [[ "${SECURITY_SAMPLE:-true}" == true ]] || return 0
  local script="${SECURITY_SCRIPT:-${INSTALL_DIR}/plugins/cron/host-status/host_security.sh}"
  [[ -f "$script" ]] || return 0
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 2 15 bash "$script" --sample >/dev/null 2>&1 || true
  else
    bash "$script" --sample >/dev/null 2>&1 || true
  fi
}

# Cloudflare Access guard for the 15-minute run: each FAIL/WARN line of `host_security.sh --access`
# becomes an alert, so a route that loses Access protection alerts within 15 minutes (and recovers).
# SECURITY_ACCESS_ALERTS=false turns it off. Best effort: never changes this script's exit status.
access_alerts() {
  [[ "${SECURITY_ACCESS_ALERTS:-true}" == true ]] || return 0
  local script="${SECURITY_SCRIPT:-${INSTALL_DIR}/plugins/cron/host-status/host_security.sh}" out line
  [[ -f "$script" ]] || return 0
  if command -v timeout >/dev/null 2>&1; then
    out=$(timeout -k 2 60 bash "$script" --access 2>/dev/null) || true
  else
    out=$(bash "$script" --access 2>/dev/null) || true
  fi
  while IFS= read -r line; do
    case "$line" in
      FAIL\|access\|*) alerts+=("Cloudflare Access: ${line#FAIL|access|}") ;;
      WARN\|access\|*) alerts+=("Cloudflare Access (unverified): ${line#WARN|access|}") ;;
    esac
  done <<<"$out"
}

# --- Telegram config ---
TELEGRAM_CONFIGURED=false
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  TELEGRAM_CONFIGURED=true
fi

# --- Report mode ---
if $REPORT_MODE; then
  if ! $TELEGRAM_CONFIGURED; then exit 0; fi

  hostname=$(hostname)
  uptime_str=$(uptime -p 2>/dev/null | sed 's/^up //' || uptime | awk -F'( |,)' '{print $2}')
  container_total=0; container_running=0
  if $docker_ok; then
    container_total=$(docker ps -a --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
    container_running=$(docker ps --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
  fi

  warn_count=0
  report="📊 <b>${hostname}</b> — Daily Status"$'\n'

  if (( disk_pct > DISK_THRESHOLD )); then
    report+=$'\n'"⚠️ Disk: ${disk_pct}% of ${disk_total_gb} GB (limit ${DISK_THRESHOLD}%)"
    ((warn_count+=1))
  else
    report+=$'\n'"✅ Disk: ${disk_pct}% of ${disk_total_gb} GB (limit ${DISK_THRESHOLD}%)"
  fi

  if (( DISK_FREE_MIN_GB > 0 )); then
    if (( disk_free_gb < DISK_FREE_MIN_GB )); then
      report+=$'\n'"⚠️ Free space: ${disk_free_gb} GB on / (minimum ${DISK_FREE_MIN_GB} GB)"
      ((warn_count+=1))
    else
      report+=$'\n'"✅ Free space: ${disk_free_gb} GB on / (minimum ${DISK_FREE_MIN_GB} GB)"
    fi
  fi

  for m in "${!seen_mounts[@]}"; do
    read -r target space_used inode_free < <(mount_stats "$m")
    if (( inode_free < INODE_FREE_MIN_PCT )); then
      report+=$'\n'"⚠️ Inodes on $target: ${inode_free}% free (minimum ${INODE_FREE_MIN_PCT}%)"
      ((warn_count+=1))
    else
      report+=$'\n'"✅ Inodes on $target: ${inode_free}% free"
    fi
  done

  if (( mem_pct > MEMORY_THRESHOLD )); then
    report+=$'\n'"⚠️ Memory: ${mem_pct}% of ${mem_total_gb} GB (limit ${MEMORY_THRESHOLD}%)"
    ((warn_count+=1))
  else
    report+=$'\n'"✅ Memory: ${mem_pct}% of ${mem_total_gb} GB (limit ${MEMORY_THRESHOLD}%)"
  fi

  if (( load_int >= cpu_count )); then
    report+=$'\n'"⚠️ Load: ${load_avg} / ${cpu_count} CPUs"
    ((warn_count+=1))
  else
    report+=$'\n'"✅ Load: ${load_avg} / ${cpu_count} CPUs"
  fi

  if $docker_ok; then
    report+=$'\n'"✅ Docker"
  else
    report+=$'\n'"🔴 Docker: not responding"
    ((warn_count+=1))
  fi

  if $docker_ok; then
    if $containers_all_ok; then
      report+=$'\n'"✅ Containers: ${container_running}/${container_total} running"
    else
      while IFS= read -r expected; do
        [ -n "$expected" ] || continue
        if echo "$restarting" | grep -qx "$expected" 2>/dev/null; then
          report+=$'\n'"🔴 ${expected}: restarting"
          ((warn_count+=1))
        elif ! echo "$running" | grep -qx "$expected" 2>/dev/null; then
          report+=$'\n'"🔴 ${expected}: stopped"
          ((warn_count+=1))
        fi
      done < <(all_expected_containers)
      report+=$'\n'"ℹ️ Total: ${container_running}/${container_total} running"
    fi
  else
    report+=$'\n'"⚠️ Containers: unknown (Docker down)"
    ((warn_count+=1))
  fi
  if [[ -n "$crashed" ]]; then
    report+=$'\n'"⚠️ Unexpected restarting: ${crashed}"
    ((warn_count+=1))
  fi

  if $backup_ok && [[ -n "$backup_status_text" ]]; then
    report+=$'\n'"✅ Backup: ${backup_status_text} ago"
  elif $backup_ok; then
    report+=$'\n'"⚠️ Backup: not configured"
    ((warn_count+=1))
  else
    report+=$'\n'"⚠️ Backup: issues detected"
    ((warn_count+=1))
  fi

  # Maintenance (from own stack state dir)
  maint_file="${STATE_DIR}/host-health/maintenance.json"
  if [[ -f "$maint_file" ]]; then
    maint_age_seconds=$(( $(date +%s) - $(stat -c %Y "$maint_file" 2>/dev/null || echo 0) ))
    maint_age_hours=$(( maint_age_seconds / 3600 ))
    if (( maint_age_hours > 26 )); then
      report+=$'\n'$'\n'"⚠️ Maintenance: data stale (${maint_age_hours}h old)"
      ((warn_count+=1))
    else
      security_updates=$(python3 -c "import json; d=json.load(open('${maint_file}')); print(d.get('security_updates', 0))" 2>/dev/null || echo "?")
      total_upgradable=$(python3 -c "import json; d=json.load(open('${maint_file}')); print(d.get('total_upgradable', 0))" 2>/dev/null || echo "?")
      reboot_required=$(python3 -c "import json; d=json.load(open('${maint_file}')); print(d.get('reboot_required', False))" 2>/dev/null || echo "?")
      failed_services=$(python3 -c "import json; d=json.load(open('${maint_file}')); print(d.get('failed_services', 'none'))" 2>/dev/null || echo "?")
      uptime_days=$(python3 -c "import json; d=json.load(open('${maint_file}')); print(d.get('uptime_days', '?'))" 2>/dev/null || echo "?")

      report+=$'\n'$'\n'"<b>Maintenance:</b>"
      if [[ "$security_updates" != "0" && "$security_updates" != "?" ]]; then
        report+=$'\n'"⚠️ Security updates: ${security_updates}"
        ((warn_count+=1))
      else
        report+=$'\n'"✅ Security updates: ${security_updates}"
      fi
      report+=$'\n'"📦 Packages upgradable: ${total_upgradable}"
      if [[ "$reboot_required" == "True" ]]; then
        report+=$'\n'"⚠️ Reboot required: yes"
        ((warn_count+=1))
      else
        report+=$'\n'"✅ Reboot required: no"
      fi
      if [[ "$failed_services" != "none" && "$failed_services" != "?" ]]; then
        report+=$'\n'"⚠️ Failed services: ${failed_services}"
        ((warn_count+=1))
      else
        report+=$'\n'"✅ Failed services: none"
      fi
      report+=$'\n'"⏳ Uptime: ${uptime_days}d"
    fi
  else
    report+=$'\n'$'\n'"ℹ️ Maintenance: no data (checker not yet run)"
  fi

  # Security (host_security.sh --telegram). The section fits in what is left of Telegram's 4096 chars.
  security_report="${SECURITY_REPORT:-auto}"
  if [[ "$security_report" == auto ]]; then
    [[ -f "${SECURITY_SCRIPT:-${INSTALL_DIR}/plugins/cron/host-status/host_security.sh}" ]] && security_report=true || security_report=false
  fi
  if [[ "$security_report" == true ]]; then
    security_section "${#report}"
    report+=$'\n'$'\n'"${SECURITY_SECTION}"
    warn_count=$(( warn_count + SECURITY_ISSUES ))
  fi

  report+=$'\n'$'\n'"⏱ Uptime: ${uptime_str}"
  if (( warn_count > 0 )); then
    report+=$'\n'"⚡ ${warn_count} issue(s) need attention"
  fi

  response=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" -d "parse_mode=HTML" --data-urlencode "text=${report}")
  if echo "$response" | grep -q '"ok":true'; then
    exit 0
  else
    echo "Telegram send failed: $response" >&2
    exit 1
  fi
fi

# --- Normal alert mode: only alert on state change ---
# Outbound sampler runs on exit (after the alert work), whatever path the script exits by.
trap 'security_sample' EXIT
if ! $TELEGRAM_CONFIGURED; then exit 0; fi
access_alerts

current_state=$(printf '%s\n' "${alerts[@]}" 2>/dev/null | sort | md5sum | cut -d' ' -f1)
previous_state=$(cat "$STATE_FILE" 2>/dev/null || echo "none")
[[ "$current_state" == "$previous_state" ]] && exit 0
echo "$current_state" > "$STATE_FILE"

if (( ${#alerts[@]} == 0 )); then
  message="VPS Recovery: ✅ All checks passed"
else
  message="VPS Alert:
$(printf '  - %s\n' "${alerts[@]}")"
fi

hostname=$(hostname)
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" -d "text=${hostname}: ${message}" -d "parse_mode=HTML" \
  | grep -q '"ok":true' || echo "$(date): Telegram alert send failed" >&2

exit 0
