#!/bin/bash
# backup.sh — Generic stack backup script.
# Reads config from ${CONFIG_DIR}/backup/config (INI format).
# Creates tar archives in DESTINATION.
# Writes state to ${STATE_DIR}/backup/last-run.json.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:?INSTALL_DIR not set}"
CONFIG_DIR="${CONFIG_DIR:?CONFIG_DIR not set}"
STATE_DIR="${STATE_DIR:?STATE_DIR not set}"

CONFIG_FILE="${CONFIG_DIR}/backup/config"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "$(date): No backup config at ${CONFIG_FILE}" >&2
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# ── Parse global config ──────────────────────────────────────────────────────
DESTINATION=""
GLOBAL_RETENTION_DAYS=30

while IFS='=' read -r key value; do
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${key// /}" ]] && continue
  key="${key// /}"
  value="${value#"${value%%[![:space:]]*}"}"
  [[ "$key" == \[* ]] && break
  case "$key" in
    DESTINATION) DESTINATION="$value" ;;
    RETENTION_DAYS) GLOBAL_RETENTION_DAYS="$value" ;;
  esac
done < "$CONFIG_FILE"

if [[ -z "$DESTINATION" ]]; then
  echo "$(date): DESTINATION not set in backup config" >&2
  exit 1
fi

# Archives can hold secrets (configs, OAuth tokens) — keep them owner-only.
mkdir -p -m 700 "$DESTINATION"
chmod 700 "$DESTINATION"

# ── Run backup for a single set ──────────────────────────────────────────────
sets_json=""
overall_ok=true

run_set() {
  local set_name="$1" ret_days="$2" ret_count="$3"
  shift 3
  local set_sources=("$@")

  local archive="${DESTINATION}/${set_name}_${TIMESTAMP}.tar.gz"
  local status="ok"
  local size=0

  # Expand globs (intentionally unquoted for glob expansion)
  # Absolute paths used as-is, relative paths prefixed with INSTALL_DIR
  local existing=()
  for src in "${set_sources[@]}"; do
    if [[ "$src" == /* ]]; then
      for expanded in ${src}; do
        [[ -e "$expanded" ]] && existing+=("$expanded")
      done
    else
      for expanded in ${INSTALL_DIR}/${src}; do
        [[ -e "$expanded" ]] && existing+=("$expanded")
      done
    fi
  done

  if [[ ${#existing[@]} -eq 0 ]]; then
    echo "$(date): [${set_name}] WARNING — no matching files"
    status="empty"
  else
    if (umask 077; tar -czf "$archive" "${existing[@]}") 2>/dev/null; then
      if tar -tzf "$archive" >/dev/null 2>&1; then
        size=$(stat -c %s "$archive" 2>/dev/null || stat -f %z "$archive" 2>/dev/null || echo 0)
        echo "$(date): [${set_name}] OK — $(basename "$archive") ($(( size / 1024 ))KB)"
      else
        echo "$(date): [${set_name}] FAILED — archive corrupt" >&2
        status="failed"
        overall_ok=false
      fi
    else
      echo "$(date): [${set_name}] FAILED — tar error" >&2
      status="failed"
      overall_ok=false
    fi
  fi

  # Cleanup old archives
  if [[ -n "$ret_count" ]]; then
    local count=0
    while IFS= read -r old; do
      count=$((count + 1))
      [[ $count -gt $ret_count ]] && rm -f "$old"
    done < <(ls -t "${DESTINATION}/${set_name}_"*.tar.gz 2>/dev/null)
  else
    find "$DESTINATION" -name "${set_name}_*.tar.gz" -mtime +"${ret_days}" -delete 2>/dev/null || true
  fi

  # Append to JSON
  [[ -n "$sets_json" ]] && sets_json+=","
  sets_json+="\"${set_name}\": { \"status\": \"${status}\", \"archive\": \"$(basename "$archive")\", \"size_bytes\": ${size} }"
}

# ── Parse sections ────────────────────────────────────────────────────────────
current_set=""
sources=()
retention_days="$GLOBAL_RETENTION_DAYS"
retain_count=""

flush_set() {
  if [[ -n "$current_set" && ${#sources[@]} -gt 0 ]]; then
    run_set "$current_set" "$retention_days" "$retain_count" "${sources[@]}"
  fi
}

while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// /}" ]] && continue

  if [[ "$line" =~ ^\[([^\]]+)\] ]]; then
    flush_set
    current_set="${BASH_REMATCH[1]}"
    sources=()
    retention_days="$GLOBAL_RETENTION_DAYS"
    retain_count=""
    continue
  fi

  if [[ -n "$current_set" ]]; then
    IFS='=' read -r key value <<< "$line"
    key="${key// /}"
    value="${value#"${value%%[![:space:]]*}"}"
    case "$key" in
      SOURCE) sources+=("$value") ;;
      RETENTION_DAYS) retention_days="$value" ;;
      RETAIN_COUNT) retain_count="$value" ;;
    esac
  fi
done < "$CONFIG_FILE"
flush_set

# ── Write state ───────────────────────────────────────────────────────────────
state_dir="${STATE_DIR}/backup"
mkdir -p "$state_dir"
cat > "${state_dir}/last-run.json" <<ENDJSON
{
  "timestamp": "$(date -Iseconds)",
  "sets": { ${sets_json} }
}
ENDJSON

if $overall_ok; then
  echo "$(date): Backup complete"
else
  echo "$(date): Backup completed with errors" >&2
  exit 1
fi
