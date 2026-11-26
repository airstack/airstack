#!/bin/bash
set -euo pipefail
# brew-shim.sh — One account owns Homebrew; everyone else can run its binaries but not change them.
#
# Homebrew is single-owner. A group-writable install lets any member replace binaries other
# users run, so we do not do that. Instead:
#   - BREW_OWNER (a dev user) installs and updates packages as usual.
#   - Other interactive accounts get the brew bin dir at the END of PATH (read-only use) and a
#     /usr/local/bin/brew shim that refuses writes with a message telling them to ask the admin.
#   - The stack owner (APP_USER) and root get neither: they must never run owner-writable binaries.
#
# Required env:
#   BREW_OWNER     Account that owns the Homebrew install
# Optional env:
#   APP_USER       Stack owner; gets no brew PATH (default: deploy)
#   BREW_PREFIX    Homebrew prefix (default: /home/linuxbrew/.linuxbrew)
#
# Output: SETUP_BREWSHIM_OK on success

BREW_OWNER="${BREW_OWNER:-}"
APP_USER="${APP_USER:-deploy}"
BREW_PREFIX="${BREW_PREFIX:-/home/linuxbrew/.linuxbrew}"
[ -n "${BREW_OWNER}" ] || { echo "ERROR: BREW_OWNER is required" >&2; exit 1; }
id "${BREW_OWNER}" >/dev/null 2>&1 || { echo "ERROR: user ${BREW_OWNER} does not exist" >&2; exit 1; }
[ -x "${BREW_PREFIX}/bin/brew" ] || { echo "ERROR: ${BREW_PREFIX}/bin/brew not found (install Homebrew as ${BREW_OWNER} first)" >&2; exit 1; }
owner_now="$(stat -c %U "${BREW_PREFIX}/bin/brew")"
[ "${owner_now}" = "${BREW_OWNER}" ] || echo "WARNING: ${BREW_PREFIX} is owned by ${owner_now}, not ${BREW_OWNER}" >&2

cat > /usr/local/bin/brew <<SHIM
#!/bin/bash
# Installed by stack-cli (vps-setup brew-shim). Homebrew here is owned by ${BREW_OWNER}.
OWNER='${BREW_OWNER}'
REAL='${BREW_PREFIX}/bin/brew'
if [ "\$(id -un)" = "\$OWNER" ]; then exec "\$REAL" "\$@"; fi
case "\${1:-}" in
  ""|--prefix|--cellar|--caskroom|--repository|--version|-v|list|ls|info|search|shellenv|--help|help|deps|uses|leaves|outdated)
    exec "\$REAL" "\$@" ;;
esac
cat >&2 <<MSG
brew: Homebrew on this machine is owned by '\$OWNER', so '\$(id -un)' cannot run 'brew \$1'.
  - Do NOT reinstall Homebrew or try to work around this.
  - Ask the admin to install it as '\$OWNER' (tell them the package: brew install <name>).
  - Packages already installed are on your PATH and work as normal.
  - For tools that need no root: uv tool install, npm install --prefix ~/.local, etc.
MSG
exit 1
SHIM
chmod 755 /usr/local/bin/brew

# PATH for interactive/login shells of everyone except root and the stack owner. Appended
# (not prepended) so /usr/local/bin/brew, the shim, wins over ${BREW_PREFIX}/bin/brew.
cat > /etc/profile.d/brew-readonly.sh <<PROFILE
# Installed by stack-cli (vps-setup brew-shim).
if [ "\$(id -u)" != 0 ] && [ "\$(id -un)" != '${APP_USER}' ] && [ "\$(id -un)" != '${BREW_OWNER}' ]; then
  case ":\$PATH:" in *":${BREW_PREFIX}/bin:"*) ;; *) PATH="\$PATH:${BREW_PREFIX}/bin" ;; esac
  export PATH
fi
PROFILE
chmod 644 /etc/profile.d/brew-readonly.sh

echo "  brew shim: /usr/local/bin/brew   PATH snippet: /etc/profile.d/brew-readonly.sh"
echo "SETUP_BREWSHIM_OK"
