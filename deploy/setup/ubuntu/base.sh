#!/bin/bash
set -euo pipefail
# base.sh — Install packages, set hostname, create users.
# From: Playbook 02, steps 2.1, 2.1a, 2.2
#
# Required env:
#   SUDO_USER            Admin user to create (default: admin)
#   SUDO_USER_PASSWORD         Password for admin user
#   SSH_AUTHORIZED_KEY   Public key content for admin user
#
# Optional env:
#   APP_USER             Stack-owner account (default: deploy; we suggest "stackroot").
#                        Runs the root Docker stack and owns the deployed files. It is
#                        ROOT-EQUIVALENT (docker group), so it gets no login shell, no
#                        SSH key and a locked password; only the admin can become it
#                        (sudo -u). See docs/LAYOUT.md.
#   APP_USER_SHELL       Shell for APP_USER (default: /usr/sbin/nologin)
#   APP_USER_PASSWORD    Legacy: set a password on APP_USER. Unset = locked (preferred).
#   DEV_USERS            Space/comma-separated dev accounts (e.g. "deployuser"). Bash shell,
#                        locked password, NOT in the docker group, no sudo; each gets its own
#                        rootless Docker via `vps-setup rootless`. Agents and developers run here.
#   VPS_HOSTNAME         Set hostname (skipped if empty)
#   LOCK_ROOT            Lock the root password with `passwd -l` (default: true).
#                        Admin user has passwordless sudo, so root login is
#                        never needed. Set to "false" to leave root unchanged.
#
# Output: SETUP_BASE_OK on success

CURRENT_STEP=""
trap 'if [ $? -ne 0 ]; then echo "FAILED during: ${CURRENT_STEP:-unknown step}" >&2; fi' EXIT

SUDO_USER="${SUDO_USER:-admin}"
APP_USER="${APP_USER:-deploy}"
APP_USER_SHELL="${APP_USER_SHELL:-/usr/sbin/nologin}"
DEV_USERS="${DEV_USERS:-}"

# Validate required vars
if [ -z "${SUDO_USER_PASSWORD:-}" ]; then echo "ERROR: SUDO_USER_PASSWORD is required" >&2; exit 1; fi
if [ -z "${SSH_AUTHORIZED_KEY:-}" ]; then echo "ERROR: SSH_AUTHORIZED_KEY is required" >&2; exit 1; fi

# ── 1. System Update & Packages ─────────────────────────────────────────────

CURRENT_STEP="system update"
echo "==> Updating system packages..."
apt update && apt upgrade -y

CURRENT_STEP="package installation"
echo "==> Installing essential packages..."
apt install -y \
  curl wget git rsync vim htop tmux unzip jq cronie \
  ca-certificates gnupg lsb-release \
  apt-transport-https software-properties-common \
  ufw fail2ban auditd

# ── 2. Set Hostname ─────────────────────────────────────────────────────────

if [ -n "${VPS_HOSTNAME:-}" ]; then
  CURRENT_STEP="hostname"
  echo "==> Setting hostname to: ${VPS_HOSTNAME}"
  hostnamectl set-hostname "${VPS_HOSTNAME}"
else
  echo "==> Hostname: keeping current ($(hostname))"
fi

# ── 3. Create Admin User ────────────────────────────────────────────────────

CURRENT_STEP="admin user creation (${SUDO_USER})"
if id "${SUDO_USER}" &>/dev/null; then
  echo "==> User ${SUDO_USER} already exists, skipping creation"
else
  echo "==> Creating admin user: ${SUDO_USER}"
  useradd -m -s /bin/bash "${SUDO_USER}"
fi

# Always update password + sudo + SSH key (idempotent)
echo "${SUDO_USER}:${SUDO_USER_PASSWORD}" | chpasswd

# Passwordless sudo (required for Claude automation)
echo "${SUDO_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${SUDO_USER}"
chmod 440 "/etc/sudoers.d/${SUDO_USER}"

# SSH authorized key
mkdir -p "/home/${SUDO_USER}/.ssh"
echo "${SSH_AUTHORIZED_KEY}" > "/home/${SUDO_USER}/.ssh/authorized_keys"
chown -R "${SUDO_USER}:${SUDO_USER}" "/home/${SUDO_USER}/.ssh"
chmod 700 "/home/${SUDO_USER}/.ssh"
chmod 600 "/home/${SUDO_USER}/.ssh/authorized_keys"

echo "  ${SUDO_USER}: created with sudo + SSH key"

# ── 4. Create App User ──────────────────────────────────────────────────────

CURRENT_STEP="stack-owner user creation (${APP_USER})"

if id "${APP_USER}" &>/dev/null; then
  echo "==> User ${APP_USER} already exists, skipping creation"
else
  echo "==> Creating stack-owner user: ${APP_USER} (shell ${APP_USER_SHELL})"
  # Home is separate from the stack dir (installDir): Docker and git need a writable HOME.
  useradd -m -d "/var/lib/${APP_USER}" -s "${APP_USER_SHELL}" "${APP_USER}"
  chmod 700 "/var/lib/${APP_USER}"
fi

if [ -n "${APP_USER_PASSWORD:-}" ]; then
  # Legacy: password login (needs a real shell to be useful)
  echo "${APP_USER}:${APP_USER_PASSWORD}" | chpasswd
else
  passwd -l "${APP_USER}" >/dev/null
fi

# No sudo, no SSH keys. The admin runs commands as it: sudo -u ${APP_USER} <cmd>
echo "  ${APP_USER}: ready (uid $(id -u ${APP_USER}), no sudo, no SSH, password locked)"

# ── 4b. Create dev users (rootless Docker; never in the docker group) ───────

CURRENT_STEP="dev users"
for dev in ${DEV_USERS//,/ }; do
  if [ "${dev}" = "${APP_USER}" ] || [ "${dev}" = "${SUDO_USER}" ]; then
    echo "ERROR: dev user '${dev}' must differ from APP_USER and SUDO_USER" >&2; exit 1
  fi
  if id "${dev}" &>/dev/null; then
    echo "==> Dev user ${dev} already exists, skipping creation"
  else
    echo "==> Creating dev user: ${dev}"
    useradd -m -s /bin/bash "${dev}"
  fi
  passwd -l "${dev}" >/dev/null
  if id -nG "${dev}" | tr ' ' '\n' | grep -qx docker; then
    echo "  WARNING: ${dev} is in the docker group (this gives root-level power). Remove it: gpasswd -d ${dev} docker" >&2
  fi
  # Keep the user's service manager (and its rootless Docker) running without a login.
  loginctl enable-linger "${dev}" 2>/dev/null || true
  echo "  ${dev}: ready (no sudo, no SSH; reach it with: sudo -iu ${dev})"
done

# ── 5. Lock root password ────────────────────────────────────────────────────
# The admin user has passwordless sudo, so the root password is never needed
# (use `sudo -i`). Locking it retires the provider's emailed root password —
# for console access too, not just SSH. Key auth and the current session are
# unaffected. Reverse with: sudo passwd -u root

if [ "${LOCK_ROOT:-true}" = "true" ]; then
  CURRENT_STEP="lock root password"
  echo "==> Locking root account password..."
  passwd -l root
  echo "  root password locked (use 'sudo -i' for root; reverse with 'sudo passwd -u root')"
else
  echo "==> Root password: left unchanged (LOCK_ROOT=false)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

CURRENT_STEP=""
echo ""
echo "Base setup complete."
echo "SETUP_BASE_OK"
