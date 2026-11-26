#!/usr/bin/env bun
/**
 * vps-setup.ts — VPS provisioning commands.
 *
 * Usage:
 *   stack-cli vps-setup base                # packages, hostname, users
 *   stack-cli vps-setup harden              # UFW, SSH, swap, fail2ban, sysctl
 *   stack-cli vps-setup harden --finalize   # close port 22, restrict SSH
 *   stack-cli vps-setup reboot              # reboot VPS, wait for reconnection
 *   stack-cli vps-setup docker              # Docker CE + daemon hardening
 *   stack-cli vps-setup docker --sysbox     # ...also install the Sysbox runtime
 *   stack-cli vps-setup rootless            # rootless Docker for each dev user (host.devUsers)
 *   stack-cli vps-setup brew-shim           # one Homebrew owner; read-only use for the rest
 *   stack-cli vps-setup tailscale           # install Tailscale + join the tailnet
 *   stack-cli vps-setup verify              # check everything is ready for deploy
 *   stack-cli vps-setup lockdown            # close external SSH, route via tunnel
 */

import { resolve } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { loadConfig } from './lib/config.js'
import { createRemoteExecutor, expandKey } from './lib/ssh.js'
import { getSharedPaths } from './lib/resolve-file.js'
import {
  detectDistro,
  resolveScript,
  executeSetupScript,
  testSSHConnection,
} from './lib/remote-script.js'

const subcommand = process.argv[2] || ''
const args = process.argv.slice(3)

if (subcommand === '--help' || subcommand === '-h' || !subcommand) {
  if (!subcommand) console.error('No subcommand given. Pick one:\n')
  showHelp()
  process.exit(subcommand ? 0 : 1)
}

const flags = {
  finalize: args.includes('--finalize'),
  sysbox: args.includes('--sysbox'),
  undo: args.includes('--undo'),
  force: args.includes('--force'),
  noLockRoot: args.includes('--no-lock-root'),
  distro: getFlagValue(args, '--distro'),
}

const projectRoot = resolve(process.cwd())
const sharedPaths = getSharedPaths()

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig(projectRoot)
} catch (e: any) {
  console.error(`Config error: ${e.message}`)
  process.exit(1)
}

const ssh = {
  host: config.host.ip,
  port: config.host.sshPort,
  user: config.host.sshUser,
  keyPath: config.host.sshKey,
}

if (!ssh.host) {
  console.error('No VPS configured (host.ip or SSH_IP not set)')
  process.exit(1)
}

const remote = createRemoteExecutor(ssh)

async function getDistro(): Promise<string> {
  if (flags.distro) return flags.distro
  return detectDistro(remote)
}

/** Sysbox is opt-in: enabled by `--sysbox` flag or `stack.sysbox: true` in stack.yml. */
function sysboxEnabled(): boolean {
  return flags.sysbox || String((config.stack as Record<string, unknown>).sysbox) === 'true'
}

switch (subcommand) {
  case 'base':
    await cmdBase()
    break
  case 'harden':
    await cmdHarden()
    break
  case 'reboot':
    await cmdReboot()
    break
  case 'docker':
    await cmdDocker()
    break
  case 'tailscale':
    await cmdTailscale()
    break
  case 'rootless':
    await cmdRootless()
    break
  case 'brew-shim':
    await cmdBrewShim()
    break
  case 'verify':
    await cmdVerify()
    break
  case 'lockdown':
    await cmdLockdown()
    break
  default:
    console.error(`Unknown command: ${subcommand}`)
    console.error('Run: stack-cli vps-setup --help')
    process.exit(1)
}

// ── base ────────────────────────────────────────────────────────────────────

async function cmdBase() {
  const distro = await getDistro()
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'base')

  const sudoUser = config.host.sudoUser
  const appUser = config.host.appUser
  const hostname = config.host.hostname

  // The admin user gets the SSH public key that pairs with host.sshKey.
  const authorizedKey = resolveAuthorizedKey()
  // Passwords are generated once and persisted to .env so re-runs are idempotent.
  const sudoPassword = ensurePassword('SUDO_USER_PASSWORD', config.host.sudoUserPassword)
  // The stack owner has no login: its password stays locked unless one was set (legacy).
  const appPassword = config.host.appUserPassword

  console.log(`\n\x1b[1mVPS Base Setup\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Distro: ${distro}`)
  console.log(`  Hostname: ${hostname || '(keep current)'}`)
  console.log(`  Sudo user: ${sudoUser}`)
  console.log(`  Stack owner (no login, root-equivalent): ${appUser}`)
  console.log(`  Dev users (rootless Docker): ${config.host.devUsers.join(' ') || '(none)'}`)
  console.log(`  Lock root: ${flags.noLockRoot ? 'no' : 'yes'}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: {
      VPS_HOSTNAME: hostname,
      SUDO_USER: sudoUser,
      APP_USER: appUser,
      SUDO_USER_PASSWORD: sudoPassword,
      APP_USER_PASSWORD: appPassword,
      DEV_USERS: config.host.devUsers.join(' '),
      SSH_AUTHORIZED_KEY: authorizedKey,
      LOCK_ROOT: flags.noLockRoot ? 'false' : 'true',
    },
  })

  if (result.exitCode !== 0) {
    console.error('\n\x1b[31mBase setup failed\x1b[0m')
    process.exit(1)
  }

  console.log(`\n\x1b[32mBase setup complete.\x1b[0m`)
  console.log(`\nNext steps:`)
  console.log(
    `  1. Test SSH as ${sudoUser}: ssh -i ${ssh.keyPath} -p ${ssh.port} ${sudoUser}@${ssh.host}`
  )
  console.log(`  2. Update .env: SSH_USER=${sudoUser}`)
  console.log(`  3. Run: stack-cli vps-setup harden`)
}

// ── harden ──────────────────────────────────────────────────────────────────

async function cmdHarden() {
  const distro = await getDistro()
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'harden')

  const sudoUser = config.host.sudoUser
  const hardenedPort = config.host.sshHardenedPort

  console.log(`\n\x1b[1mVPS Hardening${flags.finalize ? ' (FINALIZE)' : ''}\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Distro: ${distro}`)
  if (!flags.finalize) console.log(`  Hardened SSH port: ${hardenedPort}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: {
      SUDO_USER: sudoUser,
      SSH_HARDENED_PORT: String(hardenedPort),
      FINALIZE: flags.finalize ? 'true' : '',
    },
  })

  if (result.exitCode !== 0) {
    console.error('\n\x1b[31mHardening failed\x1b[0m')
    process.exit(1)
  }

  if (flags.finalize) {
    console.log(`\n\x1b[32mSSH hardening finalized. Port 22 closed.\x1b[0m`)
  } else {
    console.log(`\n\x1b[32mHardening complete.\x1b[0m`)
    console.log(`\nNext steps:`)
    console.log(
      `  1. Test hardened port: ssh -i ${ssh.keyPath} -p ${hardenedPort} ${sudoUser}@${ssh.host}`
    )
    console.log(`  2. Update .env: SSH_USER=${sudoUser}, SSH_PORT=${hardenedPort}`)
    console.log(`  3. Run: stack-cli vps-setup harden --finalize`)
  }
}

// ── reboot ──────────────────────────────────────────────────────────────────

async function cmdReboot() {
  console.log(`\n\x1b[1mVPS Reboot\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)

  await remote.run('sudo reboot || true')
  console.log('\x1b[33mReboot initiated. Waiting for reconnection...\x1b[0m')

  const maxWait = 120
  for (let elapsed = 0; elapsed < maxWait; elapsed += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const reachable = await testSSHConnection(ssh, 5)
    if (reachable) {
      console.log(`\n\x1b[32mVPS back online after ~${elapsed + 5}s\x1b[0m`)
      console.log(`\nNext step: stack-cli vps-setup docker`)
      return
    }
    process.stdout.write(`  waiting... (${elapsed + 5}s/${maxWait}s)\r`)
  }

  console.log(`\n\x1b[31mVPS did not come back within ${maxWait}s\x1b[0m`)
  process.exit(1)
}

// ── docker ──────────────────────────────────────────────────────────────────

async function cmdDocker() {
  const distro = await getDistro()
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'docker')

  const sudoUser = config.host.sudoUser
  const appUser = config.host.appUser
  const withSysbox = sysboxEnabled()

  console.log(`\n\x1b[1mDocker Setup${withSysbox ? ' + Sysbox' : ''}\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Distro: ${distro}`)
  console.log(`  Sysbox: ${withSysbox ? 'yes' : 'no'}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: {
      SUDO_USER: sudoUser,
      APP_USER: appUser,
      INSTALL_SYSBOX: withSysbox ? 'true' : 'false',
    },
  })

  if (result.exitCode !== 0) {
    console.error('\n\x1b[31mDocker setup failed\x1b[0m')
    process.exit(1)
  }

  console.log(`\n\x1b[32mDocker setup complete.\x1b[0m`)
  console.log(`\nNext step: stack-cli vps-setup verify`)
}

// ── rootless ────────────────────────────────────────────────────────────────
// Each dev user gets its own rootless Docker daemon (see docs/LAYOUT.md).

async function cmdRootless() {
  const devUsers = config.host.devUsers
  if (devUsers.length === 0) {
    console.error('No dev users configured. Set DEV_USERS in .env (or host.devUsers in stack.yml).')
    process.exit(1)
  }
  const distro = await getDistro()
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'rootless')

  console.log(`\n\x1b[1mRootless Docker\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Dev users: ${devUsers.join(' ')}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: { DEV_USERS: devUsers.join(' ') },
  })
  if (result.exitCode !== 0) {
    console.error('\n\x1b[31mRootless setup failed\x1b[0m')
    process.exit(1)
  }
  console.log(`\n\x1b[32mRootless Docker ready.\x1b[0m Dev users run plain \`docker\`; it talks to their own daemon.`)
}

// ── brew-shim ───────────────────────────────────────────────────────────────
// One account owns Homebrew; everyone else gets read-only use (see docs/LAYOUT.md).

async function cmdBrewShim() {
  const owner = config.host.brewOwner || config.host.devUsers[0] || ''
  if (!owner) {
    console.error('No Homebrew owner. Set BREW_OWNER in .env (or host.brewOwner), or list a dev user.')
    process.exit(1)
  }
  const distro = await getDistro()
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'brew-shim')

  console.log(`\n\x1b[1mHomebrew shim\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Homebrew owner: ${owner}; stack owner (no brew PATH): ${config.host.appUser}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: { BREW_OWNER: owner, APP_USER: config.host.appUser },
  })
  if (result.exitCode !== 0) {
    console.error('\n\x1b[31mBrew shim setup failed\x1b[0m')
    process.exit(1)
  }
  console.log(`\n\x1b[32mDone.\x1b[0m Other accounts can run brew-installed tools but not 'brew install'.`)
}

// ── tailscale ───────────────────────────────────────────────────────────────
// Installs Tailscale and joins the tailnet. Which ports the tailnet may reach
// is applied on deploy by the tailscale plugin (plugins.tailscale.ports).

async function cmdTailscale() {
  const distro = await getDistro()
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'tailscale')

  const tsConfig = (config.plugins.tailscale ?? {}) as Record<string, unknown>
  const authKey = String(tsConfig.authKey ?? '')
  const hostname = String(tsConfig.hostname || config.host.hostname || '')

  console.log(`\n\x1b[1mTailscale Setup\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Distro: ${distro}`)
  console.log(`  Tailnet name: ${hostname || '(current hostname)'}`)
  console.log(`  Login: ${authKey ? 'auth key' : 'interactive URL'}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: {
      VPS_HOSTNAME: hostname,
      TAILSCALE_AUTHKEY: authKey,
    },
  })

  if (result.exitCode !== 0) {
    console.error('\n\x1b[31mTailscale setup failed\x1b[0m')
    process.exit(1)
  }

  console.log(`\n\x1b[32mTailscale setup complete.\x1b[0m`)
  console.log(`\nNext step: list tailnet ports under plugins.tailscale.ports, then stack-cli deploy`)
}

// ── verify ──────────────────────────────────────────────────────────────────

async function cmdVerify() {
  const distro = await getDistro()
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'verify')

  const sudoUser = config.host.sudoUser
  const appUser = config.host.appUser

  console.log(`\n\x1b[1mVPS Verification\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Distro: ${distro}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: {
      SUDO_USER: sudoUser,
      APP_USER: appUser,
      DEV_USERS: config.host.devUsers.join(' '),
      SSH_PORT: String(config.host.sshPort),
      INSTALL_DIR: config.stack.installDir,
      INSTALL_SYSBOX: sysboxEnabled() ? 'true' : 'false',
    },
  })

  if (result.exitCode !== 0) {
    console.error('\n\x1b[31mVerification found failures.\x1b[0m')
    process.exit(1)
  }

  console.log(`\n\x1b[32mVPS is ready for deployment.\x1b[0m`)
  console.log(`\nNext step: stack-cli deploy`)
}

// ── lockdown ──────────────────────────────────────────────────────────────────
// Close (or reopen with --undo) the external SSH port so SSH is reachable only
// through the Cloudflare tunnel. Connects directly (the port is still open at
// this moment) and reconfigures UFW. Requires host.sshExpose: tunnel.

async function cmdLockdown() {
  const undo = flags.undo
  const port = config.host.sshHardenedPort || config.host.sshPort
  const dockerSubnet = String((config.stack as Record<string, unknown>).dockerSubnet || '10.200.0.0/24')

  console.log(`\n\x1b[1mSSH Lockdown${undo ? ' (UNDO — reopen)' : ''}\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  SSH port: ${port}`)

  if (undo) {
    console.log(`\nReopening external SSH port ${port}...`)
    await remote.run(`sudo ufw allow ${port}/tcp`)
    await remote.run(`sudo ufw delete allow from ${dockerSubnet} to any port ${port} proto tcp 2>/dev/null || true`)
    console.log(`\n\x1b[32mExternal SSH port ${port} reopened.\x1b[0m`)
    console.log(`Set host.sshExpose: public (or SSH_EXPOSE=public) to route the CLI directly again.`)
    return
  }

  if (config.host.sshExpose !== 'tunnel') {
    console.error(`\n\x1b[31mhost.sshExpose is not 'tunnel'.\x1b[0m`)
    console.error(`Set host.sshExpose: tunnel (or SSH_EXPOSE=tunnel) before locking down,`)
    console.error(`so the CLI knows to route subsequent connections through cloudflared.`)
    process.exit(1)
  }
  if (!config.host.sshTunnelHostname) {
    console.error(`\n\x1b[31mhost.sshTunnelHostname is not set.\x1b[0m`)
    console.error(`Set it to your Cloudflare Access SSH hostname (e.g. ssh.example.com).`)
    process.exit(1)
  }

  // Preflight — confirm the tunnel SSH route works BEFORE closing the direct port.
  const tunnelSSH = {
    host: config.host.sshTunnelHostname,
    port,
    user: ssh.user,
    keyPath: ssh.keyPath,
    viaTunnel: true,
    tunnelHostname: config.host.sshTunnelHostname,
  }
  console.log(`\nPreflight: testing SSH via tunnel (${config.host.sshTunnelHostname})...`)
  const reachable = await testSSHConnection(tunnelSSH, 20)
  if (!reachable) {
    console.error(`\n\x1b[31mTunnel SSH is NOT reachable yet.\x1b[0m`)
    console.error(`Set up the tunnel route first, then retry (or pass --force to override):`)
    console.error(`  1. Deploy so cloudflared is running: stack-cli deploy`)
    console.error(`  2. Add a tunnel ingress rule: ssh://10.200.0.1:${port} for hostname ${config.host.sshTunnelHostname}`)
    console.error(`  3. Add a Cloudflare Access (self-hosted) app for that hostname`)
    console.error(`  4. Authenticate locally once: cloudflared access ssh-config --hostname ${config.host.sshTunnelHostname}`)
    if (!flags.force) process.exit(1)
    console.error(`\n\x1b[33m--force given: proceeding despite failed preflight.\x1b[0m`)
  } else {
    console.log(`  \x1b[32mTunnel SSH reachable.\x1b[0m`)
  }

  console.log(`\nAllowing the Docker subnet (${dockerSubnet}) to reach SSH port ${port}...`)
  await remote.run(`sudo ufw allow from ${dockerSubnet} to any port ${port} proto tcp`)

  console.log(`Closing external SSH port ${port}...`)
  await remote.run(`sudo ufw delete allow ${port}/tcp 2>/dev/null || true`)
  await remote.run(`sudo ufw delete allow 22/tcp 2>/dev/null || true`)

  console.log(`\n\x1b[32mLockdown complete — external SSH is closed.\x1b[0m`)
  console.log(`The CLI will now route SSH through the tunnel (host.sshExpose: tunnel).`)
  console.log(`\n\x1b[33mRecovery:\x1b[0m if you lose tunnel access, reopen the port from your`)
  console.log(`provider's console/VNC:  sudo ufw allow ${port}/tcp`)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve the SSH public key that pairs with host.sshKey (reads <key>.pub, or derives it). */
function resolveAuthorizedKey(): string {
  const keyPath = expandKey(config.host.sshKey)
  if (!keyPath) {
    console.error('No SSH key configured (host.sshKey / SSH_KEY). Needed to seed the admin user.')
    process.exit(1)
  }
  const pubPath = `${keyPath}.pub`
  if (existsSync(pubPath)) {
    return readFileSync(pubPath, 'utf-8').trim()
  }
  // Fall back to deriving the public key from the private key.
  try {
    const out = Bun.spawnSync(['ssh-keygen', '-y', '-f', keyPath])
    if (out.exitCode === 0) return new TextDecoder().decode(out.stdout).trim()
  } catch { /* fall through to error */ }
  console.error(`Could not find or derive a public key for ${keyPath}.`)
  console.error(`Expected a public key at ${pubPath}. Generate one with:`)
  console.error(`  ssh-keygen -y -f ${keyPath} > ${pubPath}`)
  process.exit(1)
}

/** Return the given password, or generate a strong one and persist it to .env. */
function ensurePassword(envVar: string, current: string): string {
  if (current) return current
  const generated = randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)
  upsertEnvVar(envVar, generated)
  console.log(`  Generated ${envVar} and saved it to ${config.stackConfig.envFile}`)
  return generated
}

/** Insert or update KEY=value in the .env file (used for generated secrets). */
function upsertEnvVar(key: string, value: string): void {
  const envPath = config.stackConfig.envFile
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf-8').split('\n') : []
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`))
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`
  } else if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.splice(lines.length - 1, 0, `${key}=${value}`)
  } else {
    lines.push(`${key}=${value}`)
  }
  writeFileSync(envPath, lines.join('\n'), { mode: 0o600 })
}

function getFlagValue(a: string[], flag: string): string | undefined {
  const idx = a.indexOf(flag)
  return idx >= 0 && idx + 1 < a.length ? a[idx + 1] : undefined
}

function showHelp() {
  console.log(`Usage: stack-cli vps-setup <command> [options]

Commands:
  base                 Install packages, set hostname, create users
  harden               UFW, SSH hardening, swap, fail2ban, sysctl
  harden --finalize    Close port 22, restrict AllowUsers
  reboot               Reboot VPS and wait for reconnection
  docker               Install Docker CE + daemon hardening (add --sysbox for Sysbox runtime)
  tailscale            Install Tailscale + join the tailnet (plugins.tailscale.authKey
                       for unattended login, otherwise prints a login URL)
  rootless             Rootless Docker for each dev user (DEV_USERS / host.devUsers)
  brew-shim            One Homebrew owner (BREW_OWNER); read-only brew for other accounts
  verify               Check everything is ready for deploy
  lockdown             Close the external SSH port; route SSH via the Cloudflare
                       tunnel (requires host.sshExpose: tunnel). --undo reopens it.

Options:
  --sysbox             Install/verify the Sysbox runtime (docker, verify).
                       Also enabled via stack.sysbox: true in stack.yml.
  --finalize           harden only: close port 22 and restrict AllowUsers
  --no-lock-root       base only: leave the root password unchanged (default: lock it)
  --undo               lockdown only: reopen the external SSH port
  --force              lockdown only: proceed even if the tunnel preflight fails
  --distro <name>      Override distro detection (default: auto from /etc/os-release)`)
}
