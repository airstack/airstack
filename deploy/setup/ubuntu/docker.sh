#!/bin/bash
set -euo pipefail
# docker.sh — Install Docker CE, harden daemon, optionally install Sysbox.
#
# Optional env:
#   APP_USER         Stack-owner account; the ONLY account added to the docker group
#                    (docker group = root-equivalent). Default: deploy
#   SUDO_USER        Admin user (has sudo, so it is NOT added to the docker group)
#   INSTALL_SYSBOX   "true" to install Sysbox runtime (default: false).
#                    Only needed for nested-Docker / rootless container workloads.
#   SYSBOX_VERSION   Pinned Sysbox version (default: 0.6.7)
#   SYSBOX_SHA256    SHA256 for pinned .deb (default: known hash for 0.6.7)
#
# Output: SETUP_DOCKER_OK on success

CURRENT_STEP=""
trap 'if [ $? -ne 0 ]; then echo "FAILED during: ${CURRENT_STEP:-unknown step}" >&2; fi' EXIT

APP_USER="${APP_USER:-deploy}"
SUDO_USER="${SUDO_USER:-admin}"
INSTALL_SYSBOX="${INSTALL_SYSBOX:-false}"
SYSBOX_VERSION="${SYSBOX_VERSION:-0.6.7}"
SYSBOX_SHA256="${SYSBOX_SHA256:-b7ac389e5a19592cadf16e0ca30e40919516128f6e1b7f99e1cb4ff64554172e}"

# ── 1. Install Docker CE ─────────────────────────────────────────────────────

if command -v docker &>/dev/null; then
  echo "==> Docker already installed: $(docker --version)"
else
  CURRENT_STEP="Docker GPG key"
  echo "==> Installing Docker CE..."

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  CURRENT_STEP="Docker repository"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | tee /etc/apt/sources.list.d/docker.list > /dev/null

  CURRENT_STEP="Docker packages"
  apt update
  apt install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

  echo "  Docker installed: $(docker --version)"
fi

# Add users to docker group
CURRENT_STEP="docker group"
# Only the stack owner. The admin has sudo already; dev users use rootless Docker.
usermod -aG docker "${APP_USER}" 2>/dev/null || true
echo "  ${APP_USER} added to the docker group. This gives root-level power, so no one may log in as ${APP_USER}."
for u in $(getent group docker | cut -d: -f4 | tr ',' ' '); do
  [ "${u}" = "${APP_USER}" ] || echo "  WARNING: ${u} is in the docker group (this gives root-level power). Remove it: gpasswd -d ${u} docker" >&2
done

# Enable + start
systemctl enable docker
systemctl start docker

# ── 2. Docker Daemon Hardening ───────────────────────────────────────────────

CURRENT_STEP="daemon.json"
echo "==> Hardening Docker daemon..."

mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'EOF'
{
  "ip": "127.0.0.1",
  "default-network-opts": {
    "bridge": {
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
    }
  },
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  },
  "storage-driver": "overlay2",
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 65536,
      "Soft": 65536
    }
  }
}
EOF

systemctl restart docker

if ! systemctl is-active --quiet docker; then
  echo "ERROR: Docker did not restart after the daemon.json change" >&2
  echo "To check the file: python3 -m json.tool /etc/docker/daemon.json" >&2
  exit 1
fi
echo "  daemon.json applied: ports publish on 127.0.0.1 by default; containers cannot gain new privileges"

# ── 3. Install Sysbox (optional) ─────────────────────────────────────────────

if [ "${INSTALL_SYSBOX}" != "true" ]; then
  echo "==> Sysbox: skipped (not turned on; set sysbox: true to install it)"
  CURRENT_STEP=""
  echo ""
  echo "Docker setup complete."
  echo "  Docker: $(docker --version)"
  echo "  Sysbox: skipped"
  echo "SETUP_DOCKER_OK"
  exit 0
fi

SYSBOX_DEB="sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb"

if systemctl is-active --quiet sysbox 2>/dev/null; then
  INSTALLED_VERSION=$(dpkg -l sysbox-ce 2>/dev/null | awk '/^ii/{print $3}' | sed 's/-0$//')
  if [ "${INSTALLED_VERSION}" = "${SYSBOX_VERSION}" ]; then
    echo "==> Sysbox ${SYSBOX_VERSION} already installed"
  else
    echo "==> Sysbox ${INSTALLED_VERSION} is installed, but ${SYSBOX_VERSION} is wanted"
    echo "  Reinstalling..."
  fi
else
  echo "==> Installing Sysbox ${SYSBOX_VERSION}..."
fi

# Always install/update to ensure correct version + overrides
CURRENT_STEP="Sysbox download"
cd /tmp
wget -q "https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/${SYSBOX_DEB}"

CURRENT_STEP="Sysbox checksum"
echo "${SYSBOX_SHA256}  ${SYSBOX_DEB}" | sha256sum -c -

CURRENT_STEP="Sysbox dependencies"
apt install -y jq fuse

CURRENT_STEP="Sysbox install"
dpkg -i "${SYSBOX_DEB}" || apt --fix-broken install -y

rm -f "${SYSBOX_DEB}"

if ! systemctl is-active --quiet sysbox; then
  echo "ERROR: Sysbox failed to start" >&2
  exit 1
fi
echo "  Sysbox ${SYSBOX_VERSION} installed and running"

# ── 4. AppArmor fusermount3 Fix (Ubuntu 25.04+) ─────────────────────────────

CURRENT_STEP="AppArmor fusermount3 check"
if sudo aa-status 2>/dev/null | grep -q 'fusermount3'; then
  echo "==> Disabling fusermount3 AppArmor profile (sysbox compatibility)..."
  ln -sf /etc/apparmor.d/fusermount3 /etc/apparmor.d/disable/
  apparmor_parser -R /etc/apparmor.d/fusermount3 2>/dev/null || true
  systemctl restart sysbox-fs sysbox-mgr sysbox
  echo "  fusermount3 profile disabled, sysbox restarted"
else
  echo "==> AppArmor fusermount3: not enforcing (no action needed)"
fi

# ── 5. Disable Broken Overlayfs ID-Mapped Mounts ────────────────────────────

CURRENT_STEP="sysbox-mgr override"
echo "==> Applying sysbox-mgr override (disable broken ID-mapped mounts)..."

mkdir -p /etc/systemd/system/sysbox-mgr.service.d
cat > /etc/systemd/system/sysbox-mgr.service.d/override.conf << 'EOF'
[Service]
# Force rootfs cloning instead of broken ID-mapped mount on overlayfs.
# Sysbox 0.6.7 detects kernel ID-mapped mount support but fails to apply it,
# causing image files to appear as nobody:nogroup inside containers.
# Slows container start/stop by a few seconds but ensures correct uid mapping.
ExecStart=
ExecStart=/usr/bin/sysbox-mgr --disable-ovfs-on-idmapped-mount --log-level info
EOF

systemctl daemon-reload
systemctl restart sysbox

if systemctl show sysbox-mgr --property=ExecStart | grep -q 'disable-ovfs-on-idmapped-mount'; then
  echo "  sysbox-mgr override active"
else
  echo "WARNING: cannot confirm that the sysbox-mgr override is active" >&2
fi

# ── Done ─────────────────────────────────────────────────────────────────────

CURRENT_STEP=""
echo ""
echo "Docker + Sysbox setup complete."
echo "  Docker: $(docker --version)"
echo "  Sysbox: ${SYSBOX_VERSION}"
echo "SETUP_DOCKER_OK"
