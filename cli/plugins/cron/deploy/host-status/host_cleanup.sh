#!/bin/bash
# Host cleanup — frees disk, inodes and /tmp space. Runs as root from cron.
#
# Linux-only: needs GNU find/sort/df (find -printf, df --output, flock).
#
# Usage:
#   host_cleanup.sh              Full run: Docker images/build cache, apt cache, journal, user caches, /tmp guard
#   host_cleanup.sh --tmp-only   Only the /tmp guard (cheap; meant to run often)
#   host_cleanup.sh --dry-run    Log what would be deleted; delete nothing (also CLEANUP_DRY_RUN=true)
#
# What it NEVER touches: Docker volumes, containers (even stopped ones), git worktrees,
# project folders, ~/.claude, ~/.codex, anything not listed below. Add paths only
# through the knobs.
#
# Knobs (environment; cron `env:` in the fleet config). Defaults in brackets.
#
#   Docker
#     CLEANUP_DOCKER=true                 [true]   prune unused images + build cache
#     CLEANUP_DOCKER_HOSTS=...            [unix:///var/run/docker.sock]  space-separated daemons;
#                                                  add rootless sockets, e.g. unix:///run/user/1002/docker.sock
#     CLEANUP_DOCKER_UNTIL=168h           [168h]   only things created longer ago than this
#   Caches and logs
#     CLEANUP_APT=true                    [true]   apt-get clean
#     CLEANUP_JOURNAL_MAX=500M            [500M]   journalctl --vacuum-size (empty = skip)
#     CLEANUP_CACHE_DIRS="..."            [see below] space-separated dirs/globs; files unused longer than the age are removed
#     CLEANUP_CACHE_MAX_AGE_DAYS=14       [14]
#   /tmp guard (off by default)
#     TMP_PRUNE=true                      [false]  turn the guard on
#     TMP_DIRS="/tmp"                     [/tmp]   space-separated; each is handled on its own filesystem
#     TMP_TRIGGER_INODE_FREE_PCT=20       [20]     start when free inodes drop below this %
#     TMP_TRIGGER_SPACE_FREE_PCT=20       [20]     start when free space drops below this %
#     TMP_TARGET_FREE_PCT=50              [50]     keep deleting (oldest first) until BOTH are at least this % free
#     TMP_MAX_AGE_DAYS=7                  [7]      when triggered, first delete everything older than this
#     TMP_MIN_AGE_MINUTES=60              [60]     never delete anything newer than this, even to reach the target
#     TMP_EXCLUDE="..."                   [see below] top-level names to leave alone (globs)
#     TMP_BATCH=100                       [100]    files deleted between free-space checks in the oldest-first phase
#
# Test hooks: DF_CMD (default df) replaces the df binary.
set -euo pipefail

DRY_RUN="${CLEANUP_DRY_RUN:-false}"
TMP_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --tmp-only) TMP_ONLY=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

CLEANUP_DOCKER="${CLEANUP_DOCKER:-true}"
CLEANUP_DOCKER_HOSTS="${CLEANUP_DOCKER_HOSTS:-unix:///var/run/docker.sock}"
CLEANUP_DOCKER_UNTIL="${CLEANUP_DOCKER_UNTIL:-168h}"
CLEANUP_APT="${CLEANUP_APT:-true}"
CLEANUP_JOURNAL_MAX="${CLEANUP_JOURNAL_MAX-500M}"
CLEANUP_CACHE_DIRS="${CLEANUP_CACHE_DIRS-/home/*/.npm/_cacache /home/*/.cache/uv /home/*/.cache/pip /home/*/.cache/pre-commit}"
CLEANUP_CACHE_MAX_AGE_DAYS="${CLEANUP_CACHE_MAX_AGE_DAYS:-14}"

TMP_PRUNE="${TMP_PRUNE:-false}"
TMP_DIRS="${TMP_DIRS:-/tmp}"
TMP_TRIGGER_INODE_FREE_PCT="${TMP_TRIGGER_INODE_FREE_PCT:-20}"
TMP_TRIGGER_SPACE_FREE_PCT="${TMP_TRIGGER_SPACE_FREE_PCT:-20}"
TMP_TARGET_FREE_PCT="${TMP_TARGET_FREE_PCT:-50}"
TMP_MAX_AGE_DAYS="${TMP_MAX_AGE_DAYS:-7}"
TMP_MIN_AGE_MINUTES="${TMP_MIN_AGE_MINUTES:-60}"
TMP_BATCH="${TMP_BATCH:-100}"
TMP_EXCLUDE="${TMP_EXCLUDE-systemd-private-* .X11-unix .ICE-unix .font-unix .XIM-unix .Test-unix snap-private-tmp ssh-* tmux-* *.sock}"
DF_CMD="${DF_CMD:-df}"

log() { printf '%s host_cleanup: %s\n' "$(date -Is)" "$*"; }

# Validate numbers early: a typo in a knob must not turn into a wrong delete.
for v in TMP_TRIGGER_INODE_FREE_PCT TMP_TRIGGER_SPACE_FREE_PCT TMP_TARGET_FREE_PCT TMP_MAX_AGE_DAYS TMP_MIN_AGE_MINUTES TMP_BATCH CLEANUP_CACHE_MAX_AGE_DAYS; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || { log "ERROR: $v must be a whole number (got '${!v}')"; exit 2; }
done
if (( TMP_TARGET_FREE_PCT < TMP_TRIGGER_INODE_FREE_PCT || TMP_TARGET_FREE_PCT < TMP_TRIGGER_SPACE_FREE_PCT )); then
  log "ERROR: TMP_TARGET_FREE_PCT ($TMP_TARGET_FREE_PCT) must be >= both trigger percentages"; exit 2
fi
[[ "$CLEANUP_DOCKER_UNTIL" =~ ^[0-9]+[hms]$ ]] || { log "ERROR: CLEANUP_DOCKER_UNTIL must look like 168h (got '$CLEANUP_DOCKER_UNTIL')"; exit 2; }

# One run at a time (the frequent /tmp guard and the daily run can overlap).
if command -v flock >/dev/null 2>&1; then
  exec 9>"${CLEANUP_LOCK:-/var/lock/host_cleanup.lock}"
  flock -n 9 || { log "another run is in progress; skipping"; exit 0; }
fi

# ---------------------------------------------------------------------------
# Filesystem numbers
# ---------------------------------------------------------------------------

# fs_free_pcts DIR -> "SPACE_FREE_PCT INODE_FREE_PCT" (whole numbers).
# A filesystem that reports no inode counts (some report '-') counts as 100% free.
fs_free_pcts() {
  local size avail iused iavail sp ip
  read -r size avail iused iavail < <("$DF_CMD" --output=size,avail,iused,iavail "$1" | tail -1)
  sp=100; ip=100
  if [[ "$size" =~ ^[0-9]+$ && "$avail" =~ ^[0-9]+$ ]] && (( size > 0 )); then sp=$(( avail * 100 / size )); fi
  if [[ "$iused" =~ ^[0-9]+$ && "$iavail" =~ ^[0-9]+$ ]] && (( iused + iavail > 0 )); then
    ip=$(( iavail * 100 / (iused + iavail) ))
  fi
  echo "$sp $ip"
}

root_avail_kb() { "$DF_CMD" --output=avail / | tail -1 | tr -dc '0-9'; }

# ---------------------------------------------------------------------------
# /tmp guard
# ---------------------------------------------------------------------------

# find expression pieces that skip the excluded top-level names (as args in EXCL).
build_excludes() {  # $1 dir
  EXCL=()
  local pat
  for pat in $TMP_EXCLUDE; do
    EXCL+=( ! -path "$1/$pat" ! -path "$1/$pat/*" )
  done
}

prune_tmp_dir() {  # $1 dir
  local dir="${1%/}" sp ip need=false
  [[ -n "$dir" ]] || { log "tmp: refusing to prune '$1'"; return 0; }
  [[ -d "$dir" ]] || { log "tmp: $dir does not exist; skipping"; return 0; }
  read -r sp ip < <(fs_free_pcts "$dir")
  (( ip < TMP_TRIGGER_INODE_FREE_PCT )) && need=true
  (( sp < TMP_TRIGGER_SPACE_FREE_PCT )) && need=true
  if ! $need; then
    log "tmp: $dir ok (space free ${sp}%, inodes free ${ip}%; triggers: space<${TMP_TRIGGER_SPACE_FREE_PCT}% inodes<${TMP_TRIGGER_INODE_FREE_PCT}%)"
    return 0
  fi
  log "tmp: $dir TRIGGERED (space free ${sp}%, inodes free ${ip}%); target >= ${TMP_TARGET_FREE_PCT}% free, never newer than ${TMP_MIN_AGE_MINUTES} min"

  build_excludes "$dir"
  local common=( "$dir" -xdev -mindepth 1 "${EXCL[@]}" )

  # Phase 1: everything older than TMP_MAX_AGE_DAYS (files and symlinks).
  local old
  old=$(find "${common[@]}" \( -type f -o -type l \) -mmin +"$TMP_MIN_AGE_MINUTES" -mtime +"$TMP_MAX_AGE_DAYS" -printf '.' | wc -c)
  if [[ "$DRY_RUN" == true ]]; then
    log "tmp: DRY RUN: would delete $old file(s) older than ${TMP_MAX_AGE_DAYS} days in $dir"
  else
    find "${common[@]}" \( -type f -o -type l \) -mmin +"$TMP_MIN_AGE_MINUTES" -mtime +"$TMP_MAX_AGE_DAYS" -delete
    log "tmp: phase 1 deleted $old file(s) older than ${TMP_MAX_AGE_DAYS} days"
  fi

  # Phase 2: oldest first until both numbers reach the target.
  if [[ "$DRY_RUN" != true ]]; then
    read -r sp ip < <(fs_free_pcts "$dir")
    if (( sp < TMP_TARGET_FREE_PCT || ip < TMP_TARGET_FREE_PCT )); then
      log "tmp: phase 2: still space ${sp}% / inodes ${ip}% free; deleting oldest first"
      local ts path batch=() removed=0 stop=false
      while IFS=$'\t' read -r -d '' ts path; do
        batch+=( "$path" )
        if (( ${#batch[@]} >= TMP_BATCH )); then
          rm -f -- "${batch[@]}"; removed=$(( removed + ${#batch[@]} )); batch=()
          read -r sp ip < <(fs_free_pcts "$dir")
          if (( sp >= TMP_TARGET_FREE_PCT && ip >= TMP_TARGET_FREE_PCT )); then stop=true; break; fi
        fi
      done < <(find "${common[@]}" \( -type f -o -type l \) -mmin +"$TMP_MIN_AGE_MINUTES" -printf '%T@\t%p\0' | sort -z -n)
      if ! $stop && (( ${#batch[@]} > 0 )); then
        rm -f -- "${batch[@]}"; removed=$(( removed + ${#batch[@]} ))
      fi
      log "tmp: phase 2 deleted $removed file(s)"
    fi
    # Phase 3: empty directories left behind (they hold inodes too).
    find "${common[@]}" -depth -type d -empty -mmin +"$TMP_MIN_AGE_MINUTES" -delete 2>/dev/null || true
    read -r sp ip < <(fs_free_pcts "$dir")
    if (( sp < TMP_TARGET_FREE_PCT || ip < TMP_TARGET_FREE_PCT )); then
      log "tmp: WARNING: $dir still at space ${sp}% / inodes ${ip}% free after pruning everything older than ${TMP_MIN_AGE_MINUTES} min (files may be in active use)"
    else
      log "tmp: $dir now space free ${sp}%, inodes free ${ip}%"
    fi
  fi
}

run_tmp_guard() {
  if [[ "$TMP_PRUNE" != true ]]; then
    log "tmp: guard is off (set TMP_PRUNE=true to enable)"
    return 0
  fi
  local d
  for d in $TMP_DIRS; do prune_tmp_dir "$d"; done
}

# ---------------------------------------------------------------------------
# Full-run cleanups
# ---------------------------------------------------------------------------

run_docker() {
  [[ "$CLEANUP_DOCKER" == true ]] || return 0
  command -v docker >/dev/null 2>&1 || { log "docker: not installed; skipping"; return 0; }
  local host
  for host in $CLEANUP_DOCKER_HOSTS; do
    if ! DOCKER_HOST="$host" docker info >/dev/null 2>&1; then
      log "docker: $host not reachable; skipping"
      continue
    fi
    if [[ "$DRY_RUN" == true ]]; then
      log "docker: DRY RUN on $host: would prune unused images and build cache created more than $CLEANUP_DOCKER_UNTIL ago"
      DOCKER_HOST="$host" docker system df 2>&1 | sed 's/^/    /'
      continue
    fi
    log "docker: pruning $host (images + build cache older than $CLEANUP_DOCKER_UNTIL; never volumes or containers)"
    DOCKER_HOST="$host" docker image prune -af --filter "until=$CLEANUP_DOCKER_UNTIL" 2>&1 | tail -1 | sed 's/^/    /'
    DOCKER_HOST="$host" docker builder prune -af --filter "until=$CLEANUP_DOCKER_UNTIL" 2>&1 | tail -1 | sed 's/^/    /'
  done
}

run_apt() {
  [[ "$CLEANUP_APT" == true ]] || return 0
  command -v apt-get >/dev/null 2>&1 || return 0
  if [[ "$DRY_RUN" == true ]]; then log "apt: DRY RUN: would run apt-get clean"; return 0; fi
  apt-get clean && log "apt: cache cleaned"
}

run_journal() {
  [[ -n "$CLEANUP_JOURNAL_MAX" ]] || return 0
  command -v journalctl >/dev/null 2>&1 || return 0
  if [[ "$DRY_RUN" == true ]]; then log "journal: DRY RUN: would vacuum to $CLEANUP_JOURNAL_MAX"; return 0; fi
  journalctl --vacuum-size="$CLEANUP_JOURNAL_MAX" 2>&1 | tail -1 | sed 's/^/    /'
}

run_caches() {
  [[ -n "$CLEANUP_CACHE_DIRS" ]] || return 0
  local pattern dir n
  shopt -s nullglob
  for pattern in $CLEANUP_CACHE_DIRS; do
    for dir in $pattern; do
      [[ -d "$dir" && ! -L "$dir" ]] || continue
      n=$(find "$dir" -xdev -type f -atime +"$CLEANUP_CACHE_MAX_AGE_DAYS" -mtime +"$CLEANUP_CACHE_MAX_AGE_DAYS" -printf '.' | wc -c)
      if [[ "$DRY_RUN" == true ]]; then
        log "cache: DRY RUN: $dir would lose $n file(s) unused for ${CLEANUP_CACHE_MAX_AGE_DAYS}+ days"
      else
        find "$dir" -xdev -type f -atime +"$CLEANUP_CACHE_MAX_AGE_DAYS" -mtime +"$CLEANUP_CACHE_MAX_AGE_DAYS" -delete
        find "$dir" -xdev -mindepth 1 -depth -type d -empty -delete 2>/dev/null || true
        log "cache: $dir removed $n file(s) unused for ${CLEANUP_CACHE_MAX_AGE_DAYS}+ days"
      fi
    done
  done
  shopt -u nullglob
}

# ---------------------------------------------------------------------------

before_kb=$(root_avail_kb)
$TMP_ONLY || log "start (dry-run: $DRY_RUN); / has $(( before_kb / 1024 / 1024 )) GB free"

if $TMP_ONLY; then
  run_tmp_guard
else
  run_docker
  run_apt
  run_journal
  run_caches
  run_tmp_guard
  after_kb=$(root_avail_kb)
  log "done; / now $(( after_kb / 1024 / 1024 )) GB free (freed about $(( (after_kb - before_kb) / 1024 )) MB)"
fi
