#!/bin/bash
set -euo pipefail
# verify.sh — Verify VPS is ready for stack deployment.
# Checks all setup steps from base, harden, and docker.
#
# Optional env:
#   SSH_PORT       Expected SSH port (default: 22)
#   SUDO_USER      Expected admin user (default: admin)
#   APP_USER       Expected app user (default: deploy)
#   INSTALL_DIR    Expected install directory
#   INSTALL_SYSBOX "true" to also verify the Sysbox runtime (default: false)
#
# Output: Per-check pass/fail, final VERIFY_OK or VERIFY_FAILED

SSH_PORT="${SSH_PORT:-22}"
SUDO_USER="${SUDO_USER:-admin}"
APP_USER="${APP_USER:-deploy}"
INSTALL_SYSBOX="${INSTALL_SYSBOX:-false}"
INSTALL_DIR="${INSTALL_DIR:?INSTALL_DIR is required}"

PASS=0
FAIL=0
WARN=0

pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  [WARN] $1"; WARN=$((WARN + 1)); }

echo "=== VPS Setup Verification ==="
echo ""

# ── Users ────────────────────────────────────────────────────────────────────

echo "Users:"
if id "${SUDO_USER}" &>/dev/null; then
  pass "${SUDO_USER} exists"
else
  fail "${SUDO_USER} does not exist"
fi

if sudo -l -U "${SUDO_USER}" 2>/dev/null | grep -q 'NOPASSWD: ALL'; then
  pass "${SUDO_USER} has passwordless sudo"
else
  fail "${SUDO_USER} missing passwordless sudo"
fi

if id "${APP_USER}" &>/dev/null; then
  pass "${APP_USER} exists (uid $(id -u "${APP_USER}"))"
else
  fail "${APP_USER} does not exist"
fi
echo ""

# ── Packages ─────────────────────────────────────────────────────────────────

echo "Packages:"
for pkg in docker-ce cronie fail2ban ufw auditd; do
  if dpkg -l "${pkg}" 2>/dev/null | grep -q '^ii'; then
    pass "${pkg} installed"
  else
    fail "${pkg} not installed"
  fi
done

if [ "${INSTALL_SYSBOX}" = "true" ]; then
  if dpkg -l sysbox-ce 2>/dev/null | grep -q '^ii'; then
    SYSBOX_VER=$(dpkg -l sysbox-ce | awk '/^ii/{print $3}')
    pass "sysbox-ce installed (${SYSBOX_VER})"
  else
    fail "sysbox-ce not installed"
  fi
fi
echo ""

# ── Services ─────────────────────────────────────────────────────────────────

echo "Services:"
SERVICES="docker fail2ban ufw"
[ "${INSTALL_SYSBOX}" = "true" ] && SERVICES="docker sysbox fail2ban ufw"
for svc in ${SERVICES}; do
  if [ "${svc}" = "ufw" ] && ufw status 2>/dev/null | grep -q '^Status: active'; then
    # The firewall is what matters; the ufw.service oneshot can read "inactive" on some images.
    pass "ufw active (rules loaded)"
  elif systemctl is-active --quiet "${svc}" 2>/dev/null; then
    pass "${svc} running"
  else
    fail "${svc} not running"
  fi
done
echo ""

# ── UFW Rules ────────────────────────────────────────────────────────────────

echo "Firewall:"
if ufw status | grep -q "Status: active"; then
  pass "UFW active"
else
  fail "UFW not active"
fi

if ufw status | grep -qE "^${SSH_PORT}/tcp\s+ALLOW"; then
  pass "Port ${SSH_PORT} allowed"
else
  fail "Port ${SSH_PORT} not allowed in UFW"
fi

if ufw status | grep -qE "^22/tcp\s+ALLOW" && [ "${SSH_PORT}" != "22" ]; then
  warn "Port 22 is still open (to close it: airstack deploy <machine> --install --step harden --finalize)"
else
  pass "Port 22 not open (or is the SSH port)"
fi
echo ""

# ── SSH Config ───────────────────────────────────────────────────────────────

echo "SSH:"
if [ -f /etc/ssh/sshd_config.d/hardening.conf ]; then
  pass "Hardening config exists"

  if grep -q "PermitRootLogin no" /etc/ssh/sshd_config.d/hardening.conf; then
    pass "Root login disabled"
  else
    fail "Root login not disabled"
  fi

  if grep -q "PasswordAuthentication no" /etc/ssh/sshd_config.d/hardening.conf; then
    pass "Password auth disabled (key-only)"
  else
    fail "Password auth not disabled"
  fi

  if grep -qE "^Port ${SSH_PORT}$" /etc/ssh/sshd_config.d/hardening.conf; then
    pass "SSH port set to ${SSH_PORT}"
  else
    warn "SSH port in hardening.conf is not ${SSH_PORT}"
  fi
else
  fail "SSH hardening config not found"
fi

if ss -tlnp | grep -q ":${SSH_PORT} "; then
  pass "SSH listening on port ${SSH_PORT}"
else
  fail "SSH not listening on port ${SSH_PORT}"
fi
echo ""

# ── Docker Daemon ────────────────────────────────────────────────────────────

echo "Docker daemon:"
if [ -f /etc/docker/daemon.json ]; then
  pass "daemon.json exists"

  if grep -q '"127.0.0.1"' /etc/docker/daemon.json; then
    pass "Bound to localhost only"
  else
    fail "Not bound to localhost"
  fi

  if grep -q '"no-new-privileges": true' /etc/docker/daemon.json; then
    pass "no-new-privileges enabled"
  else
    fail "no-new-privileges not set"
  fi
else
  fail "daemon.json not found"
fi

# Check docker group membership
if id "${APP_USER}" 2>/dev/null | grep -q docker; then
  pass "${APP_USER} in docker group"
else
  fail "${APP_USER} not in docker group"
fi

# Layout (docs/LAYOUT.md): only the stack owner holds root Docker; it has no login.
DEV_USERS="${DEV_USERS:-}"
for u in $(getent group docker | cut -d: -f4 | tr ',' ' '); do
  [ "${u}" = "${APP_USER}" ] && continue
  warn "${u} is in the docker group (root-level power). Dev users should use rootless Docker (airstack deploy <machine> --install --step rootless)"
done
shell="$(getent passwd "${APP_USER}" | cut -d: -f7)"
case "${shell}" in
  */nologin|*/false) pass "${APP_USER} has no login shell" ;;
  *) warn "${APP_USER} has shell ${shell}. The stack owner has root-level power and should use /usr/sbin/nologin" ;;
esac
if [ -e "/home/${APP_USER}/.ssh/authorized_keys" ] || [ -e "/var/lib/${APP_USER}/.ssh/authorized_keys" ]; then
  warn "${APP_USER} has SSH authorized_keys; the stack owner must not be reachable over SSH"
fi
for dev in ${DEV_USERS//,/ }; do
  id "${dev}" &>/dev/null || { fail "dev user ${dev} does not exist"; continue; }
  uid="$(id -u "${dev}")"
  if [ -S "/run/user/${uid}/docker.sock" ]; then pass "${dev} has a rootless Docker socket"; else warn "${dev} has no rootless Docker (airstack deploy <machine> --install --step rootless)"; fi
done
echo ""

# ── Sysbox (optional) ────────────────────────────────────────────────────────

if [ "${INSTALL_SYSBOX}" = "true" ]; then
  echo "Sysbox:"
  if systemctl show sysbox-mgr --property=ExecStart 2>/dev/null | grep -q 'disable-ovfs-on-idmapped-mount'; then
    pass "ID-mapped mount override active"
  else
    fail "ID-mapped mount override not applied"
  fi

  if docker info 2>/dev/null | grep -qi sysbox; then
    pass "Sysbox runtime registered in Docker"
  else
    fail "Sysbox runtime not found in Docker info"
  fi
  echo ""
fi

# ── Swap & Sysctl ────────────────────────────────────────────────────────────

echo "System:"
if swapon --show --noheadings | grep -q .; then
  SWAP_SIZE=$(swapon --show --noheadings | awk '{print $1 " " $3}' | paste -sd, -)
  pass "Swap active (${SWAP_SIZE})"
else
  warn "Swap not active"
fi

if [ "$(sysctl -n vm.swappiness 2>/dev/null)" = "10" ]; then
  pass "Swappiness = 10"
else
  warn "Swappiness != 10 ($(sysctl -n vm.swappiness 2>/dev/null))"
fi

if [ "$(sysctl -n net.ipv4.tcp_syncookies 2>/dev/null)" = "1" ]; then
  pass "SYN cookies enabled"
else
  fail "SYN cookies not enabled"
fi

if [ "$(sysctl -n kernel.randomize_va_space 2>/dev/null)" = "2" ]; then
  pass "ASLR enabled"
else
  fail "ASLR not enabled"
fi
echo ""

# ── Summary ──────────────────────────────────────────────────────────────────

echo "=== Summary ==="
echo "  Passed: ${PASS}"
echo "  Failed: ${FAIL}"
echo "  Warnings: ${WARN}"
echo ""

if [ "${FAIL}" -gt 0 ]; then
  echo "VERIFY_FAILED"
  exit 1
else
  echo "VERIFY_OK"
  exit 0
fi
