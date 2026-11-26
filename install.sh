#!/bin/sh
# airstack installer for a controller (your laptop or workstation).
#
#   curl -fsSL https://raw.githubusercontent.com/airstack/airstack/main/install.sh | sh
#   AIRSTACK_VERSION=0.1.0 sh install.sh      # a given version
#
# What it does:
#   1. Finds your OS and CPU (macOS or Linux, x64 or arm64).
#   2. Downloads the release and SHA256SUMS from GitHub, and checks the checksum.
#   3. Unpacks it into ~/.local/lib/airstack/versions/<version>/.
#   4. Points ~/.local/bin/airstack at it.
# It never uses sudo and writes nothing outside ~/.local. VPS nodes do not use this script:
# `airstack deploy` puts airstack on them.
set -eu

REPO="airstack/airstack"
LIB="${HOME}/.local/lib/airstack"
BIN="${HOME}/.local/bin"

say() { printf '%s\n' "$*"; }
fail() { printf 'fail %s\n' "$*" >&2; exit 2; }

if [ -f /etc/airstack/machine.yaml ]; then
  fail "this machine is an airstack node: it gets airstack from its controller (airstack fleet update)"
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU: $(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

version="${AIRSTACK_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)
  [ -n "$version" ] || fail "cannot find the latest release"
fi

name="airstack-${version}-${os}-${arch}"
# AIRSTACK_DOWNLOAD_BASE: a mirror or a local dir (file:///…) with the release files; for tests.
base="${AIRSTACK_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download/v${version}}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "->   download ${name}.tar.gz"
curl -fsSL -o "${tmp}/${name}.tar.gz" "${base}/${name}.tar.gz" || fail "download failed: ${base}/${name}.tar.gz"
curl -fsSL -o "${tmp}/SHA256SUMS" "${base}/SHA256SUMS" || fail "download failed: ${base}/SHA256SUMS"

want=$(awk -v f="${name}.tar.gz" '$2 == f { print $1 }' "${tmp}/SHA256SUMS")
[ -n "$want" ] || fail "SHA256SUMS has no entry for ${name}.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  have=$(sha256sum "${tmp}/${name}.tar.gz" | awk '{ print $1 }')
else
  have=$(shasum -a 256 "${tmp}/${name}.tar.gz" | awk '{ print $1 }')
fi
[ "$want" = "$have" ] || fail "checksum mismatch: the download is not the published file"
say "ok   checksum"

dest="${LIB}/versions/${version}"
rm -rf "${dest}.new"
mkdir -p "${dest}.new" "$BIN"
tar -xzf "${tmp}/${name}.tar.gz" -C "${dest}.new" --strip-components=1
rm -rf "$dest"
mv "${dest}.new" "$dest"
ln -sfn "${dest}/bin/airstack" "${BIN}/airstack.new"
mv -f "${BIN}/airstack.new" "${BIN}/airstack"
say "ok   airstack ${version} in ${dest}"
say "ok   ${BIN}/airstack"

case ":${PATH}:" in
  *":${BIN}:"*) ;;
  *)
    say "warn ${BIN} is not on PATH"
    say "->   echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc   (or ~/.bashrc)"
    ;;
esac
say "->   airstack doctor"
