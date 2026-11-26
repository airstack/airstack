#!/bin/bash
# Host security tripwire — read-only checks for the daily Telegram report, plus a cheap
# outbound-connection sampler. Runs as root from cron (via host_alerter.sh). See docs/HOST-SECURITY.md.
#
# It is a daily tripwire, not an IDS: it notices drift and obvious misconfiguration.
# Every check is read-only. The only files it writes are its own state files
# (baselines under the state dir) and, in --telegram mode, logs/host_security.log.
#
# Usage:
#   host_security.sh              Run all checks; print raw lines STATUS|label|detail
#   host_security.sh --telegram   Print the Telegram-HTML "Security" section; last line is ISSUES=<n>
#   host_security.sh --sample     Record current outbound TCP destinations (fast; for the 15-min cron)
#   host_security.sh --help
#
# Output protocol: one finding per line, STATUS|label|detail, STATUS is OK, WARN, FAIL or INFO.
# Pipes inside label/detail become '/'. Labels starting with "reachable:" form the
# "Reachable from the internet" block in the Telegram section.
#
# Knobs (environment; cron `env:` of host_alerter_report in stack.yml). Defaults in brackets.
#   SECURITY_BUILTIN=true                 [true]  false = run only the custom security.d checks
#   SECURITY_SKIP="..."                   []      space list of built-in checks to skip:
#        firewall tailscale reachability docker tunnel cloudflared ssh sshsources
#        accounts persistence secrets outbound processes updates custom
#   SECURITY_DIR=...                      [$INSTALL_DIR/security.d]  custom check scripts (*.sh, executable)
#   SECURITY_CHECK_TIMEOUT=20             [20]    seconds per custom check
#   SECURITY_PUBLIC_PORTS="222/tcp"       [sshd ports from `sshd -T` (fallback 22) + 41641/udp if tailscale]
#                                                 ports allowed to be open to the internet; "P", "P/tcp", "P/udp"
#   SECURITY_DOCKER_HOSTS="unix://..."    [unix:///var/run/docker.sock]  add rootless sockets here
#   SECURITY_HOSTNET_OK="name-glob ..."   []      host-network containers that are fine (silences the INFO)
#   SECURITY_SSH_FAIL_WARN=200            [200]   WARN above this many failed logins (connections) in 24 h
#   SECURITY_DOCKER_USERS="a b"           []      expected docker group members (unset = INFO list only)
#   SECURITY_SUDO_USERS="a b"             []      expected NOPASSWD sudo users (unset = INFO list only)
#   SECURITY_OUTBOUND_OK_PORTS="..."      [22 53 80 123 222 443 853 8443]
#   SECURITY_KNOWN_PROCS="proc ..."       []      processes pre-approved for new outbound destinations
#   SECURITY_KNOWN_REMOTES="ip ip:port"   []      remotes pre-approved (exact IP, or IP:port)
#   SECURITY_CONN_LEARN_DAYS=3            [3]     days after a baseline is created when new things are INFO only
#   SECURITY_CONN_KEEP_DAYS=90            [90]    forget outbound destinations not seen for this long
#   SECURITY_CONN_MAX=5000                [5000]  max remembered outbound destinations
#   SECURITY_EXE_OK="glob ..."            []      process executable paths that are fine (processes check)
#   SECURITY_CLOUDFLARED_METRICS_PORT     [20241]
#   SECURITY_CLOUDFLARED_MIN_CONNECTIONS  [2]     WARN below this many ready tunnel connections (0 = FAIL)
#   SECURITY_CLOUDFLARED_CONTAINERS       [*cloudflared*]  container-name globs whose logs hold the tunnel config
#   SECURITY_CLOUDFLARED_LOG_LINES        [5000]  how many log lines to search
#   SECURITY_TUNNEL_DOMAINS="a.example"   []      static hostname list used when the logs show none
#   SECURITY_EXPECT_DOMAINS="a.example"   []      WARN when a listed hostname is missing or an extra one appears
#   SECURITY_TELEGRAM_MAX_LINES=25        [25]    max lines in the Telegram section body
#   SECURITY_TELEGRAM_MAX_INFO=8          [8]     max INFO lines in the Telegram section
#   SECURITY_TELEGRAM_BUDGET=3000         [3000]  max characters of the section (host_alerter passes what is left)
#   SECURITY_STATE_DIR=...                [$STATE_DIR/host-health, else /var/lib/host-security]
#
# Test hooks: SECURITY_FIXTURE_DIR (read canned command output from files instead of running
# commands; a missing file means "tool not installed"), SECURITY_NOW (epoch), SECURITY_NO_JQ=true,
# SECURITY_CRON_DIR (default /etc/cron.d).
#
# Portable bash (3.2+): the custom-check path and the fixture tests run on macOS too.
set -o pipefail
umask 077

usage() { sed -n '2,/^set -o pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

MODE=raw
for arg in "$@"; do
  case "$arg" in
    --telegram) MODE=telegram ;;
    --sample) MODE=sample ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

SECURITY_BUILTIN="${SECURITY_BUILTIN:-true}"
SECURITY_SKIP="${SECURITY_SKIP:-}"
SECURITY_DIR="${SECURITY_DIR:-${INSTALL_DIR:+$INSTALL_DIR/security.d}}"
SECURITY_CHECK_TIMEOUT="${SECURITY_CHECK_TIMEOUT:-20}"
SECURITY_PUBLIC_PORTS="${SECURITY_PUBLIC_PORTS:-}"
SECURITY_DOCKER_HOSTS="${SECURITY_DOCKER_HOSTS:-unix:///var/run/docker.sock}"
SECURITY_HOSTNET_OK="${SECURITY_HOSTNET_OK:-}"
SECURITY_SSH_FAIL_WARN="${SECURITY_SSH_FAIL_WARN:-200}"
SECURITY_DOCKER_USERS="${SECURITY_DOCKER_USERS:-}"
SECURITY_SUDO_USERS="${SECURITY_SUDO_USERS:-}"
SECURITY_OUTBOUND_OK_PORTS="${SECURITY_OUTBOUND_OK_PORTS:-22 53 80 123 222 443 853 8443}"
SECURITY_KNOWN_PROCS="${SECURITY_KNOWN_PROCS:-}"
SECURITY_KNOWN_REMOTES="${SECURITY_KNOWN_REMOTES:-}"
SECURITY_CONN_LEARN_DAYS="${SECURITY_CONN_LEARN_DAYS:-3}"
SECURITY_CONN_KEEP_DAYS="${SECURITY_CONN_KEEP_DAYS:-90}"
SECURITY_CONN_MAX="${SECURITY_CONN_MAX:-5000}"
SECURITY_EXE_OK="${SECURITY_EXE_OK:-}"
SECURITY_CLOUDFLARED_METRICS_PORT="${SECURITY_CLOUDFLARED_METRICS_PORT:-20241}"
SECURITY_CLOUDFLARED_MIN_CONNECTIONS="${SECURITY_CLOUDFLARED_MIN_CONNECTIONS:-2}"
SECURITY_CLOUDFLARED_CONTAINERS="${SECURITY_CLOUDFLARED_CONTAINERS:-*cloudflared*}"
SECURITY_CLOUDFLARED_LOG_LINES="${SECURITY_CLOUDFLARED_LOG_LINES:-5000}"
SECURITY_TUNNEL_DOMAINS="${SECURITY_TUNNEL_DOMAINS:-}"
SECURITY_EXPECT_DOMAINS="${SECURITY_EXPECT_DOMAINS:-}"
SECURITY_TELEGRAM_MAX_LINES="${SECURITY_TELEGRAM_MAX_LINES:-25}"
SECURITY_TELEGRAM_MAX_INFO="${SECURITY_TELEGRAM_MAX_INFO:-8}"
SECURITY_TELEGRAM_BUDGET="${SECURITY_TELEGRAM_BUDGET:-3000}"
if [[ -n "${SECURITY_STATE_DIR:-}" ]]; then SEC_STATE="$SECURITY_STATE_DIR"
elif [[ -n "${STATE_DIR:-}" ]]; then SEC_STATE="${STATE_DIR}/host-health"
else SEC_STATE=/var/lib/host-security; fi
FIX="${SECURITY_FIXTURE_DIR:-}"
CRON_DIR="${SECURITY_CRON_DIR:-/etc/cron.d}"
MANIFEST_DIR="${STACKS_MANIFEST_DIR:-/etc/airstack/stacks}"
NOW="${SECURITY_NOW:-$(date +%s)}"

ALL_CHECKS="firewall tailscale reachability docker tunnel cloudflared ssh sshsources accounts persistence secrets outbound processes updates"

# --- Knob validation (a typo must fail loudly, not silently weaken a check) ---
die() { echo "host_security: ERROR: $*" >&2; exit 2; }
for v in SECURITY_CHECK_TIMEOUT SECURITY_SSH_FAIL_WARN SECURITY_CONN_LEARN_DAYS SECURITY_CONN_KEEP_DAYS \
         SECURITY_CONN_MAX SECURITY_CLOUDFLARED_METRICS_PORT SECURITY_CLOUDFLARED_MIN_CONNECTIONS \
         SECURITY_CLOUDFLARED_LOG_LINES SECURITY_TELEGRAM_MAX_LINES SECURITY_TELEGRAM_MAX_INFO \
         SECURITY_TELEGRAM_BUDGET NOW; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || die "$v must be a whole number (got '${!v}')"
done
(( SECURITY_CHECK_TIMEOUT >= 1 )) || die "SECURITY_CHECK_TIMEOUT must be at least 1"
(( SECURITY_TELEGRAM_MAX_LINES >= 5 )) || die "SECURITY_TELEGRAM_MAX_LINES must be at least 5"
case "$SECURITY_BUILTIN" in true|false) ;; *) die "SECURITY_BUILTIN must be true or false (got '$SECURITY_BUILTIN')" ;; esac
for p in $SECURITY_OUTBOUND_OK_PORTS; do
  [[ "$p" =~ ^[0-9]+$ ]] || die "SECURITY_OUTBOUND_OK_PORTS: '$p' is not a port number"
done
for p in $SECURITY_PUBLIC_PORTS; do
  [[ "$p" =~ ^[0-9]+(:[0-9]+)?(/(tcp|udp))?$ ]] || die "SECURITY_PUBLIC_PORTS: '$p' must look like 222, 222/tcp or 41641/udp"
done
for s in $SECURITY_SKIP; do
  case " $ALL_CHECKS custom " in *" $s "*) ;; *) die "SECURITY_SKIP: unknown check '$s' (known: $ALL_CHECKS custom)" ;; esac
done

TIMEOUT_BIN=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_BIN=timeout

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

emit() {  # STATUS LABEL DETAIL
  local l="${2//|//}" d="${3:-}"
  d="${d//|//}"
  l="${l//$'\n'/ }"; d="${d//$'\n'/ }"
  printf '%s|%s|%s\n' "$1" "$l" "$d"
}

skipped() { case " $SECURITY_SKIP " in *" $1 "*) return 0 ;; esac; return 1; }

# run_cmd NAME TIMEOUT CMD... -> stdout of CMD (stderr dropped).
# Fixture mode: prints $FIX/NAME (exit code from $FIX/NAME.rc, default 0); no file = 127 (not installed).
run_cmd() {
  local name="$1" to="$2"; shift 2
  if [[ -n "$FIX" ]]; then
    [[ -f "$FIX/$name" ]] || return 127
    cat "$FIX/$name"
    [[ -f "$FIX/$name.rc" ]] && return "$(cat "$FIX/$name.rc")"
    return 0
  fi
  command -v "$1" >/dev/null 2>&1 || return 127
  if [[ -n "$TIMEOUT_BIN" ]]; then "$TIMEOUT_BIN" -k 2 "$to" "$@" 2>/dev/null; else "$@" 2>/dev/null; fi
}
# Same, but stderr is kept (merged into stdout) for commands whose error text matters.
run_cmd_all() {
  local name="$1" to="$2"; shift 2
  if [[ -n "$FIX" ]]; then run_cmd "$name" "$to" "$@"; return $?; fi
  command -v "$1" >/dev/null 2>&1 || return 127
  if [[ -n "$TIMEOUT_BIN" ]]; then "$TIMEOUT_BIN" -k 2 "$to" "$@" 2>&1; else "$@" 2>&1; fi
}
# cached NAME TIMEOUT CMD... -> like run_cmd, but each NAME runs once per invocation of this script.
cached() {
  local f="$WORK/c.$1"
  if [[ ! -f "$f.rc" ]]; then run_cmd "$@" >"$f"; echo $? >"$f.rc"; fi
  cat "$f"
  return "$(cat "$f.rc")"
}
# fixture-aware path of a system file: fpath NAME REALPATH
fpath() { if [[ -n "$FIX" ]]; then printf '%s' "$FIX/$1"; else printf '%s' "$2"; fi; }

use_jq() { [[ "${SECURITY_NO_JQ:-false}" != true ]] && command -v jq >/dev/null 2>&1; }

if command -v sha256sum >/dev/null 2>&1; then hash_stdin() { sha256sum | cut -c1-64; }
else hash_stdin() { shasum -a 256 | cut -c1-64; }; fi
hash_file() { hash_stdin <"$1" 2>/dev/null || echo unreadable; }
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }
file_owner() { stat -c %U "$1" 2>/dev/null || stat -f %Su "$1" 2>/dev/null; }

in_list() {  # WORD LIST
  case " $2 " in *" $1 "*) return 0 ;; esac; return 1
}
glob_match() {  # WORD GLOBLIST (globs are matched against WORD, never expanded against files)
  local g hit=1 noglob=false
  [[ "$-" == *f* ]] && noglob=true
  set -f
  for g in $2; do
    # shellcheck disable=SC2053  # $g is a glob on purpose
    [[ "$1" == $g ]] && { hit=0; break; }
  done
  $noglob || set +f
  return $hit
}
join_by() { local sep="$1" out="" x; shift; for x in "$@"; do out+="${out:+$sep}$x"; done; printf "%s" "$out"; }

fmt_age() {  # seconds -> 3d4h / 2h05m / 7m
  local s="$1"
  if (( s >= 86400 )); then printf '%dd%dh' $((s / 86400)) $((s % 86400 / 3600))
  elif (( s >= 3600 )); then printf '%dh%02dm' $((s / 3600)) $((s % 3600 / 60))
  else printf '%dm' $((s / 60)); fi
}

# Shared awk functions: address classes. ipclass -> loop | priv | tail | wild | public
AWK_IP='
function ipclass(h,   p, a, b) {
  h = tolower(h)
  if (h ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {
    split(h, p, "."); a = p[1] + 0; b = p[2] + 0
    if (a == 127) return "loop"
    if (a == 0 || a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254) || a >= 224) return "priv"
    if (a == 100 && b >= 64 && b <= 127) return "tail"
    return "public"
  }
  if (h == "::1") return "loop"
  if (h == "::" || h == "*" ) return "wild"
  if (h ~ /^fd7a:/) return "tail"
  if (h ~ /^f[cd]/ || h ~ /^fe[89ab]/ || h ~ /^ff/) return "priv"
  return "public"
}
# addr "host:port" from ss -> class, honouring %iface suffixes
function addrclass(a,   h) {
  h = a; sub(/:[0-9*]+$/, "", h)
  if (h ~ /%lo$/) return "loop"
  if (h ~ /%tailscale[0-9]*$/) return "tail"
  sub(/%.*$/, "", h); gsub(/[][]/, "", h); sub(/^::ffff:/, "", h)
  if (h == "0.0.0.0") return "wild"
  return ipclass(h)
}
function addrhost(a,   h) { h = a; sub(/:[0-9*]+$/, "", h); sub(/%.*$/, "", h); gsub(/[][]/, "", h); sub(/^::ffff:/, "", h); return h }
function addrport(a,   p) { p = a; sub(/.*:/, "", p); return p }
'

ip_class() { awk -v h="$1" "$AWK_IP"' BEGIN { print ipclass(h) }'; }
ip_label() { case "$(ip_class "$1")" in tail) echo tailnet ;; public) echo public ;; loop) echo local ;; *) echo private ;; esac; }

# Creates the state dir (mode 700) if missing; never changes the mode of an existing one
# (host_alerter's health.json lives there and other readers may need it).
ensure_state_dir() { [[ -d "$SEC_STATE" ]] || { mkdir -p "$SEC_STATE" 2>/dev/null && chmod 700 "$SEC_STATE"; }; [[ -d "$SEC_STATE" && -w "$SEC_STATE" ]]; }
blen() { local LC_ALL=C; printf '%s' "${#1}"; }

# ---------------------------------------------------------------------------
# Shared data (each command runs once)
# ---------------------------------------------------------------------------

ufw_status() { cached ufw_status 10 ufw status verbose; }
sshd_t() { cached sshd_T 10 sshd -T; }
ss_listen() { cached ss_listen 5 ss -tlnH; }
ss_est() { cached ss_est 5 ss -tnpH state established; }
journal_ssh() { cached journal_ssh 15 journalctl -q --no-pager -u ssh -u sshd --since "24 hours ago"; }
sshd_value() { sshd_t | awk -v k="$1" 'tolower($1) == k { $1 = ""; sub(/^ /, ""); print; exit }'; }

sshd_ports() {
  local p
  p=$(sshd_t | awk 'tolower($1) == "port" { print $2 }' | sort -un | tr '\n' ' ')
  [[ -n "${p// /}" ]] || p=22
  printf '%s' "${p% }"
}

ts_present() {
  if [[ -n "$FIX" ]]; then [[ -f "$FIX/tailscale_status" ]]; return; fi
  command -v tailscale >/dev/null 2>&1 && [[ -e /sys/class/net/tailscale0 ]]
}

public_expected() {
  if [[ -n "$SECURITY_PUBLIC_PORTS" ]]; then printf '%s' "$SECURITY_PUBLIC_PORTS"; return; fi
  local p out=""
  for p in $(sshd_ports); do out+="$p/tcp "; done
  ts_present && out+="41641/udp"
  printf '%s' "${out% }"
}

# UFW allow rows -> "scope|spec|from" (scope = public or the interface; v6 rows collapsed).
ufw_rows() {
  ufw_status | awk '
    /^--/ { body = 1; next }
    body && NF {
      n = split($0, f, /  +/); to = f[1]; act = f[2]; from = f[3]
      if (act !~ /^(ALLOW|LIMIT)/ || act ~ /OUT/) next
      scope = "public"
      if (match(to, / on [^ ]+$/)) { scope = substr(to, RSTART + 4); to = substr(to, 1, RSTART - 1) }
      gsub(/ *\(v6\)/, "", to); gsub(/ *\(v6\)/, "", from); sub(/ +$/, "", from)
      if (to == "OpenSSH") to = "22/tcp"
      print scope "|" to "|" from
    }' | sort -u
}

spec_show() {  # 222/tcp -> tcp/222 ; 22 -> 22 (tcp+udp)
  case "$1" in
    */*) printf '%s/%s' "${1#*/}" "${1%/*}" ;;
    *[0-9]) printf '%s (tcp+udp)' "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}
spec_expected() {  # SPEC LIST
  local e sp="${1%/*}" pr=""
  [[ "$1" == */* ]] && pr="${1#*/}"
  for e in $2; do
    [[ "$e" == "$1" ]] && return 0
    [[ "$e" != */* && "$e" == "$sp" ]] && return 0
    [[ -z "$pr" && "${e%/*}" == "$sp" ]] && return 0
  done
  return 1
}
spec_has_tcp_port() {  # SPEC PORT
  local sp="${1%/*}"
  [[ "$1" == */udp ]] && return 1
  if [[ "$sp" == *:* ]]; then (( $2 >= ${sp%:*} && $2 <= ${sp#*:} )); return; fi
  [[ "$sp" == "$2" ]]
}

# tcp listeners not on loopback/tailnet/private -> "class port" (class wild|public)
exposed_listeners() {
  ss_listen | awk "$AWK_IP"'{ c = addrclass($4); if (c == "wild" || c == "public") print c, addrport($4) }' | sort -u -k2,2n
}

# ---------------------------------------------------------------------------
# Built-in checks (each prints protocol lines; each must end with return 0)
# ---------------------------------------------------------------------------

check_firewall() {
  local out rc policy ipt irc incoming
  out=$(ufw_status); rc=$?
  ipt=$(run_cmd iptables_input 5 iptables -S INPUT); irc=$?
  policy=$(printf '%s\n' "$ipt" | awk '$1 == "-P" && $2 == "INPUT" { print $3 }')
  if (( rc == 127 )); then
    if (( irc != 0 )); then emit INFO firewall "no ufw; could not read iptables (needs root?)"
    elif [[ "$policy" == DROP ]]; then emit OK firewall "no ufw; iptables INPUT policy DROP"
    else emit WARN firewall "no ufw and iptables INPUT policy is ${policy:-unknown}"; fi
    return 0
  fi
  if (( rc != 0 )) || [[ -z "$out" ]]; then emit INFO firewall "could not read ufw status (needs root?)"; return 0; fi
  if ! grep -q '^Status: active' <<<"$out"; then emit FAIL firewall "ufw is not active"; return 0; fi
  incoming=$(sed -n 's/^Default: *\([a-z]*\) (incoming).*/\1/p' <<<"$out")
  case "$incoming" in
    deny|reject) ;;
    "") emit WARN firewall "ufw active but the default incoming policy is unknown" ;;
    *) emit FAIL firewall "ufw default incoming policy is '$incoming' (should be deny)"; return 0 ;;
  esac
  if (( irc == 0 )) && [[ -n "$ipt" ]]; then
    if [[ "$policy" != DROP ]] && ! grep -q -- '-A INPUT -j ufw-before-input' <<<"$ipt"; then
      emit WARN firewall "ufw says active but its chains are not hooked into INPUT (policy ${policy:-?})"
      return 0
    fi
  fi
  [[ -n "$incoming" ]] && emit OK firewall "ufw active, default deny incoming${policy:+, INPUT policy $policy}"
  return 0
}

ts_divert_state() {  # -> on | off | unknown
  local t out rc any_on=false any_unknown=false
  for t in iptables ip6tables; do
    out=$(run_cmd_all "${t}_ts" 5 "$t" -C INPUT -j ts-input); rc=$?
    if (( rc == 0 )); then any_on=true
    elif (( rc == 1 )) || grep -qiE "does not exist|no chain|couldn't load target|bad rule" <<<"$out"; then :
    elif [[ "$t" == ip6tables && $rc == 127 ]]; then :
    else any_unknown=true; fi
  done
  if $any_on; then echo on; elif $any_unknown; then echo unknown; else echo off; fi
}

check_tailscale() {
  ts_present || return 0
  local js backend tags
  case "$(ts_divert_state)" in
    on) emit FAIL tailscale:netfilter "tailscale default netfilter mode: all tailnet traffic bypasses UFW; run \`tailscale set --netfilter-mode=nodivert\`" ;;
    off) emit OK tailscale:netfilter "nodivert (UFW rules apply to tailnet traffic)" ;;
    *) emit INFO tailscale:netfilter "could not check the ts-input divert rule (needs root?)" ;;
  esac
  js=$(cached tailscale_status 10 tailscale status --json)
  if [[ -z "$js" ]]; then emit INFO tailscale "could not read tailscale status"; return 0; fi
  if use_jq; then
    backend=$(jq -r '.BackendState // empty' <<<"$js" 2>/dev/null)
    tags=$(jq -r '(.Self.Tags // []) | join(",")' <<<"$js" 2>/dev/null)
  else
    js=$(tr -d '\n\r\t' <<<"$js")
    backend=$(sed -n 's/.*"BackendState": *"\([^"]*\)".*/\1/p' <<<"$js")
    tags=$(awk '{
      i = index($0, "\"Self\":"); if (!i) exit
      s = substr($0, i + 7); j = index(s, "{"); s = substr(s, j); d = 0; out = ""
      for (k = 1; k <= length(s); k++) { c = substr(s, k, 1)
        if (c == "{") d++; else if (c == "}") { d--; if (d == 0) { out = substr(s, 1, k); break } } }
      if (match(out, /"Tags": *\[[^]]*\]/)) { t = substr(out, RSTART, RLENGTH); sub(/^"Tags": *\[/, "", t); sub(/\]$/, "", t); gsub(/[" ]/, "", t); print t }
    }' <<<"$js")
  fi
  if [[ "$backend" == Running ]]; then emit INFO tailscale "Running; tags: ${tags:-none}"
  else emit WARN tailscale "BackendState is ${backend:-unknown} (not Running)"; fi
  return 0
}

ts_serve_forwards() {  # -> "tcp/3773 → 127.0.0.1:3773" lines; "FUNNEL <key>" for public funnels
  local js
  js=$(cached tailscale_serve 10 tailscale serve status --json) || return 0
  [[ -n "$js" ]] || return 0
  if use_jq; then
    jq -r '((.TCP // {}) | to_entries[] | "tcp/\(.key) → \(.value.TCPForward // "serve")"),
           ((.AllowFunnel // {}) | to_entries[] | select(.value == true) | "FUNNEL \(.key)")' <<<"$js" 2>/dev/null
  else
    js=$(tr -d '\n\r\t' <<<"$js")
    grep -oE '"[0-9]+": *\{ *"TCPForward": *"[^"]*"' <<<"$js" | sed -E 's/"([0-9]+)": *\{ *"TCPForward": *"([^"]*)"/tcp\/\1 → \2/'
    grep -oE '"[^"]+": *true' <<<"$(grep -oE '"AllowFunnel": *\{[^}]*\}' <<<"$js")" | sed -E 's/"([^"]+)".*/FUNNEL \1/'
  fi
}

check_reachability() {
  local out rc expected rows line scope spec from ssh_ports p facts v listeners blocked=() extra_ok=() tailnet=() serve=() restricted=()
  local pa kbd root allow
  out=$(ufw_status); rc=$?
  expected=$(public_expected)
  ssh_ports=$(sshd_ports)
  listeners=$(exposed_listeners)

  # SSH facts
  pa=$(sshd_value passwordauthentication); kbd=$(sshd_value kbdinteractiveauthentication)
  root=$(sshd_value permitrootlogin); allow=$(sshd_value allowusers)
  facts=()
  if [[ -n "$pa" ]]; then
    if [[ "$pa" == no && "$kbd" != yes ]]; then facts+=("key-only"); else facts+=("PASSWORDS ALLOWED"); fi
    case "$root" in no) facts+=("root login off") ;; prohibit-password|without-password) facts+=("root key-only") ;; *) facts+=("root login ${root:-?}") ;; esac
    [[ -n "$allow" ]] && facts+=("AllowUsers: $allow")
  fi

  if (( rc != 0 )) || [[ -z "$out" ]]; then
    emit INFO reachable:public "could not read UFW (needs root?); public exposure unknown"
    return 0
  fi
  if ! grep -q '^Status: active' <<<"$out"; then
    while read -r _ p; do
      [[ -n "$p" ]] && emit WARN reachable:unexpected "tcp/$p listens on all interfaces and UFW is off"
    done <<<"$listeners"
    return 0
  fi

  rows=$(ufw_rows)
  local ssh_public=() ssh_closed=()
  for p in $ssh_ports; do ssh_closed+=("$p"); done
  while IFS='|' read -r scope spec from; do
    [[ -n "$spec" ]] || continue
    if [[ "$scope" != public ]]; then
      if [[ "$scope" == tailscale* ]]; then tailnet+=("$(spec_show "$spec")"); else restricted+=("$(spec_show "$spec") on $scope only"); fi
      continue
    fi
    if [[ "$from" != Anywhere* ]]; then restricted+=("$(spec_show "$spec") from $from only"); continue; fi
    if [[ "$spec" == Anywhere ]]; then emit FAIL reachable:unexpected "UFW allows ALL ports from anywhere"; continue; fi
    local is_ssh=false
    for p in $ssh_ports; do spec_has_tcp_port "$spec" "$p" && is_ssh=true; done
    if spec_expected "$spec" "$expected"; then
      if $is_ssh; then ssh_public+=("$(spec_show "$spec")"); else extra_ok+=("$(spec_show "$spec")"); fi
      continue
    fi
    # Unexpected public rule: is something listening behind it?
    local hit=false
    while read -r _ lp; do [[ -n "$lp" ]] && spec_has_tcp_port "$spec" "$lp" && hit=true; done <<<"$listeners"
    if $hit; then emit WARN reachable:unexpected "$(spec_show "$spec") is open to the internet (UFW allows it, wildcard listener)"
    else emit WARN reachable:unexpected "$(spec_show "$spec") is allowed by UFW from anywhere (nothing listens now)"; fi
  done <<<"$rows"

  if (( ${#ssh_public[@]} > 0 )); then
    emit INFO reachable:ssh "$(join_by ', ' "${ssh_public[@]}") open to the internet${facts[0]:+; $(join_by ', ' "${facts[@]}")}"
  else
    emit INFO reachable:ssh "sshd (tcp/${ssh_closed[*]}) is not open to the internet by UFW${facts[0]:+; $(join_by ', ' "${facts[@]}")}"
  fi
  (( ${#extra_ok[@]} > 0 )) && emit INFO reachable:public "also open (expected): $(join_by ', ' "${extra_ok[@]}")"
  (( ${#restricted[@]} > 0 )) && emit INFO reachable:restricted "$(join_by ', ' "${restricted[@]}")"

  # Wildcard listeners that UFW blocks (fine, but worth knowing; Docker-published ports are checked separately).
  while read -r _ lp; do
    [[ -n "$lp" ]] || continue
    local allowed=false
    while IFS='|' read -r scope spec from; do
      [[ "$scope" == public && "$from" == Anywhere* ]] && spec_has_tcp_port "$spec" "$lp" && allowed=true
    done <<<"$rows"
    $allowed || blocked+=("tcp/$lp")
  done <<<"$listeners"
  (( ${#blocked[@]} > 0 )) && emit INFO reachable:listeners "on all interfaces, UFW blocks public: $(join_by ', ' "${blocked[@]}")"

  # Tailnet-only exposure
  if ts_present; then
    while IFS= read -r line; do
      case "$line" in
        "FUNNEL "*) emit WARN reachable:unexpected "tailscale funnel publishes ${line#FUNNEL } to the internet" ;;
        ?*) serve+=("$line") ;;
      esac
    done < <(ts_serve_forwards)
  fi
  if (( ${#tailnet[@]} + ${#serve[@]} > 0 )); then
    v="not public:"
    (( ${#tailnet[@]} > 0 )) && v+=" UFW on tailscale0 $(join_by ', ' "${tailnet[@]}")"
    (( ${#tailnet[@]} > 0 && ${#serve[@]} > 0 )) && v+=";"
    (( ${#serve[@]} > 0 )) && v+=" serve $(join_by ', ' "${serve[@]}")"
    emit INFO reachable:tailnet "$v"
  fi
  return 0
}

check_docker() {
  local host sock ids rows who n issues name net priv pid ports mounts hostnet=()
  if [[ -z "$FIX" ]] && ! command -v docker >/dev/null 2>&1; then return 0; fi
  for host in $SECURITY_DOCKER_HOSTS; do
    sock="${host#unix://}"
    case "$sock" in /var/run/docker.sock|/run/docker.sock) who=docker ;;
      /run/user/*/docker.sock) who="docker(rootless uid $(cut -d/ -f4 <<<"$sock"))" ;;
      *) who="docker($sock)" ;; esac
    if [[ -n "$FIX" ]]; then
      rows=$(run_cmd docker_inspect 10 true) || continue
    else
      [[ -S "$sock" ]] || continue
      ids=$(run_cmd docker_ps 10 env DOCKER_HOST="$host" docker ps -q)
      if (( $? != 0 )); then emit INFO "$who" "daemon not reachable"; continue; fi
      [[ -n "$ids" ]] || { emit OK "$who" "no running containers"; continue; }
      # shellcheck disable=SC2086  # ids are word-split on purpose
      rows=$(run_cmd docker_inspect 15 env DOCKER_HOST="$host" docker inspect --format \
        '{{.Name}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Privileged}}|{{.HostConfig.PidMode}}|{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{$p}}@{{.HostIp}}:{{.HostPort}} {{end}}{{end}}|{{range .Mounts}}{{.Source}} {{end}}' $ids)
    fi
    n=0; issues=0; hostnet=()
    while IFS='|' read -r name net priv pid ports mounts; do
      [[ -n "$name" ]] || continue
      name="${name#/}"; n=$((n + 1))
      local b pub=""
      for b in $ports; do
        local cport="${b%%@*}" hip="${b#*@}" hport="${b##*:}"; hip="${hip%:*}"
        if [[ -z "$hip" || "$hip" == 0.0.0.0 || "$hip" == "::" || "$hip" == "[::]" ]]; then
          # v4 and v6 bindings of one port count once
          [[ " $pub " == *" ${cport#*/}/$hport "* ]] || pub+=" ${cport#*/}/$hport"
        fi
      done
      for b in $pub; do
        emit WARN reachable:docker "$b is open to the internet: published by container $name on all addresses (Docker bypasses UFW)"
        issues=$((issues + 1))
      done
      [[ "$priv" == true ]] && { emit WARN "$who" "$name runs --privileged"; issues=$((issues + 1)); }
      [[ "$pid" == host ]] && { emit WARN "$who" "$name uses the host PID namespace"; issues=$((issues + 1)); }
      if [[ " $mounts " == *"docker.sock "* ]]; then emit WARN "$who" "$name mounts the Docker socket (root-equivalent)"; issues=$((issues + 1)); fi
      [[ "$net" == host ]] && ! glob_match "$name" "$SECURITY_HOSTNET_OK" && hostnet+=("$name")
    done <<<"$rows"
    (( ${#hostnet[@]} > 0 )) && emit INFO "$who" "host network (sees all host interfaces): $(join_by ', ' "${hostnet[@]}")"
    (( issues == 0 && n > 0 )) && emit OK "$who" "$n running container(s): no public ports, privileged mode, host PID or socket mounts"
  done
  return 0
}

cf_ready_json() { cached cloudflared_ready 5 curl -s -m 3 "http://127.0.0.1:${SECURITY_CLOUDFLARED_METRICS_PORT}/ready"; }
cf_ready_count() { cf_ready_json | sed -n 's/.*"readyConnections": *\([0-9][0-9]*\).*/\1/p'; }

check_cloudflared() {
  local js rc n
  js=$(cf_ready_json); rc=$?
  if (( rc == 127 )); then emit INFO cloudflared "curl not installed; not checked"; return 0; fi
  n=$(cf_ready_count)
  if [[ -z "$js" || -z "$n" ]]; then emit INFO cloudflared "not running / no metrics on 127.0.0.1:${SECURITY_CLOUDFLARED_METRICS_PORT}"; return 0; fi
  if (( n == 0 )); then emit FAIL cloudflared "tunnel has 0 ready connections (sites behind it are down)"
  elif (( n < SECURITY_CLOUDFLARED_MIN_CONNECTIONS )); then emit WARN cloudflared "tunnel has only $n ready connection(s) (minimum $SECURITY_CLOUDFLARED_MIN_CONNECTIONS)"
  else emit OK cloudflared "tunnel ready, $n connections"; fi
  return 0
}

# Latest "Updated to new configuration" log line of cloudflared (remotely managed tunnels log their ingress there).
cf_config_line() {
  if [[ -n "$FIX" ]]; then run_cmd cloudflared_logs 5 true | grep 'Updated to new configuration' | tail -1; return 0; fi
  local names n line=""
  if command -v docker >/dev/null 2>&1 && [[ -S /var/run/docker.sock ]]; then
    names=$(run_cmd docker_names 10 docker ps --format '{{.Names}}')
    for n in $names; do
      glob_match "$n" "$SECURITY_CLOUDFLARED_CONTAINERS" || continue
      line=$(run_cmd_all docker_logs 15 docker logs --tail "$SECURITY_CLOUDFLARED_LOG_LINES" "$n" | grep 'Updated to new configuration' | tail -1)
      [[ -n "$line" ]] && break
    done
  fi
  if [[ -z "$line" ]] && command -v journalctl >/dev/null 2>&1; then
    line=$(run_cmd journal_cf 10 journalctl -q --no-pager -u cloudflared -n "$SECURITY_CLOUDFLARED_LOG_LINES" | grep 'Updated to new configuration' | tail -1)
  fi
  printf '%s\n' "$line"
}
# config line -> "hostname<TAB>service" pairs (catch-all rules without a hostname are dropped)
cf_parse_ingress() {
  sed 's/\\"/"/g' | grep -oE '"(hostname|service)": *"[^"]*"' | awk -F'"' '
    $2 == "hostname" { h = $4; next }
    $2 == "service" { if (h != "") print h "\t" $4; h = "" }'
}

check_tunnel() {
  local line pairs h s n count_note="" seen=""
  line=$(cf_config_line)
  n=$(cf_ready_count)
  [[ -n "$n" ]] && count_note=" ($n connections)"
  pairs=$(printf '%s\n' "$line" | cf_parse_ingress)
  if [[ -n "$pairs" ]]; then
    while IFS=$'\t' read -r h s; do
      [[ -n "$h" ]] || continue
      seen+=" $h"
      emit INFO reachable:tunnel "$h → $s$count_note"
    done <<<"$pairs"
  elif [[ -n "$SECURITY_TUNNEL_DOMAINS" ]]; then
    for h in $SECURITY_TUNNEL_DOMAINS; do seen+=" $h"; emit INFO reachable:tunnel "$h (from SECURITY_TUNNEL_DOMAINS)$count_note"; done
  elif [[ -n "$n" || -n "$line" ]]; then
    emit INFO reachable:tunnel "tunnel hostnames unknown (not in recent logs)$count_note"
  fi
  if [[ -n "$SECURITY_EXPECT_DOMAINS" && -n "$seen" ]]; then
    for h in $SECURITY_EXPECT_DOMAINS; do in_list "$h" "$seen" || emit WARN reachable:tunnel "expected hostname $h is not in the tunnel config"; done
    for h in $seen; do in_list "$h" "$SECURITY_EXPECT_DOMAINS" || emit WARN reachable:tunnel "unexpected tunnel hostname $h"; done
  fi
  return 0
}

check_ssh() {
  local out rc root pa kbd j jrc failed top
  out=$(sshd_t); rc=$?
  if (( rc == 127 )); then return 0; fi
  if (( rc != 0 )) || [[ -z "$out" ]]; then emit INFO ssh "could not read sshd -T (needs root?)"
  else
    root=$(sshd_value permitrootlogin); pa=$(sshd_value passwordauthentication); kbd=$(sshd_value kbdinteractiveauthentication)
    local bad=false
    case "$root" in no|prohibit-password|without-password|forced-commands-only) ;;
      *) emit FAIL ssh "PermitRootLogin is '$root' (use no or prohibit-password)"; bad=true ;; esac
    [[ "$pa" == yes ]] && { emit FAIL ssh "PasswordAuthentication is yes (use keys only)"; bad=true; }
    [[ "$kbd" == yes ]] && { emit WARN ssh "KbdInteractiveAuthentication is yes (PAM may accept passwords)"; bad=true; }
    $bad || emit OK ssh "root login $root, password auth off"
  fi
  j=$(journal_ssh); jrc=$?
  if (( jrc == 127 )); then return 0; fi
  if (( jrc != 0 )); then emit INFO ssh:failures "could not read the ssh journal"; return 0; fi
  # One failed attempt = one TCP connection (source ip:port). sshd writes several lines per attempt
  # (Invalid user, Failed password, Connection closed …), so counting lines overstates it.
  # Output: line 1 "<connections> <ips>", then "ip<TAB>connections" (top first), then "users<TAB>u1 u2 …".
  local stats conns nips top users
  stats=$(awk '
    /Failed (password|publickey)|Invalid user|Connection closed by authenticating user|Disconnected from (invalid|authenticating) user/ {
      ip = ""; port = ""; u = ""
      for (i = 1; i <= NF; i++) {
        if ($i == "port" && i > 1) { ip = $(i - 1); port = $(i + 1) }
        if ($i == "user" && i < NF) u = $(i + 1)
        if ($i == "for" && $(i + 1) != "invalid" && u == "") u = $(i + 1)
      }
      if (ip == "") next
      if (!((ip SUBSEP port) in seen)) { seen[ip, port] = 1; conns++; per[ip]++ }
      if (u != "" && !(u in tried)) { tried[u] = 1; ulist = ulist (ulist == "" ? "" : " ") u }
    }
    END {
      n = 0; for (ip in per) n++
      print conns + 0, n
      for (ip in per) print ip "\t" per[ip]
      print "users\t" ulist
    }' <<<"$j")
  read -r conns nips <<<"$(head -1 <<<"$stats")"
  if (( conns == 0 )); then
    emit OK ssh:failures "no failed logins in 24 h"
    return 0
  fi
  local summary="$conns failed login(s) from $nips IP(s) in 24 h"
  if (( conns > SECURITY_SSH_FAIL_WARN )); then emit WARN ssh:failures "$summary (threshold $SECURITY_SSH_FAIL_WARN)"
  else emit OK ssh:failures "$summary"; fi
  top=$(sed -n '2,$p' <<<"$stats" | grep -v '^users	' | sort -t$'\t' -k2,2nr -k1,1 | head -3 \
        | while IFS=$'\t' read -r ip c; do printf '%s ×%s (%s)\n' "$ip" "$c" "$(ip_label "$ip")"; done | paste -sd, - | sed 's/,/, /g')
  users=$(sed -n 's/^users	//p' <<<"$stats" | tr ' ' '\n' | sed '/^$/d' | head -6 | paste -sd, - | sed 's/,/, /g')
  emit INFO ssh:failures "top sources: ${top}${users:+; users tried: $users}"
  return 0
}

# `ssh-keygen -lf` lines ("256 SHA256:… comment (ED25519)") for a user's authorized keys.
# Fails when the user or the file cannot be read. Fixture mode: $FIX/authorized_fingerprints.<user>
authorized_fingerprints() {  # USER
  local u="$1" home out="" akf
  if [[ -n "$FIX" ]]; then
    [[ -f "$FIX/authorized_fingerprints.$u" ]] || return 1
    cat "$FIX/authorized_fingerprints.$u"
    return 0
  fi
  home=$(getent passwd "$u" 2>/dev/null | cut -d: -f6)
  [[ -n "$home" ]] || return 1
  for akf in "$home/.ssh/authorized_keys" "$home/.ssh/authorized_keys2"; do
    [[ -f "$akf" ]] || continue
    out+=$(run_cmd ssh-keygen 5 ssh-keygen -lf "$akf")$'\n'
  done
  [[ -n "${out//$'\n'/}" ]] || return 1
  printf '%s' "$out"
}

# Merge IPs into the ssh-sources baseline; prints the IPs that were new. Format: ip|first|last, #created=
ssh_sources_update() {  # FILE IP...
  local f="$1" tmp; shift
  tmp="$f.tmp.$$"
  { cat "$f" 2>/dev/null; true; } | awk -v now="$NOW" -v ips="$*" -v newf="$tmp.new" '
    BEGIN { FS = OFS = "|"; n = split(ips, list, " ") }
    /^#created=/ { created = substr($0, 10); next }
    NF >= 3 { first[$1] = $2; last[$1] = $3 }
    END {
      if (created == "") created = now
      print "#created=" created
      for (i = 1; i <= n; i++) { ip = list[i]; if (ip == "") continue
        if (!(ip in first)) { first[ip] = now; print ip > newf }
        last[ip] = now }
      for (ip in first) print ip, first[ip], last[ip]
    }' >"$tmp" || { rm -f "$tmp" "$tmp.new"; return 1; }
  mv -f "$tmp" "$f" && chmod 600 "$f"
  [[ -f "$tmp.new" ]] && cat "$tmp.new"
  rm -f "$tmp.new"
  return 0
}

check_sshsources() {
  local ports filter p sess pids psout lines=() j logins ips="" f created learning=false newips ip user cls
  ports=$(sshd_ports)
  filter=""
  for p in $ports; do filter+="${filter:+ or }sport = :$p"; done
  sess=$(cached ss_ssh 5 ss -tnpH state established "( $filter )")
  if [[ -n "$sess" ]]; then
    pids=$(grep -oE 'pid=[0-9]+' <<<"$sess" | cut -d= -f2 | sort -u | tr '\n' ',')
    psout=""
    [[ -n "$pids" ]] && psout=$(run_cmd ps 5 ps -o pid=,user:32=,etimes= -p "${pids%,}")
    while read -r line; do
      [[ -n "$line" ]] || continue
      local peer host u="?" age=0
      peer=$(awk '{ print $4 }' <<<"$line")
      host=$(awk "$AWK_IP"'{ print addrhost($0) }' <<<"$peer")
      for pid in $(grep -oE 'pid=[0-9]+' <<<"$line" | cut -d= -f2); do
        pu=""; pe=0
        read -r _ pu pe < <(awk -v p="$pid" '$1 == p' <<<"$psout")
        [[ -n "${pu:-}" ]] || continue
        if [[ "$u" == "?" || "$u" == root || "$u" == sshd ]]; then u="$pu"; fi
        [[ "${pe:-0}" =~ ^[0-9]+$ ]] && (( pe > age )) && age=$pe
      done
      lines+=("$u from $host ($(ip_label "$host"), $(fmt_age "$age"))")
      ips+=" $host"
    done <<<"$sess"
    emit INFO ssh:sessions "${#lines[@]} open: $(join_by '; ' "${lines[@]}")"
  fi
  j=$(journal_ssh)
  if [[ -n "$j" ]]; then
    # One entry per user + source + key: when (first–last in the window) and WHICH key, named by its
    # authorized_keys comment. No counts: deploy tools open a new SSH connection per command, so the
    # number of accepted connections says nothing about how many times a person logged in.
    # awk output: "<last-line-no> <user> <ip> <fingerprint|-> <first HH:MM> <last HH:MM>", newest first.
    logins=$(awk '
      /Accepted [a-z\/-]+ for / {
        t = ($3 ~ /^[0-9][0-9]:[0-9][0-9]/) ? substr($3, 1, 5) : "?"
        u = ""; ip = ""; fp = "-"
        for (i = 1; i <= NF; i++) {
          if ($i == "for") u = $(i + 1)
          if ($i == "from") ip = $(i + 1)
          if ($i ~ /^SHA256:/) fp = $i
        }
        if (u == "" || ip == "") next
        k = u " " ip " " fp
        if (!(k in first)) first[k] = t
        last[k] = t; seen[k] = NR
      }
      END { for (k in seen) print seen[k], k, first[k], last[k] }' <<<"$j" | sort -rn)
    if [[ -n "$logins" ]]; then
      local shown=() total keymap="" known=" " when label lu
      total=$(wc -l <<<"$logins" | tr -d ' ')
      # user<TAB>fingerprint<TAB>comment for every authorized key of the users seen
      for lu in $(awk '{ print $2 }' <<<"$logins" | sort -u); do
        local fps
        fps=$(authorized_fingerprints "$lu") || continue
        known+="$lu "
        keymap+=$(awk -v u="$lu" 'NF >= 2 { c = ""; for (i = 3; i < NF; i++) c = c (c == "" ? "" : " ") $i; print u "\t" $2 "\t" (c == "" ? "no comment" : c) }' <<<"$fps")$'\n'
      done
      while read -r _ user ip fp t1 t2; do
        when=$([[ "$t1" == "$t2" ]] && echo "at $t2" || echo "$t1–$t2")
        if [[ "$fp" == "-" ]]; then
          label="non-key auth"
        else
          label=$(awk -F'\t' -v u="$user" -v f="$fp" '$1 == u && $2 == f { print $3; exit }' <<<"$keymap")
          if [[ -n "$label" ]]; then label="key \"$label\""
          elif [[ "$known" == *" $user "* ]]; then label="key …${fp: -8} (NOT in authorized_keys now)"
          else label="key …${fp: -8}"; fi
        fi
        shown+=("$user from $ip ($(ip_label "$ip")) $when, $label")
      done <<<"$(head -5 <<<"$logins")"
      while read -r _ _ ip _; do ips+=" $ip"; done <<<"$logins"
      (( total > 5 )) && shown+=("+$((total - 5)) more")
      emit INFO ssh:logins "24 h: $(join_by '; ' "${shown[@]}")"
    fi
  fi
  [[ -n "${ips// /}" ]] || return 0
  ips=$(tr ' ' '\n' <<<"$ips" | sed '/^$/d' | sort -u | tr '\n' ' ')
  if ! ensure_state_dir; then emit INFO ssh:new-source "state dir $SEC_STATE not writable; source baseline skipped"; return 0; fi
  f="$SEC_STATE/ssh-sources"
  created=$(sed -n 's/^#created=//p' "$f" 2>/dev/null | head -1)
  [[ -z "$created" ]] && created=$NOW
  (( NOW - created < SECURITY_CONN_LEARN_DAYS * 86400 )) && learning=true
  local had_file=false; [[ -f "$f" ]] && had_file=true
  # shellcheck disable=SC2086
  newips=$(ssh_sources_update "$f" $ips) || { emit INFO ssh:new-source "could not update $f"; return 0; }
  if [[ -n "$newips" ]]; then
    if $learning || ! $had_file; then
      emit INFO ssh:new-source "learning baseline: recorded $(wc -l <<<"$newips" | tr -d ' ') source IP(s)"
    else
      for ip in $newips; do
        user=$(sed -nE "s/.*Accepted [a-z/-]+ for ([^ ]+) from ${ip//./\\.} port.*/\\1/p" <<<"$j" | sort -u | tr '\n' ' ')
        cls=$(ip_label "$ip")
        emit WARN ssh:new-source "first SSH login from $ip ($cls)${user:+ as ${user% }}"
      done
    fi
  fi
  return 0
}

check_accounts() {
  local pw grp sud others members got want sudo_lines
  pw=$(fpath passwd /etc/passwd); grp=$(fpath group /etc/group); sud=$(fpath sudoers /etc/sudoers)
  if [[ -r "$pw" ]]; then
    others=$(awk -F: '$3 == 0 && $1 != "root" { print $1 }' "$pw" | tr '\n' ' ')
    if [[ -n "$others" ]]; then emit FAIL accounts "uid 0 accounts besides root: ${others% }"
    else emit OK accounts "root is the only uid 0 account"; fi
  fi
  if [[ -r "$grp" ]]; then
    members=$(awk -F: '$1 == "docker" { print $4 }' "$grp" | tr ',' ' ')
    got=$(tr ' ' '\n' <<<"$members" | sed '/^$/d' | sort -u | tr '\n' ' '); got="${got% }"
    if [[ -n "$SECURITY_DOCKER_USERS" ]]; then
      want=$(tr ' ' '\n' <<<"$SECURITY_DOCKER_USERS" | sed '/^$/d' | sort -u | tr '\n' ' '); want="${want% }"
      if [[ "$got" == "$want" ]]; then emit OK accounts:docker "docker group = $got"
      else emit WARN accounts:docker "docker group is '$got', expected '$want' (docker group = root)"; fi
    elif grep -q '^docker:' "$grp"; then emit INFO accounts:docker "docker group (root-equivalent): ${got:-nobody}"; fi
  fi
  local files=()
  if [[ -n "$FIX" ]]; then [[ -f "$sud" ]] && files=("$sud")
  else
    [[ -r /etc/sudoers ]] && files+=(/etc/sudoers)
    local x; for x in /etc/sudoers.d/*; do [[ -f "$x" && -r "$x" ]] && files+=("$x"); done
  fi
  if (( ${#files[@]} == 0 )); then
    [[ -z "$FIX" ]] && emit INFO accounts:sudo "could not read sudoers (needs root?)"
    return 0
  fi
  sudo_lines=$(cat "${files[@]}" 2>/dev/null | grep -vE '^[[:space:]]*(#|Defaults)' | grep 'NOPASSWD' \
    | awk '{ u = $1; scope = ($0 ~ /NOPASSWD: *ALL *$/) ? "ALL" : "limited"; if (!(u in s) || scope == "ALL") s[u] = scope }
           END { for (u in s) print u, s[u] }' | sort)
  if [[ -n "$sudo_lines" ]]; then
    local desc
    desc=$(awk '{ printf "%s%s (%s)", (NR > 1 ? ", " : ""), $1, $2 }' <<<"$sudo_lines")
    if [[ -n "$SECURITY_SUDO_USERS" ]]; then
      got=$(awk '{ print $1 }' <<<"$sudo_lines" | sort -u | tr '\n' ' ')
      want=$(tr ' ' '\n' <<<"$SECURITY_SUDO_USERS" | sed '/^$/d' | sort -u | tr '\n' ' ')
      if [[ "$got" == "$want" ]]; then emit OK accounts:sudo "NOPASSWD sudo: $desc"
      else emit WARN accounts:sudo "NOPASSWD sudo is '${got% }', expected '${want% }'"; fi
    else
      emit INFO accounts:sudo "NOPASSWD sudo: $desc"
    fi
  fi
  return 0
}

# item<TAB>hash lines for the persistence baseline (names only ever leave this function, never contents).
persist_items() {
  if [[ -n "$FIX" ]]; then [[ -f "$FIX/persist_items" ]] && cat "$FIX/persist_items"; return 0; fi
  local f u v
  shopt -s nullglob
  for f in /root/.ssh/authorized_keys* /home/*/.ssh/authorized_keys*; do
    [[ -f "$f" ]] && printf 'authorized_keys:%s\t%s\n' "$f" "$(hash_file "$f")"
  done
  for f in /etc/sudoers /etc/sudoers.d/*; do [[ -f "$f" ]] && printf 'sudoers:%s\t%s\n' "$f" "$(hash_file "$f")"; done
  awk -F: '{ print $1 "\t" $3 ":" $7 }' /etc/passwd 2>/dev/null | while IFS=$'\t' read -r u v; do
    printf 'account:%s\t%s\n' "$u" "$(printf '%s' "$v" | hash_stdin)"
  done
  for u in docker sudo; do
    v=$(grep "^$u:" /etc/group 2>/dev/null)
    [[ -n "$v" ]] && printf 'group:%s\t%s\n' "$u" "$(printf '%s' "$v" | hash_stdin)"
  done
  for f in /etc/systemd/system/*.service /etc/systemd/system/*.timer; do
    printf 'unit:%s\t%s\n' "${f##*/}" "$(hash_file "$f")"
  done
  shopt -u nullglob
}

check_persistence() {
  local f items diff count changed
  items=$(persist_items | LC_ALL=C sort)
  [[ -n "$items" ]] || { emit INFO persistence "nothing to baseline"; return 0; }
  count=$(wc -l <<<"$items" | tr -d ' ')
  if ! ensure_state_dir; then emit INFO persistence "state dir $SEC_STATE not writable; baseline skipped"; return 0; fi
  f="$SEC_STATE/security-baseline"
  if [[ ! -s "$f" ]]; then
    printf '%s\n' "$items" >"$f.tmp.$$" && mv -f "$f.tmp.$$" "$f" && chmod 600 "$f"
    emit INFO persistence "baseline created ($count items: authorized_keys, sudoers, accounts, groups, systemd units)"
    return 0
  fi
  diff=$(printf '%s\n' "$items" | awk -F'\t' -v old="$f" '
    BEGIN { while ((getline l < old) > 0) { split(l, p, "\t"); o[p[1]] = p[2] } }
    { n[$1] = $2; if (!($1 in o)) print "added " $1; else if (o[$1] != $2) print "changed " $1 }
    END { for (k in o) if (!(k in n)) print "removed " k }' | LC_ALL=C sort)
  if [[ -z "$diff" ]]; then emit OK persistence "$count items unchanged (keys, sudoers, accounts, units)"; return 0; fi
  # "added: a, b; changed: c; removed: d" (at most 6 names per kind)
  changed=$(awk '{ c[$1]++; if (c[$1] <= 6) a[$1] = a[$1] (a[$1] == "" ? "" : ", ") $2 }
                 END { split("added changed removed", ks, " ")
                       for (i = 1; i <= 3; i++) { k = ks[i]; if (!(k in a)) continue
                         printf "%s%s: %s%s", (o++ ? "; " : ""), k, a[k], (c[k] > 6 ? " +" (c[k] - 6) " more" : "") } }' <<<"$diff")
  emit WARN persistence "since last run: $changed"
  printf '%s\n' "$items" >"$f.tmp.$$" && mv -f "$f.tmp.$$" "$f" && chmod 600 "$f"
  return 0
}

check_secrets() {
  local m f bad=() hits=() found="" open=false
  if [[ -n "${INSTALL_DIR:-}" && -d "$INSTALL_DIR" ]]; then
    m=$(file_mode "$INSTALL_DIR")
    if [[ -n "$m" ]] && (( (8#$m & 4) != 0 )); then emit WARN secrets "$INSTALL_DIR is world-readable (mode $m)"; fi
    [[ -n "$m" ]] && (( (8#$m & 1) != 0 )) && open=true
    for f in "$INSTALL_DIR"/crons/env.d/*; do
      [[ -f "$f" ]] || continue
      m=$(file_mode "$f")
      [[ "$m" == 600 || "$m" == 400 ]] || bad+=("${f##*/} ($m)")
    done
    (( ${#bad[@]} > 0 )) && emit WARN secrets "cron env files not mode 600: $(join_by ', ' "${bad[@]}")"
    # World-readable files only matter when other users can enter the install dir (o+x).
    if $open; then
      found=$(find "$INSTALL_DIR" -maxdepth 3 \( -name '*.env' -o -name '*.pem' -o -name '*.key' \) -perm -o+r -type f 2>/dev/null | head -10)
      [[ -n "$found" ]] && emit WARN secrets "world-readable secret-like files in an install dir other users can enter: $(tr '\n' ' ' <<<"$found" | sed 's/ $//')"
    fi
  fi
  # World-readable places where a Telegram bot token must never appear (names only, never the match).
  for f in "$CRON_DIR"/* "$MANIFEST_DIR"/*.env; do
    [[ -f "$f" ]] || continue
    grep -qE '[0-9]{8,}:[A-Za-z0-9_-]{30,}' "$f" 2>/dev/null && hits+=("$f")
  done
  (( ${#hits[@]} > 0 )) && emit FAIL secrets "Telegram-token-shaped string in world-readable $(join_by ', ' "${hits[@]}")"
  if (( ${#bad[@]} + ${#hits[@]} == 0 )) && [[ -z "$found" ]]; then
    emit OK secrets "install dir closed or clean, cron env files 600, no tokens in $CRON_DIR or $MANIFEST_DIR"
  fi
  return 0
}


# --- Outbound sampler -------------------------------------------------------

# current outbound connections to public remotes -> "proc|ip|port" (sorted, unique)
outbound_now() {
  local l e
  l=$(ss_listen) || return 1
  e=$(ss_est) || return 1
  awk "$AWK_IP"'
    FNR == NR { lp[addrport($4)] = 1; next }
    NF >= 4 {
      if (addrport($3) in lp) next
      r = $4; h = addrhost(r); if (ipclass(h) != "public") next
      proc = "?"; if (match($0, /\(\("[^"]*"/)) proc = substr($0, RSTART + 3, RLENGTH - 4)
      gsub(/\|/, "/", proc)
      print proc "|" h "|" addrport(r)
    }' <(printf '%s\n' "$l") <(printf '%s\n' "$e") | sort -u
}

# Merge the current snapshot into conn-seen (proc|ip|port|first|last; #created=). Flocked; quiet.
sample_outbound() {
  ensure_state_dir || return 1
  local f="$SEC_STATE/conn-seen" now_list tmp
  if command -v flock >/dev/null 2>&1; then
    exec 8>"$SEC_STATE/conn-seen.lock" || return 1
    flock -w 3 8 || return 1
  fi
  now_list=$(outbound_now) || return 1
  tmp="$f.tmp.$$"
  { [[ -f "$f" ]] && cat "$f"; echo "#snapshot"; printf '%s\n' "$now_list"; } | awk -v now="$NOW" -v keep="$((SECURITY_CONN_KEEP_DAYS * 86400))" '
    BEGIN { FS = OFS = "|" }
    /^#created=/ { created = substr($0, 10); next }
    /^#snapshot/ { snap = 1; next }
    !snap && NF >= 5 { k = $1 "|" $2 "|" $3; first[k] = $4; last[k] = $5; next }
    snap && NF >= 3 { k = $1 "|" $2 "|" $3; if (!(k in first)) first[k] = now; last[k] = now }
    END {
      print "#created=" (created == "" ? now : created)
      for (k in first) if (last[k] + keep >= now) print k, first[k], last[k]
    }' | { IFS= read -r hdr; printf '%s\n' "$hdr"; sort -t'|' -k5,5nr | head -n "$SECURITY_CONN_MAX"; } >"$tmp" \
    && mv -f "$tmp" "$f" && chmod 600 "$f"
  rm -f "$tmp"
  return 0
}

check_outbound() {
  local f created learning=0 res nowc
  if ! sample_outbound; then
    if [[ -z "$(ss_est 2>/dev/null)" ]]; then emit INFO outbound "could not read connections (ss missing or not root)"; return 0; fi
    # No state: fall back to a plain snapshot.
    nowc=$(outbound_now | awk -F'|' -v ok=" $SECURITY_OUTBOUND_OK_PORTS " 'index(ok, " " $3 " ") == 0 { printf "%s%s → %s:%s", (n++ ? ", " : ""), $1, $2, $3 } n >= 5 { exit }')
    [[ -n "$nowc" ]] && emit WARN outbound "connections on unusual ports now: $nowc"
    emit INFO outbound "state dir $SEC_STATE not writable; tracking new destinations is off"
    return 0
  fi
  f="$SEC_STATE/conn-seen"
  created=$(sed -n 's/^#created=//p' "$f" | head -1)
  [[ -n "$created" ]] && (( NOW - created < SECURITY_CONN_LEARN_DAYS * 86400 )) && learning=1
  res=$(awk -v since="$((NOW - 86400))" -v learning="$learning" -v ok="$SECURITY_OUTBOUND_OK_PORTS" \
            -v kprocs="$SECURITY_KNOWN_PROCS" -v kremotes="$SECURITY_KNOWN_REMOTES" '
    BEGIN { FS = "|"; split(ok, t, " "); for (i in t) okp[t[i]] = 1
            split(kprocs, t, " "); for (i in t) kp[t[i]] = 1; split(kremotes, t, " "); for (i in t) kr[t[i]] = 1 }
    /^#/ { next }
    NF >= 5 { k++; P[k] = $1; I[k] = $2; R[k] = $3; F[k] = $4; total++; if ($4 < since) known[$1] = 1 }
    END {
      for (j = 1; j <= k; j++) {
        if (F[j] < since) continue
        if ((I[j] in kr) || ((I[j] ":" R[j]) in kr)) continue
        if (learning) { nl++; continue }
        newp = !(P[j] in known) && !(P[j] in kp) && P[j] != "?"
        badport = !(R[j] in okp)
        dest = (I[j] ~ /:/ ? "[" I[j] "]" : I[j]) ":" R[j]
        if (newp || badport) {
          if (!(P[j] in why)) { order[++np] = P[j]; why[P[j]] = (newp ? "new process" : "unusual port") }
          else if (newp) why[P[j]] = "new process"
          cnt[P[j]]++; if (shown < 8) { d[P[j]] = d[P[j]] (d[P[j]] == "" ? "" : ", ") dest; shown++ } else more[P[j]]++
        } else nok++
      }
      for (i = 1; i <= np; i++) { p = order[i]; print "W|" p " (" why[p] ")|" (d[p] == "" ? "" : d[p]) (more[p] ? " +" more[p] " more" : "") }
      print "S|" nl + 0 "|" nok + 0 "|" total + 0
    }' "$f")
  local s_nl s_ok s_total
  while IFS='|' read -r kind a b c; do
    case "$kind" in
      W) emit WARN outbound:new "$a → $b" ;;
      S) s_nl=$a; s_ok=$b; s_total=$c ;;
    esac
  done <<<"$res"
  if (( learning )); then
    local day=$(( (NOW - created) / 86400 + 1 ))
    emit INFO outbound "learning baseline (day $day of $SECURITY_CONN_LEARN_DAYS): ${s_nl:-0} new destination(s) in 24 h, ${s_total:-0} known"
  else
    (( ${s_ok:-0} > 0 )) && emit INFO outbound "${s_ok} new IP(s) on usual ports from known processes in 24 h"
    grep -q '^W' <<<"$res" || emit OK outbound "no new processes or unusual ports in outbound connections (${s_total:-0} destinations known)"
  fi
  return 0
}

check_processes() {
  local list pid exe hits=() p
  if [[ -n "$FIX" ]]; then list=$(cat "$FIX/proc_exe" 2>/dev/null) || return 0
  else
    [[ -d /proc/1 ]] || return 0
    list=$(for p in /proc/[0-9]*; do exe=$(readlink "$p/exe" 2>/dev/null) && [[ -n "$exe" ]] && printf '%s %s\n' "${p#/proc/}" "$exe"; done)
  fi
  while read -r pid exe; do
    [[ -n "$exe" ]] || continue
    exe="${exe% (deleted)}"
    glob_match "$exe" "$SECURITY_EXE_OK" && continue
    case "$exe" in
      /dev/shm/*|/var/tmp/*) hits+=("pid $pid $exe") ;;
      /home/*|/root/*) ;;   # dot-dirs in homes (~/.nvm, ~/.local) are normal
      */.*) hits+=("pid $pid $exe") ;;
    esac
  done <<<"$list"
  if (( ${#hits[@]} > 0 )); then
    local shown=("${hits[@]:0:5}")
    (( ${#hits[@]} > 5 )) && shown+=("+$(( ${#hits[@]} - 5 )) more")
    emit WARN processes "running from /dev/shm, /var/tmp or a hidden dir: $(join_by '; ' "${shown[@]}")"
  else
    emit OK processes "no processes running from /dev/shm, /var/tmp or hidden system dirs"
  fi
  return 0
}

check_updates() {
  local en conf
  if [[ -z "$FIX" ]] && ! command -v apt-get >/dev/null 2>&1; then return 0; fi
  en=$(run_cmd uu_enabled 5 systemctl is-enabled unattended-upgrades)
  conf=$(fpath auto_upgrades /etc/apt/apt.conf.d/20auto-upgrades)
  if [[ "$en" == enabled ]] && grep -qE 'Unattended-Upgrade +"1"' "$conf" 2>/dev/null; then
    emit OK updates "unattended-upgrades enabled"
  elif [[ "$en" == enabled ]]; then
    emit WARN updates "unattended-upgrades service enabled but APT::Periodic::Unattended-Upgrade is not \"1\""
  elif [[ -z "$en" && ! -f "$conf" ]]; then
    [[ -z "$FIX" ]] && emit WARN updates "unattended-upgrades not installed"
  else
    emit WARN updates "unattended-upgrades is ${en:-not enabled}"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Custom checks: executable *.sh in SECURITY_DIR
# ---------------------------------------------------------------------------

LINE_RE='^(OK|WARN|FAIL|INFO)\|[^|]*\|'

run_custom() {
  [[ -n "$SECURITY_DIR" && -d "$SECURITY_DIR" ]] || return 0
  local f name out rc bad line
  for f in "$SECURITY_DIR"/*.sh; do
    [[ -f "$f" ]] || continue
    name="security.d/${f##*/}"
    if [[ ! -x "$f" ]]; then emit INFO "$name" "not executable; skipped"; continue; fi
    if [[ -n "$TIMEOUT_BIN" ]]; then
      out=$("$TIMEOUT_BIN" -k 2 "$SECURITY_CHECK_TIMEOUT" "$f" 2>/dev/null </dev/null); rc=$?
    else
      out=$("$f" 2>/dev/null </dev/null); rc=$?
    fi
    bad=0
    while IFS= read -r line; do
      line="${line%$'\r'}"
      [[ -n "$line" ]] || continue
      if [[ "$line" =~ $LINE_RE ]]; then
        local st="${line%%|*}" rest="${line#*|}"
        emit "$st" "${rest%%|*}" "${rest#*|}"
      else
        bad=$((bad + 1))
      fi
    done <<<"$out"
    (( bad > 0 )) && emit WARN "$name" "malformed output ($bad line(s) not STATUS|label|detail)"
    if (( rc == 124 || rc == 137 )) && [[ -n "$TIMEOUT_BIN" ]]; then emit WARN "$name" "timed out after ${SECURITY_CHECK_TIMEOUT}s"
    elif (( rc != 0 )); then emit WARN "$name" "failed (exit $rc)"; fi
  done
  return 0
}

# ---------------------------------------------------------------------------
# Telegram rendering
# ---------------------------------------------------------------------------

# Quoted replacements: literal on bash 3.2 and with bash 5.2's patsub_replacement (& = match).
html_esc() {
  local s="$1" amp='&amp;' lt='&lt;' gt='&gt;'
  s=${s//&/"$amp"}; s=${s//</"$lt"}; s=${s//>/"$gt"}
  printf '%s' "$s"
}
trunc() {  # TEXT MAXBYTES (cuts on a UTF-8 boundary, adds …)
  local s="$1" n="$2"
  local LC_ALL=C
  (( ${#s} <= n )) && { printf '%s' "$s"; return; }
  s="${s:0:n}"
  while [[ -n "$s" && "${s: -1}" == [!\ -~] ]]; do s="${s%?}"; done
  printf '%s…' "$s"
}
tg_line() {  # EMOJI LABEL DETAIL
  local label="$2"
  label="${label#reachable:}"
  printf '%s %s: %s' "$1" "$(html_esc "$label")" "$(html_esc "$(trunc "$3" 160)")"
}

render_telegram() {  # RESULTS_FILE
  local st label detail probs=() fails=() warns=() reach=() infos=() okn=0 issues=0
  while IFS='|' read -r st label detail; do
    case "$st" in
      FAIL|WARN) issues=$((issues + 1)) ;;
    esac
    if [[ "$label" == reachable:* ]]; then
      case "$st" in
        FAIL) reach+=("$(tg_line 🔴 "$label" "$detail")") ;;
        WARN) reach+=("$(tg_line ⚠️ "$label" "$detail")") ;;
        INFO) reach+=("$(tg_line 🌐 "$label" "$detail")") ;;
        OK) okn=$((okn + 1)) ;;
      esac
      continue
    fi
    case "$st" in
      FAIL) fails+=("$(tg_line 🔴 "$label" "$detail")") ;;
      WARN) warns+=("$(tg_line ⚠️ "$label" "$detail")") ;;
      OK) okn=$((okn + 1)) ;;
      INFO) infos+=("$(tg_line ℹ️ "$label" "$detail")") ;;
    esac
  done <"$1"
  probs=("${fails[@]}" "${warns[@]}")   # FAIL lines first

  local max="$SECURITY_TELEGRAM_MAX_LINES" more=0 reach_max=10 room
  local nreach=${#reach[@]}
  (( nreach > reach_max )) && { more=$((more + nreach - reach_max)); reach=("${reach[@]:0:reach_max}"); nreach=$reach_max; }
  room=$(( max - nreach - (okn > 0 ? 1 : 0) - 1 ))
  (( room < 3 )) && room=3
  if (( ${#probs[@]} > room )); then more=$((more + ${#probs[@]} - room)); probs=("${probs[@]:0:room}"); fi
  room=$(( max - nreach - ${#probs[@]} - (okn > 0 ? 1 : 0) - 1 ))
  (( room > SECURITY_TELEGRAM_MAX_INFO )) && room=$SECURITY_TELEGRAM_MAX_INFO
  (( room < 0 )) && room=0
  if (( ${#infos[@]} > room )); then more=$((more + ${#infos[@]} - room)); infos=("${infos[@]:0:room}"); fi

  # Character budget: drop INFO lines first, then the OK summary, then problems; keep the reach block.
  local body text okline=""
  (( okn > 0 )) && okline="✅ $okn checks OK"
  while :; do
    body="<b>Security:</b>"
    local x
    for x in "${probs[@]}"; do body+=$'\n'"$x"; done
    if (( ${#reach[@]} > 0 )); then
      body+=$'\n'"<i>Reachable from the internet:</i>"
      for x in "${reach[@]}"; do body+=$'\n'"$x"; done
    fi
    [[ -n "$okline" ]] && body+=$'\n'"$okline"
    for x in "${infos[@]}"; do body+=$'\n'"$x"; done
    text="$body"
    (( more > 0 )) && text+=$'\n'"… +$more more (see logs/host_security.log)"
    if (( $(blen "$text") <= SECURITY_TELEGRAM_BUDGET )); then break; fi
    if (( ${#infos[@]} > 0 )); then infos=("${infos[@]:0:${#infos[@]}-1}"); more=$((more + 1))
    elif [[ -n "$okline" ]]; then okline=""
    elif (( ${#probs[@]} > 1 )); then probs=("${probs[@]:0:${#probs[@]}-1}"); more=$((more + 1))
    elif (( ${#reach[@]} > 1 )); then reach=("${reach[@]:0:${#reach[@]}-1}"); more=$((more + 1))
    else text=$(trunc "$text" "$SECURITY_TELEGRAM_BUDGET"); break
    fi
  done
  printf '%s\n' "$text"
  printf 'ISSUES=%d\n' "$issues"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

WORK=$(mktemp -d "${TMPDIR:-/tmp}/host_security.XXXXXX") || { echo "host_security: cannot create temp dir" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT

if [[ "$MODE" == sample ]]; then
  sample_outbound >/dev/null 2>&1
  exit 0
fi

RESULTS="$WORK/results"
: >"$RESULTS"
if [[ "$SECURITY_BUILTIN" == true ]]; then
  for c in $ALL_CHECKS; do
    skipped "$c" && continue
    out=$( "check_$c" 2>/dev/null ); rc=$?
    if [[ -n "$out" ]]; then
      while IFS= read -r line; do
        if [[ "$line" =~ $LINE_RE ]]; then printf '%s\n' "$line" >>"$RESULTS"
        else emit WARN "$c" "internal: malformed result line" >>"$RESULTS"; fi
      done <<<"$out"
    elif (( rc != 0 )); then
      emit WARN "$c" "check failed to run (exit $rc)" >>"$RESULTS"
    fi
  done
fi
skipped custom || run_custom >>"$RESULTS"

if [[ "$MODE" == telegram ]]; then
  if [[ -n "${INSTALL_DIR:-}" && -d "${INSTALL_DIR}/logs" ]]; then
    { printf '=== %s host_security ===\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"; cat "$RESULTS"; } >>"${INSTALL_DIR}/logs/host_security.log" 2>/dev/null
  fi
  render_telegram "$RESULTS"
else
  cat "$RESULTS"
fi
exit 0
