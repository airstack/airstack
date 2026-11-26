#!/bin/sh
# leak-scan.sh — refuse real fleet values in committed files.
#
# Fails (exit 1) when tracked or to-be-committed files contain:
#   1. an IPv4 address (or global IPv6 outside 2001:db8::/32) outside private / loopback / CGNAT / documentation ranges
#      (allowed: 0.0.0.0, 127/8, 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16,
#       192.0.2/24, 198.51.100/24, 203.0.113/24, 255.255.255.255, 1.1.1.1, 8.8.8.8)
#   2. generic secret shapes (Google API key, sk- keys, GitHub tokens, Telegram bot tokens)
#   3. any pattern in .git/info/leakscan (one ERE per line; the owner's real IPs, domains,
#      machine names). That file is local to each clone and never committed.
#
# Usage: devutils/leak-scan.sh          scan tracked + untracked (not ignored) files
#        devutils/leak-scan.sh --staged scan only the staged versions (pre-commit hook)
# Exit:  0 clean, 1 findings, 2 usage/internal error.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

mode=all
[ "${1:-}" = "--staged" ] && mode=staged

tmp=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp"' EXIT

# Collect "path:line:text" for the scan target.
if [ "$mode" = staged ]; then
  git grep --cached -nIE '.' -- . ':!devutils/leak-scan.sh' > "$tmp/all" 2>/dev/null
else
  git grep --untracked -nIE '.' -- . ':!devutils/leak-scan.sh' > "$tmp/all" 2>/dev/null
fi

found=0

# 1. IPv4 addresses outside allowed ranges.
grep -oE '^[^:]+:[0-9]+:|([0-9]{1,3}\.){3}[0-9]{1,3}' "$tmp/all" | awk '
  /^[^:]+:[0-9]+:$/ { loc = $0; next }
  {
    n = split($0, o, ".")
    if (n != 4) next
    for (i = 1; i <= 4; i++) if (o[i] + 0 > 255) next
    a = o[1] + 0; b = o[2] + 0; c = o[3] + 0
    if ($0 == "0.0.0.0" || $0 == "255.255.255.255" || $0 == "1.1.1.1" || $0 == "8.8.8.8") next
    if (a == 127 || a == 10) next
    if (a == 172 && b >= 16 && b <= 31) next
    if (a == 192 && b == 168) next
    if (a == 100 && b >= 64 && b <= 127) next
    if (a == 169 && b == 254) next
    if (a == 192 && b == 0 && c == 2) next
    if (a == 198 && b == 51 && c == 100) next
    if (a == 203 && b == 0 && c == 113) next
    print "ip: " loc " " $0
  }' > "$tmp/ip"
if [ -s "$tmp/ip" ]; then cat "$tmp/ip"; found=1; fi

# 1b. Global-unicast IPv6 (2000::/3) outside the documentation range 2001:db8::/32.
grep -iE '(^|[^0-9a-f:])[23][0-9a-f]{3}:[0-9a-f]{0,4}:[0-9a-f:]*[0-9a-f]' "$tmp/all" \
  | grep -viE '(^|[^0-9a-f:])2001:0?db8:' > "$tmp/ip6"
if [ -s "$tmp/ip6" ]; then sed 's/^\([^:]*:[0-9]*\):.*/ipv6: \1/' "$tmp/ip6"; found=1; fi

# 2. Generic secret shapes.
if grep -E 'AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|[0-9]{8,10}:[A-Za-z0-9_-]{35}' "$tmp/all" > "$tmp/keys"; then
  sed 's/^\([^:]*:[0-9]*\):.*/key-shape: \1/' "$tmp/keys"; found=1
fi

# 3. Owner-specific patterns (never committed).
if [ -s .git/info/leakscan ]; then
  if grep -E -f .git/info/leakscan "$tmp/all" > "$tmp/own"; then
    sed 's/^\([^:]*:[0-9]*\):.*/fleet-value: \1/' "$tmp/own"; found=1
  fi
fi

if [ "$found" -eq 1 ]; then
  echo "fail leak-scan: real values found (use documentation addresses / example names)" >&2
  exit 1
fi
echo "ok leak-scan: clean"
exit 0
