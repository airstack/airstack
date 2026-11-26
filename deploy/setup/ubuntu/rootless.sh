#!/bin/bash
set -euo pipefail
# rootless.sh — Give each dev user its own rootless Docker daemon.
#
# A user in the docker group is root-equivalent (docker run -v /:/host ...). Dev users
# (agents, developers, CI) instead run their OWN daemon as themselves: root inside their
# containers is just that user on the host. The root daemon stays for the stack only.
#
# Required env:
#   DEV_USERS      Space/comma-separated users (created by `vps-setup base`)
#
# Optional env:
#   PUBLISH_IP     Default host address for published ports (default: 127.0.0.1).
#                  `-p 6333:6333` then binds loopback only.
#
# What it sets up, per user:
#   - systemd user service docker.service (socket /run/user/<uid>/docker.sock), lingering on
#   - slirp4netns + the builtin port driver (honors the host IP in -p; pasta binds 0.0.0.0)
#   - ~/.config/docker/daemon.json {"ip": PUBLISH_IP}  (only if the file does not exist)
#   - docker CLI context "rootless", made the user's default (the user has no root daemon access)
#
# Rootless limits: containers cannot reach the host's 127.0.0.1 (use published ports), host
# networking is the daemon's private namespace, and ports below 1024 need a sysctl.
#
# Output: SETUP_ROOTLESS_OK on success

CURRENT_STEP=""
trap 'if [ $? -ne 0 ]; then echo "FAILED during: ${CURRENT_STEP:-unknown step}" >&2; fi' EXIT

DEV_USERS="${DEV_USERS:-}"
PUBLISH_IP="${PUBLISH_IP:-127.0.0.1}"
if [ -z "${DEV_USERS//[ ,]/}" ]; then echo "ERROR: DEV_USERS is required" >&2; exit 1; fi

CURRENT_STEP="packages"
echo "==> Installing rootless prerequisites..."
DEBIAN_FRONTEND=noninteractive apt-get install -y uidmap slirp4netns docker-ce-rootless-extras >/dev/null
command -v dockerd-rootless-setuptool.sh >/dev/null || { echo "ERROR: dockerd-rootless-setuptool.sh missing (docker-ce-rootless-extras)" >&2; exit 1; }

for u in ${DEV_USERS//,/ }; do
  CURRENT_STEP="rootless docker for ${u}"
  echo "==> ${u}"
  id "${u}" >/dev/null 2>&1 || { echo "ERROR: user ${u} does not exist (run: stack-cli vps-setup base)" >&2; exit 1; }
  if id -nG "${u}" | tr ' ' '\n' | grep -qx docker; then
    echo "  WARNING: ${u} is in the docker group (root-equivalent). Remove it: gpasswd -d ${u} docker" >&2
  fi
  grep -q "^${u}:" /etc/subuid && grep -q "^${u}:" /etc/subgid \
    || { echo "ERROR: ${u} has no subuid/subgid range (usermod --add-subuids/--add-subgids)" >&2; exit 1; }

  uid="$(id -u "${u}")"; home="$(getent passwd "${u}" | cut -d: -f6)"
  loginctl enable-linger "${u}"
  for _ in $(seq 1 30); do [ -S "/run/user/${uid}/bus" ] && break; sleep 1; done
  [ -S "/run/user/${uid}/bus" ] || { echo "ERROR: no user service manager for ${u} (/run/user/${uid}/bus)" >&2; exit 1; }

  # Run as the user, with the environment its systemd --user instance expects.
  as_user() { sudo -u "${u}" env HOME="${home}" XDG_RUNTIME_DIR="/run/user/${uid}" \
                DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" "$@"; }

  mkdir -p "${home}/.config/systemd/user/docker.service.d" "${home}/.config/docker"
  cat > "${home}/.config/systemd/user/docker.service.d/network.conf" <<UNIT
[Service]
# slirp4netns + builtin port driver honors the host IP in -p; the pasta default binds 0.0.0.0.
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=builtin
UNIT
  if [ ! -e "${home}/.config/docker/daemon.json" ]; then
    printf '{\n  "ip": "%s"\n}\n' "${PUBLISH_IP}" > "${home}/.config/docker/daemon.json"
  else
    echo "  ${home}/.config/docker/daemon.json exists; leaving it (check it sets \"ip\": \"${PUBLISH_IP}\")"
  fi
  chown -R "${u}:" "${home}/.config/systemd" "${home}/.config/docker"

  # --force: the setup tool refuses when the root daemon is reachable; the dev user is not in the group.
  as_user dockerd-rootless-setuptool.sh install --force >/dev/null
  as_user systemctl --user daemon-reload
  as_user systemctl --user restart docker.service
  for _ in $(seq 1 20); do
    as_user env DOCKER_HOST="unix:///run/user/${uid}/docker.sock" docker info >/dev/null 2>&1 && break; sleep 1
  done
  as_user env DOCKER_HOST="unix:///run/user/${uid}/docker.sock" docker info --format '{{.SecurityOptions}}' | grep -q rootless \
    || { echo "ERROR: rootless daemon for ${u} did not come up" >&2; exit 1; }
  as_user docker context use rootless >/dev/null
  echo "  ${u}: rootless Docker up (socket /run/user/${uid}/docker.sock, default context 'rootless')"
done

echo "SETUP_ROOTLESS_OK"
