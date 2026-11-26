#!/bin/bash
# Host maintenance checker — detects pending OS updates, required reboots, and failed services.
# Runs daily via cron. Writes maintenance.json to ${STATE_DIR}/host-health/.
#
# NOTE: Linux-only — uses /proc/uptime, apt, systemctl
#
# Runs as root (needs apt and systemctl access). No Telegram dependency.
set -euo pipefail

# Expects INSTALL_DIR, STATE_DIR etc in environment (set by cron shim via .env)
INSTALL_DIR="${INSTALL_DIR:?INSTALL_DIR not set}"
STATE_DIR="${STATE_DIR:?STATE_DIR not set}"

# --- Security updates ---
# Simulate upgrade and count packages from security sources
security_updates=0
if command -v apt-get >/dev/null 2>&1; then
  security_updates=$(apt-get -s upgrade 2>/dev/null | grep -ci "^inst.*security" || true)
fi

# --- Total upgradable packages ---
total_upgradable=0
if command -v apt >/dev/null 2>&1; then
  # apt list --upgradable outputs one header line ("Listing...") plus one line per package
  total_upgradable=$(apt list --upgradable 2>/dev/null | grep -c "upgradable" || true)
fi

# --- Reboot required ---
reboot_required=false
if [[ -f /var/run/reboot-required ]]; then
  reboot_required=true
fi

# --- Failed systemd services ---
failed_services="none"
failed_list=$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | tr '\n' ', ' | sed 's/,$//')
if [[ -n "$failed_list" ]]; then
  failed_services="$failed_list"
fi

# --- System uptime ---
uptime_seconds=$(awk '{print int($1)}' /proc/uptime)
uptime_days=$(( uptime_seconds / 86400 ))
uptime_hours=$(( (uptime_seconds % 86400) / 3600 ))

# --- Write maintenance.json to own stack ---
maintenance_json="{
  \"timestamp\": \"$(date -Iseconds)\",
  \"security_updates\": ${security_updates},
  \"total_upgradable\": ${total_upgradable},
  \"reboot_required\": ${reboot_required},
  \"failed_services\": \"${failed_services}\",
  \"uptime_seconds\": ${uptime_seconds},
  \"uptime_days\": ${uptime_days},
  \"uptime_hours\": ${uptime_hours}
}"

if [[ -n "${STATE_DIR:-}" ]]; then
  health_dir="${STATE_DIR}/host-health"
  mkdir -p "$health_dir"
  echo "$maintenance_json" > "${health_dir}/maintenance.json"
  chmod 644 "${health_dir}/maintenance.json"
fi
