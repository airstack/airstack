#!/bin/bash
# report.sh — layout of the daily Telegram report (sourced by host_alerter.sh --report).
#
# The report has four blocks:
#   1. Header     title (REPORT_TITLE), host + IP, disk and RAM size, uptime
#   2. Problems   one entry per problem: a bold title, indented detail lines, a "🔧" fix line
#   3. Overview   one line per area: Disk, Memory, Security ("✅ Disk good: …")
#   4. Passed     "✅ N checks passed: names" (REPORT_FULL=true lists every check and the details)
#
# Portable bash (3.2+): the tests run these functions on macOS. Parallel arrays, no namerefs.

rep_title=(); rep_detail=(); rep_fix=(); rep_icon=()   # problems
rep_pass=()                                            # names of passed checks
rep_pass_lines=()                                      # full ✅ lines (REPORT_FULL)

# report_problem ICON TITLE [DETAIL] [FIX]   (DETAIL may hold several lines)
report_problem() {
  rep_icon+=("$1"); rep_title+=("$2"); rep_detail+=("${3:-}"); rep_fix+=("${4:-$(fix_for "$2")}")
}

# report_pass LINE   ("✅ Disk: 12% of 290 GB" -> name "Disk")
report_pass() {
  local n="${1#✅ }"
  rep_pass+=("${n%%:*}")
  rep_pass_lines+=("$1")
}

# report_line LINE — a check line from another script ("⚠️ Title: detail" or "✅ Title: detail").
# host_security.sh escapes its lines for Telegram HTML; undo that here (render escapes once).
report_line() {
  local line icon rest title detail
  line=$(printf '%s' "$1" | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e 's/&amp;/\&/g')
  case "$line" in
    ✅*) report_pass "$line"; return 0 ;;
    ⚠️*) icon="⚠️"; rest="${line#⚠️}" ;;
    ❌*) icon="❌"; rest="${line#❌}" ;;
    *) icon="⚠️"; rest="$line" ;;
  esac
  rest="${rest# }"
  title="${rest%%: *}"
  detail=""
  [[ "$rest" == *": "* ]] && detail="${rest#*: }"
  report_problem "$icon" "$title" "$(nicer_detail "$detail")"
}

# "since last run: removed: X" -> "Removed since last run: X" (same for added / changed).
nicer_detail() {
  local d="$1" what
  for what in added removed changed; do
    if [[ "$d" == "since last run: ${what}: "* ]]; then
      local first; first=$(printf '%s' "${what:0:1}" | tr '[:lower:]' '[:upper:]')
      printf '%s' "${first}${what:1} since last run: ${d#since last run: ${what}: }"
      return 0
    fi
  done
  printf '%s' "$d"
}

# The fix for a problem title. Empty = no fix line.
fix_for() {
  case "$1" in
    "Security updates"*) printf '%s' 'sudo apt-get update && sudo apt-get upgrade' ;;
    "Reboot required"*) printf '%s' 'sudo reboot (at a quiet time)' ;;
    "Failed services"*) printf '%s' 'systemctl --failed, then journalctl -u <service>' ;;
    "Disk"*|"Free space"*|"Space on"*) printf '%s' 'sudo docker system df; sudo du -xh / --max-depth=2 | sort -h | tail' ;;
    "Inodes"*) printf '%s' 'find the folder with many small files: sudo du -x --inodes / --max-depth=3 | sort -n | tail' ;;
    "Memory"*) printf '%s' 'ps aux --sort=-%mem | head' ;;
    "Load"*) printf '%s' 'ps aux --sort=-%cpu | head' ;;
    "Docker"*) printf '%s' 'sudo systemctl restart docker' ;;
    "Backup"*) printf '%s' 'sudo tail -20 <stack dir>/logs/backup.log' ;;
    "Tunnel"*|"Cloudflared"*|"cloudflared"*) printf '%s' 'airstack machine logs machine cloudflared' ;;
    "Tailscale"*) printf '%s' 'sudo tailscale status; then sudo tailscale set --netfilter-mode=nodivert' ;;
    "Cloudflare Access"*) printf '%s' 'add an Access application for the hostname (Zero Trust > Access), or list it in access.exempt' ;;
    "Firewall"*) printf '%s' 'sudo ufw status verbose' ;;
    "SSH"*|"Failed logins"*) printf '%s' 'sudo sshd -T | grep -Ei "^(port|permitrootlogin|passwordauthentication)"' ;;
    "Keys, sudoers, services"*) printf '%s' 'nothing, if you made this change: the next run accepts it' ;;
    *": restarting"|*": stopped"|"Unexpected restarting"*) printf '%s' 'airstack machine status, then airstack machine logs <unit>' ;;
    *) printf '' ;;
  esac
}

# wrap_list MAXLEN WORD... — the words on lines of at most MAXLEN chars, max 2 lines, then "+N".
wrap_list() {
  local max="$1" line="" lines=() w placed=0 total
  shift
  total=$#
  for w in "$@"; do
    if [[ -n "$line" && $(( ${#line} + 1 + ${#w} )) -gt $max ]]; then
      lines+=("$line"); line=""
      if (( ${#lines[@]} >= 2 )); then break; fi
    fi
    line="${line:+$line }$w"; placed=$((placed + 1))
  done
  if [[ -n "$line" ]] && (( ${#lines[@]} < 2 )); then lines+=("$line"); fi
  if (( placed < total )); then lines[${#lines[@]}-1]="${lines[${#lines[@]}-1]} +$((total - placed))"; fi
  printf '%s\n' "${lines[@]}"
}

# Escape text for Telegram HTML.
tg_esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# report_render TITLE HOSTLINE SIZELINE — prints the message (Telegram HTML).
# Uses: rep_* arrays, REPORT_OVERVIEW (lines), REPORT_DETAILS (lines), REPORT_FULL.
report_render() {
  local i n="${#rep_title[@]}" d
  printf '<b>%s — Daily Status</b>\n' "$(tg_esc "$1")"
  printf '%s\n%s\n\n' "$(tg_esc "$2")" "$(tg_esc "$3")"
  if (( n > 0 )); then printf '<b>⚡ %s need attention</b>\n' "$n"; else printf '<b>✅ All checks passed</b>\n'; fi
  for (( i = 0; i < n; i++ )); do
    printf '\n%s <b>%s</b>\n' "${rep_icon[$i]}" "$(tg_esc "${rep_title[$i]}")"
    if [[ -n "${rep_detail[$i]}" ]]; then
      while IFS= read -r d; do [[ -n "$d" ]] && printf '   %s\n' "$(tg_esc "$d")"; done <<<"${rep_detail[$i]}"
    fi
    [[ -n "${rep_fix[$i]}" ]] && printf '   🔧 <code>%s</code>\n' "$(tg_esc "${rep_fix[$i]}")"
  done
  if [[ -n "${REPORT_OVERVIEW:-}" ]]; then
    printf '\n───\n'
    printf '%s\n' "$REPORT_OVERVIEW"
  fi
  printf '───\n'
  if [[ "${REPORT_FULL:-false}" == true ]]; then
    for d in ${rep_pass_lines[@]+"${rep_pass_lines[@]}"}; do printf '%s\n' "$(tg_esc "$d")"; done
    if [[ -n "${REPORT_DETAILS:-}" ]]; then printf '\n<b>Details</b>\n%s\n' "$REPORT_DETAILS"; fi
  elif (( ${#rep_pass[@]} > 0 )); then
    local names="" p
    for p in "${rep_pass[@]}"; do names+="${names:+, }$p"; done
    printf '✅ %s checks passed: %s\n' "${#rep_pass[@]}" "$(tg_esc "$names")"
  fi
}
