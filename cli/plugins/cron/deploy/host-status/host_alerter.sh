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
# Memory samples (the 15-minute run adds one; the report shows the 24-hour average).
MEM_SAMPLES="${STATE_DIR}/host-health/mem-samples"
mem_avg_used() { awk -v now="$(date +%s)" '$1 >= now - 86400 { s += $2; n++ } END { if (n) printf "%d", s / n }' "$MEM_SAMPLES" 2>/dev/null || true; }
mem_record() {
  mkdir -p "$(dirname "$MEM_SAMPLES")" 2>/dev/null || return 0
  { tail -n 200 "$MEM_SAMPLES" 2>/dev/null; echo "$(date +%s) $mem_pct"; } > "$MEM_SAMPLES.new" && mv -f "$MEM_SAMPLES.new" "$MEM_SAMPLES"
}
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
backup_problems=()
for manifest in "${STACKS_MANIFEST_DIR}"/*.env; do
  [ -f "$manifest" ] || continue
  health_check=$(get_manifest_value "$manifest" BACKUP_HEALTH_CHECK)
  [ -n "$health_check" ] && [ -x "$health_check" ] || continue
  stack_state_dir=$(get_manifest_value "$manifest" STATE_DIR)
  stack_name=$(get_manifest_value "$manifest" PROJECT_NAME)
  result=$(STATE_DIR="$stack_state_dir" "$health_check" 2>/dev/null) || true
  case "$result" in
    OK*) backup_status_text="${result#OK }" ;;
    STALE*) alerts+=("⚠️ Backup stale for ${stack_name}: ${result}"); backup_problems+=("${stack_name}: stale (${result#STALE })"); backup_ok=false ;;
    MISSING*) alerts+=("⚠️ No backup data for ${stack_name}"); backup_problems+=("${stack_name}: no backup yet"); backup_ok=false ;;
    FAILED*) alerts+=("⚠️ Backup failed for ${stack_name}: ${result}"); backup_problems+=("${stack_name}: failed (${result#FAILED })"); backup_ok=false ;;
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

# >>> access-guard (tests run this block alone)
# A key from the manifest of the unit that runs cloudflared (the one with CF_CONTAINER).
cf_setting() {  # KEY
  local m
  for m in "$STACKS_MANIFEST_DIR"/*.env; do
    [[ -f "$m" ]] || continue
    [[ -n "$(get_manifest_value "$m" CF_CONTAINER)" ]] || continue
    get_manifest_value "$m" "$1"
    return 0
  done
  return 1
}

# Cloudflare Access guard for the 15-minute run: each FAIL/WARN line of `host_security.sh --access`
# becomes an alert, so a route that loses Access protection alerts within 15 minutes (and recovers).
# With access.onScan: stop (CF_ACCESS_ON_SCAN=stop), a definite FAIL also stops the cloudflared
# container. A flag file keeps the "tunnel stopped" alert steady until a deploy starts it again.
# SECURITY_ACCESS_ALERTS=false turns it off. Best effort: never changes this script's exit status.
ACCESS_STOP_FLAG="${STATE_DIR}/host-health/access-stopped"
access_alerts() {
  [[ "${SECURITY_ACCESS_ALERTS:-true}" == true ]] || return 0
  local script="${SECURITY_SCRIPT:-${INSTALL_DIR}/plugins/cron/host-status/host_security.sh}"
  local out line container on_scan fails=()
  [[ -f "$script" ]] || return 0
  container=$(cf_setting CF_CONTAINER) || container=""
  on_scan=$(cf_setting CF_ACCESS_ON_SCAN) || on_scan=""

  # The guard stopped the tunnel earlier: report that until the container runs again (a deploy).
  if [[ -f "$ACCESS_STOP_FLAG" ]]; then
    if [[ -n "$container" ]] && [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" == true ]]; then
      rm -f "$ACCESS_STOP_FLAG"
    else
      alerts+=("🛑 Cloudflare tunnel stopped by the Access guard: $(cat "$ACCESS_STOP_FLAG"). Protect the route, then deploy again.")
      return 0
    fi
  fi

  if command -v timeout >/dev/null 2>&1; then
    out=$(timeout -k 2 60 bash "$script" --access 2>/dev/null) || true
  else
    out=$(bash "$script" --access 2>/dev/null) || true
  fi
  while IFS= read -r line; do
    case "$line" in
      FAIL\|access\|*) fails+=("${line#FAIL|access|}") ;;
      WARN\|access\|*) alerts+=("Cloudflare Access (unverified): ${line#WARN|access|}") ;;
    esac
  done <<<"$out"
  (( ${#fails[@]} > 0 )) || return 0

  if [[ "$on_scan" == stop && -n "$container" ]] && docker stop "$container" >/dev/null 2>&1; then
    mkdir -p "$(dirname "$ACCESS_STOP_FLAG")"
    printf '%s' "$(join_lines "${fails[@]%% (*}")" >"$ACCESS_STOP_FLAG"
    alerts+=("🛑 Cloudflare tunnel stopped by the Access guard: $(cat "$ACCESS_STOP_FLAG"). Protect the route, then deploy again.")
    return 0
  fi
  for line in "${fails[@]}"; do alerts+=("Cloudflare Access: $line"); done
  [[ "$on_scan" == stop ]] && alerts+=("Cloudflare Access: could not stop the tunnel container '${container:-unknown}'")
  return 0
}
join_lines() { local IFS=';'; printf '%s' "$*" | sed 's/;/; /g'; }
# <<< access-guard

# >>> report-format (tests run this block alone)
# Telegram HTML -> plain text (REPORT_OUTPUT=stdout).
html_to_text() { sed -e 's/<[^>]*>//g' -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e 's/&amp;/\&/g'; }
# <<< report-format

# --- Telegram config ---
TELEGRAM_CONFIGURED=false
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  TELEGRAM_CONFIGURED=true
fi

# --- Report mode ---
if $REPORT_MODE; then
  if ! $TELEGRAM_CONFIGURED && [[ "${REPORT_OUTPUT:-telegram}" != stdout ]]; then exit 0; fi

  hostname=$(hostname)
  uptime_str=$(uptime -p 2>/dev/null | sed 's/^up //' || uptime | awk -F'( |,)' '{print $2}')
  container_total=0; container_running=0
  if $docker_ok; then
    container_total=$(docker ps -a --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
    container_running=$(docker ps --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
  fi

  # Layout and fix hints: plugins/cron/lib/report.sh. Problems get a title, detail lines and a fix;
  # passed checks become one summary line (REPORT_FULL=true: every check plus the details).
  source "${INSTALL_DIR}/plugins/cron/lib/report.sh"
  details=()
  disk_free_pct=$(( 100 - disk_pct ))

  if (( disk_pct > DISK_THRESHOLD )); then
    report_problem "⚠️" "Disk ${disk_pct}% used of ${disk_total_gb} GB" "limit ${DISK_THRESHOLD}%"
  else
    report_pass "✅ Disk: ${disk_pct}% of ${disk_total_gb} GB"
  fi
  if (( DISK_FREE_MIN_GB > 0 )); then
    if (( disk_free_gb < DISK_FREE_MIN_GB )); then
      report_problem "⚠️" "Free space low: ${disk_free_gb} GB on /" "minimum ${DISK_FREE_MIN_GB} GB"
    else
      report_pass "✅ Free space: ${disk_free_gb} GB on /"
    fi
  fi
  inode_bad=false
  for m in "${!seen_mounts[@]}"; do
    read -r target space_used inode_free < <(mount_stats "$m")
    if (( inode_free < INODE_FREE_MIN_PCT )); then
      inode_bad=true
      report_problem "⚠️" "Inodes low on $target: ${inode_free}% free" "minimum ${INODE_FREE_MIN_PCT}%"
    else
      report_pass "✅ Inodes on $target: ${inode_free}% free"
    fi
  done
  if (( mem_pct > MEMORY_THRESHOLD )); then
    report_problem "⚠️" "Memory ${mem_pct}% used of ${mem_total_gb} GB" "limit ${MEMORY_THRESHOLD}%"
  else
    report_pass "✅ Memory: ${mem_pct}% of ${mem_total_gb} GB"
  fi
  if (( load_int >= cpu_count )); then
    report_problem "⚠️" "Load ${load_avg} on ${cpu_count} CPUs"
  else
    report_pass "✅ Load: ${load_avg} / ${cpu_count} CPUs"
  fi
  if $docker_ok; then report_pass "✅ Docker"; else report_problem "❌" "Docker does not respond"; fi
  if $docker_ok; then
    if $containers_all_ok; then
      report_pass "✅ Containers: ${container_running}/${container_total} running"
    else
      while IFS= read -r expected; do
        [ -n "$expected" ] || continue
        if echo "$restarting" | grep -qx "$expected" 2>/dev/null; then report_problem "❌" "${expected}: restarting"
        elif ! echo "$running" | grep -qx "$expected" 2>/dev/null; then report_problem "❌" "${expected}: stopped"; fi
      done < <(all_expected_containers)
      details+=("• Containers: ${container_running}/${container_total} running")
    fi
  else
    report_problem "⚠️" "Containers: unknown (Docker is down)"
  fi
  [[ -n "$crashed" ]] && report_problem "⚠️" "Unexpected restarting: ${crashed}"

  if $backup_ok && [[ -n "$backup_status_text" ]]; then
    report_pass "✅ Backup: ${backup_status_text} ago"
  elif $backup_ok; then
    details+=("• Backup: no stack on this machine uses the backup plugin")
  else
    report_problem "⚠️" "Backup" "$(printf '%s\n' "${backup_problems[@]}")"
  fi

  # Maintenance (written daily by host_maintenance.sh)
  maint_file="${STATE_DIR}/host-health/maintenance.json"
  jget() { jq -r "$1 // empty" "$maint_file" 2>/dev/null; }
  if [[ ! -f "$maint_file" ]]; then
    details+=("• Maintenance: no data yet (the daily checker has not run)")
  elif (( ( $(date +%s) - $(stat -c %Y "$maint_file" 2>/dev/null || echo 0) ) / 3600 > 26 )); then
    report_problem "⚠️" "Maintenance data is stale" "host_maintenance has not run for more than a day"
  else
    security_updates=$(jget .security_updates); security_updates="${security_updates:-0}"
    if [[ "$security_updates" != 0 ]]; then
      pkgs=$(jget .security_packages)
      pkg_detail=""
      [[ -n "$pkgs" ]] && pkg_detail=$(wrap_list 56 $pkgs | sed '1s/^/apt: /; 2,$s/^/     /')
      report_problem "⚠️" "Security updates pending: ${security_updates}" "$pkg_detail"
    else
      report_pass "✅ Security updates: none pending"
    fi
    details+=("• Packages upgradable: $(jget .total_upgradable)")
    if [[ "$(jget .reboot_required)" == true ]]; then report_problem "⚠️" "Reboot required"; else report_pass "✅ Reboot required: no"; fi
    failed=$(jget .failed_services)
    if [[ -n "$failed" && "$failed" != none ]]; then report_problem "⚠️" "Failed services" "$(wrap_list 56 ${failed//,/ })"; else report_pass "✅ Failed services: none"; fi
  fi

  # Security (host_security.sh --telegram): CHECK lines join the checks, INFO lines the details.
  security_report="${SECURITY_REPORT:-auto}"
  if [[ "$security_report" == auto ]]; then
    [[ -f "${SECURITY_SCRIPT:-${INSTALL_DIR}/plugins/cron/host-status/host_security.sh}" ]] && security_report=true || security_report=false
  fi
  sec_problems=0; sec_checks=0
  if [[ "$security_report" == true ]]; then
    security_section 600
    before=${#rep_title[@]}
    while IFS= read -r line; do
      case "$line" in
        CHECK\|*) report_line "${line#CHECK|}"; sec_checks=$((sec_checks + 1)) ;;
        INFO\|*) details+=("${line#INFO|}") ;;
        "") ;;
        *) report_line "$line"; sec_checks=$((sec_checks + 1)) ;;
      esac
    done <<<"$SECURITY_SECTION"
    sec_problems=$(( ${#rep_title[@]} - before ))
  fi

  # Overview: one line per area.
  disk_icon="✅"; disk_word="good"
  if (( disk_pct > DISK_THRESHOLD )) || $inode_bad || (( DISK_FREE_MIN_GB > 0 && disk_free_gb < DISK_FREE_MIN_GB )); then disk_icon="⚠️"; disk_word="low"; fi
  mem_free_pct=$(( 100 - mem_pct ))
  mem_avg=$(mem_avg_used)
  mem_note="${mem_free_pct}% free"
  [[ -n "$mem_avg" ]] && mem_note+=", 24 h average $(( 100 - mem_avg ))% free"
  mem_icon="✅"; mem_word="good"
  if (( mem_pct > MEMORY_THRESHOLD )); then mem_icon="⚠️"; mem_word="high"; fi
  REPORT_OVERVIEW="${disk_icon} Disk ${disk_word}: ${disk_free_pct}% free of ${disk_total_gb} GB"$'\n'"${mem_icon} Memory ${mem_word}: ${mem_note}"
  if [[ "$security_report" == true ]]; then
    if (( sec_problems == 0 )); then REPORT_OVERVIEW+=$'\n'"✅ Security good: ${sec_checks} checks (firewall, SSH, accounts, …)"
    else REPORT_OVERVIEW+=$'\n'"⚠️ Security: ${sec_problems} of ${sec_checks} checks need attention"; fi
  fi
  REPORT_DETAILS=$(printf '%s\n' ${details[@]+"${details[@]}"} "⏱ Uptime: ${uptime_str}")

  # Header: which machine this is (several machines can report to one chat).
  title="${REPORT_TITLE:-📊 ${hostname}}"
  ip=""
  [[ "${REPORT_SHOW_IP:-true}" == true ]] && ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
  host_line="Host: ${hostname}${ip:+ · $ip}"
  size_line="${disk_total_gb} GB disk · ${mem_total_gb} GB RAM · ⏱ up ${uptime_str}"
  report=$(report_render "$title" "$host_line" "$size_line")

  if [[ "${REPORT_OUTPUT:-telegram}" == stdout ]]; then
    printf '%s\n' "$report" | html_to_text
    exit 0
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
mem_record || true
access_alerts   # before the Telegram check: onScan: stop must work without Telegram
if ! $TELEGRAM_CONFIGURED; then exit 0; fi

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
  -d "chat_id=${TELEGRAM_CHAT_ID}" -d "text=${REPORT_TITLE:-$hostname}: ${message}" -d "parse_mode=HTML" \
  | grep -q '"ok":true' || echo "$(date): Telegram alert send failed" >&2

exit 0
