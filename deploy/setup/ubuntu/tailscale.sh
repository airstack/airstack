#!/bin/bash
set -euo pipefail
# tailscale.sh — Install Tailscale and join the tailnet.
#
# Optional env:
#   VPS_HOSTNAME       Tailnet machine name (default: current hostname)
#   TAILSCALE_AUTHKEY  Pre-auth key for unattended login. Without it,
#                      `tailscale up` prints a login URL and waits (up to 10 min).
#
# Re-runnable: skips install if present, skips login if already connected.
# Sets netfilter-mode=nodivert so UFW (not tailscale) filters tailnet traffic;
# which ports the tailnet may reach is applied on deploy by the tailscale plugin.
#
# Output: SETUP_TAILSCALE_OK on success

CURRENT_STEP=""
trap 'if [ $? -ne 0 ]; then echo "FAILED during: ${CURRENT_STEP:-unknown step}" >&2; fi' EXIT

VPS_HOSTNAME="${VPS_HOSTNAME:-$(hostname)}"
TAILSCALE_AUTHKEY="${TAILSCALE_AUTHKEY:-}"

# ── 1. Install ───────────────────────────────────────────────────────────────

if command -v tailscale &>/dev/null; then
  echo "==> Tailscale already installed: $(tailscale version | head -1)"
else
  CURRENT_STEP="Tailscale repository"
  echo "==> Installing Tailscale..."

  # Tailscale publishes per-codename repos; packages are static binaries, so
  # fall back to the latest LTS repo when this release isn't published yet.
  CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  if ! curl -fsSI "https://pkgs.tailscale.com/stable/ubuntu/${CODENAME}.noarmor.gpg" >/dev/null; then
    echo "  No Tailscale repo for '${CODENAME}', using 'noble'"
    CODENAME=noble
  fi

  install -m 0755 -d /usr/share/keyrings
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${CODENAME}.noarmor.gpg" \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${CODENAME}.tailscale-keyring.list" \
    -o /etc/apt/sources.list.d/tailscale.list

  CURRENT_STEP="Tailscale package"
  apt update
  apt install -y tailscale
  echo "  Tailscale installed: $(tailscale version | head -1)"
fi

CURRENT_STEP="tailscaled service"
systemctl enable --now tailscaled

# ── 2. Join the tailnet ──────────────────────────────────────────────────────

if tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
  echo "==> Already connected to tailnet"
else
  CURRENT_STEP="tailscale up"
  echo "==> Joining tailnet as '${VPS_HOSTNAME}'..."
  if [ -n "$TAILSCALE_AUTHKEY" ]; then
    # Pass the key by file, never on the command line (visible in ps / process accounting).
    KEYFILE="$(mktemp)"
    chmod 600 "$KEYFILE"
    printf '%s' "$TAILSCALE_AUTHKEY" > "$KEYFILE"
    tailscale up --hostname="${VPS_HOSTNAME}" --auth-key="file:${KEYFILE}"; rc=$?
    shred -u "$KEYFILE" 2>/dev/null || rm -f "$KEYFILE"
    [ "$rc" -eq 0 ] || exit "$rc"
  else
    echo "  No TAILSCALE_AUTHKEY. Open the login URL below to let this machine join the tailnet."
    tailscale up --hostname="${VPS_HOSTNAME}" --timeout=600s
  fi
fi

# ── 3. Let UFW filter tailnet traffic ────────────────────────────────────────
# By default tailscaled jumps INPUT → ts-input, which ACCEPTs everything on
# tailscale0 before UFW runs, exposing every host port to the whole tailnet.
# nodivert keeps tailscale's chains but drops the jump, so the tailscale
# plugin's per-port UFW rules (plugins.tailscale.ports) are what decide.

CURRENT_STEP="netfilter nodivert"
tailscale set --netfilter-mode=nodivert
if iptables -C INPUT -j ts-input 2>/dev/null; then
  echo "ERROR: tailnet traffic still skips UFW after --netfilter-mode=nodivert (INPUT still jumps to ts-input)" >&2
  exit 1
fi
echo "  Netfilter: nodivert (UFW rules now apply to tailscale0)"

# WireGuard port for direct (non-relayed) peer connections. Only tailscaled
# listens here; outbound-initiated connections work even without it.
CURRENT_STEP="UFW tailscale UDP"
ufw allow 41641/udp comment 'tailscale wireguard' >/dev/null
echo "  UFW: 41641/udp allowed"

echo "  Tailnet IPv4: $(tailscale ip -4)"
echo "  Tailnet name: $(tailscale status --json | grep -m1 '"DNSName"' | sed -E 's/.*"DNSName": *"([^"]*[^."])\.?".*/\1/')"
echo "SETUP_TAILSCALE_OK"
