/**
 * vps-setup.ts — VPS provisioning steps, driven by `airstack deploy <machine> --install [--step <s>]`.
 *
 * Steps:
 *   base        packages, hostname, users (admin, stack owner, dev users)
 *   harden      UFW, SSH, swap, fail2ban, sysctl (opens host.ssh.port; --finalize closes the bootstrap port)
 *   reboot      reboot and wait for SSH
 *   docker      Docker CE + daemon hardening (sysbox via stack sysbox: true)
 *   rootless    rootless Docker for each dev user (host.users.dev)
 *   brew-shim   one Homebrew owner; read-only brew for other accounts
 *   tailscale   install Tailscale + join the tailnet (machine plugin airstack/tailscale)
 *   verify      check everything is ready for deploy
 *   lockdown    close external SSH, route via the Cloudflare tunnel
 *
 * Failures throw SetupFailed (no process.exit), so a multi-machine run can report and continue.
 */

import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { Config } from './types.js'
import { createRemoteExecutor, expandKey } from './lib/ssh.js'
import {
  detectDistro,
  resolveScript,
  executeSetupScript,
  testSSHConnection,
} from './lib/remote-script.js'

export class SetupFailed extends Error {}

export const SETUP_STEPS = ['base', 'harden', 'reboot', 'docker', 'rootless', 'brew-shim', 'tailscale', 'verify', 'lockdown'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export interface SetupFlags {
  finalize?: boolean
  sysbox?: boolean
  undo?: boolean
  force?: boolean
  noLockRoot?: boolean
  distro?: string
  /** Part of a full --install run: skip the "next steps" hints (--install does those steps). */
  quiet?: boolean
}

export interface SetupOptions {
  config: Config
  /** Where setup scripts are looked up (deploy/setup/<distro>/<step>.sh). */
  projectRoot: string
  sharedPaths: string[]
  flags?: SetupFlags
  /** Persist a generated secret (e.g. SUDO_USER_PASSWORD) to the machine's secrets file. */
  persistSecret: (key: string, value: string) => void
}

// Module state for the step functions below (set by runVpsSetup; one step at a time).
let config: Config
let projectRoot: string
let sharedPaths: string[]
let flags: Required<Omit<SetupFlags, 'distro'>> & { distro?: string }
let ssh: { host: string; port: number; user: string; keyPath: string }
let remote: ReturnType<typeof createRemoteExecutor>
let persistSecret: (key: string, value: string) => void

const fail = (msg: string): never => {
  throw new SetupFailed(msg)
}

export async function runVpsSetup(step: SetupStep, opts: SetupOptions): Promise<void> {
  config = opts.config
  projectRoot = opts.projectRoot
  sharedPaths = opts.sharedPaths
  persistSecret = opts.persistSecret
  const f = opts.flags ?? {}
  flags = {
    finalize: !!f.finalize, sysbox: !!f.sysbox, undo: !!f.undo, force: !!f.force, noLockRoot: !!f.noLockRoot,
    quiet: !!f.quiet, distro: f.distro,
  }
  ssh = { host: config.host.ip, port: config.host.sshPort, user: config.host.sshUser, keyPath: config.host.sshKey }
  if (!ssh.host) fail('No machine address: set host.ip in the machine file.')
  remote = createRemoteExecutor(ssh)

  switch (step) {
    case 'base': return cmdBase()
    case 'harden': return cmdHarden()
    case 'reboot': return cmdReboot()
    case 'docker': return cmdDocker()
    case 'tailscale': return cmdTailscale()
    case 'rootless': return cmdRootless()
    case 'brew-shim': return cmdBrewShim()
    case 'verify': return cmdVerify()
    case 'lockdown': return cmdLockdown()
    default: fail(`Unknown setup step: ${step as string}`)
  }
}

async function getDistro(): Promise<string> {
  if (flags.distro) return flags.distro
  return detectDistro(remote)
}

/** Sysbox is opt-in: `sysbox` flag or `sysbox: true` on the unit. */
function sysboxEnabled(): boolean {
  return flags.sysbox || String((config.stack as Record<string, unknown>).sysbox) === 'true'
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
  // Passwords are generated once and persisted to the machine secrets file so re-runs are idempotent.
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
    fail('base script failed (see its output above)')
  }

  console.log(`\n\x1b[32mBase setup complete.\x1b[0m`)
  if (flags.quiet) return
  console.log(`\nNext steps (--install runs them for you):`)
  console.log(
    `  1. Test SSH as ${sudoUser}: ssh -i ${ssh.keyPath} -p ${ssh.port} ${sudoUser}@${ssh.host}`
  )
  console.log(`  2. Check that the machine file has host.ssh.user: ${sudoUser}`)
  console.log(`  3. Run: airstack deploy <machine> --install --step harden`)
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
      SSH_BOOTSTRAP_PORT: String(config.host.sshBootstrapPort ?? 22),
      FINALIZE: flags.finalize ? 'true' : '',
    },
  })

  if (result.exitCode !== 0) {
    fail('harden script failed (see its output above)')
  }

  if (flags.finalize) {
    console.log(`\n\x1b[32mSSH hardening finalized. Port ${config.host.sshBootstrapPort ?? 22} is closed.\x1b[0m`)
  } else {
    console.log(`\n\x1b[32mHardening complete.\x1b[0m`)
    if (flags.quiet) return
    console.log(`\nNext steps (--install runs them for you):`)
    console.log(
      `  1. Test the new SSH port: ssh -i ${ssh.keyPath} -p ${hardenedPort} ${sudoUser}@${ssh.host}`
    )
    console.log(`  2. Check that the machine file has host.ssh.user: ${sudoUser} and host.ssh.port: ${hardenedPort}`)
    console.log(`  3. Run: airstack deploy <machine> --install --step harden --finalize`)
  }
}

// ── reboot ──────────────────────────────────────────────────────────────────

async function cmdReboot() {
  console.log(`\n\x1b[1mVPS Reboot\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)

  // "Back" must mean a NEW boot: compare the kernel boot id, or a box that has not gone down yet
  // looks like it came back instantly.
  const bootId = async () => (await remote.run('cat /proc/sys/kernel/random/boot_id 2>/dev/null')).stdout.trim()
  const before = await bootId()
  if (!before) fail('could not read the boot ID (/proc/sys/kernel/random/boot_id), so reboot was not started')

  await remote.run('sudo systemd-run --on-active=2 --timer-property=AccuracySec=100ms /bin/systemctl reboot >/dev/null 2>&1 || (sleep 1; sudo reboot) >/dev/null 2>&1 &')
  console.log('\x1b[33mReboot scheduled. Waiting for the machine to come back...\x1b[0m')

  const maxWait = 300
  for (let elapsed = 0; elapsed < maxWait; elapsed += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    if (!(await testSSHConnection(ssh, 5))) {
      process.stdout.write(`  waiting... (${elapsed + 5}s/${maxWait}s)\r`)
      continue
    }
    const now = await bootId()
    if (now && now !== before) {
      console.log(`\n\x1b[32mMachine is back online after about ${elapsed + 5}s (new boot).\x1b[0m`)
      return
    }
  }
  fail(`machine did not come back on SSH port ${ssh.port} within ${maxWait}s after reboot`)
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
    fail('docker script failed (see its output above)')
  }

  console.log(`\n\x1b[32mDocker setup complete.\x1b[0m`)
  console.log(`\nNext step: airstack deploy <machine> --install --step verify`)
}

// ── rootless ────────────────────────────────────────────────────────────────
// Each dev user gets its own rootless Docker daemon (see docs/LAYOUT.md).

async function cmdRootless() {
  const devUsers = config.host.devUsers
  if (devUsers.length === 0) {
    fail('No dev users configured. Set host.users.dev in the machine file.')
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
    fail('rootless script failed (see its output above)')
  }
  console.log(`\n\x1b[32mRootless Docker is ready.\x1b[0m Each dev user runs plain \`docker\`. It talks to that user's own Docker daemon.`)
}

// ── brew-shim ───────────────────────────────────────────────────────────────
// One account owns Homebrew; everyone else gets read-only use (see docs/LAYOUT.md).

async function cmdBrewShim() {
  const owner = config.host.brewOwner || config.host.devUsers[0] || ''
  if (!owner) {
    fail('No Homebrew owner. Set host.users.brewOwner in the machine file, or list a dev user.')
  }
  const distro = await getDistro()
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'brew-shim')

  console.log(`\n\x1b[1mHomebrew shim\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Homebrew owner: ${owner}`)
  console.log(`  Stack owner (brew not on its PATH): ${config.host.appUser}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: { BREW_OWNER: owner, APP_USER: config.host.appUser },
  })
  if (result.exitCode !== 0) {
    fail('brew-shim script failed (see its output above)')
  }
  console.log(`\n\x1b[32mDone.\x1b[0m Other accounts can run tools that brew installed. Only ${owner} can run 'brew install'.`)
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
    fail('tailscale script failed (see its output above)')
  }

  console.log(`\n\x1b[32mTailscale setup complete.\x1b[0m`)
  console.log(`\nNext step: list the ports the tailnet may reach under plugins.tailscale.ports. Then run: airstack deploy <machine>`)
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
      SSH_BOOTSTRAP_PORT: String(config.host.sshBootstrapPort ?? 22),
      INSTALL_DIR: config.stack.installDir,
      INSTALL_SYSBOX: sysboxEnabled() ? 'true' : 'false',
    },
  })

  if (result.exitCode !== 0) {
    fail('verify found problems (see the FAIL lines above)')
  }

  console.log(`\n\x1b[32mThe machine is ready to deploy.\x1b[0m`)
  console.log(`\nNext step: airstack deploy <machine>`)
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
    console.log(`To connect directly again, set host.ssh.expose: public in the machine file.`)
    return
  }

  if (config.host.sshExpose !== 'tunnel') {
    console.error(`\n\x1b[31mhost.ssh.expose is not 'tunnel'.\x1b[0m`)
    fail(`Set host.ssh.expose: tunnel in the machine file before lockdown. Then airstack connects through cloudflared.`)
  }
  if (!config.host.sshTunnelHostname) {
    console.error(`\n\x1b[31mhost.ssh.tunnelHostname is not set.\x1b[0m`)
    fail(`Set host.ssh.tunnelHostname to your Cloudflare Access SSH hostname (e.g. ssh.example.com).`)
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
  console.log(`\nCheck first: testing SSH through the tunnel (${config.host.sshTunnelHostname})...`)
  const reachable = await testSSHConnection(tunnelSSH, 20)
  if (!reachable) {
    console.error(`\n\x1b[31mSSH through the tunnel does NOT work yet.\x1b[0m`)
    console.error(`Set up the tunnel route first, then try again (--force skips this check):`)
    console.error(`  1. Deploy so cloudflared is running: airstack deploy <machine>`)
    console.error(`  2. Add a tunnel ingress rule: ssh://10.200.0.1:${port} for hostname ${config.host.sshTunnelHostname}`)
    console.error(`  3. Add a Cloudflare Access (self-hosted) app for that hostname`)
    console.error(`  4. Authenticate locally once: cloudflared access ssh-config --hostname ${config.host.sshTunnelHostname}`)
    if (!flags.force) fail('SSH through the tunnel does not work. Lockdown stopped; external SSH stays open (--force skips this check).')
    console.error(`\n\x1b[33m--force given: lockdown continues although the tunnel check failed.\x1b[0m`)
  } else {
    console.log(`  \x1b[32mSSH through the tunnel works.\x1b[0m`)
  }

  console.log(`\nAllowing the Docker subnet (${dockerSubnet}) to reach SSH port ${port}...`)
  await remote.run(`sudo ufw allow from ${dockerSubnet} to any port ${port} proto tcp`)

  console.log(`Closing external SSH port ${port}...`)
  await remote.run(`sudo ufw delete allow ${port}/tcp 2>/dev/null || true`)
  await remote.run(`sudo ufw delete allow 22/tcp 2>/dev/null || true`)

  console.log(`\n\x1b[32mLockdown complete. External SSH is closed.\x1b[0m`)
  console.log(`airstack now connects through the tunnel (host.ssh.expose: tunnel).`)
  console.log(`\n\x1b[33mRecovery:\x1b[0m if the tunnel stops working, open your VPS provider's web console and run: sudo ufw allow ${port}/tcp`)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve the SSH public key that pairs with host.sshKey (reads <key>.pub, or derives it). */
function resolveAuthorizedKey(): string {
  const keyPath = expandKey(config.host.sshKey)
  if (!keyPath) {
    fail('No SSH key: set host.ssh.key in the machine file. The admin user needs it to log in.')
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
  return fail(`No public key for ${keyPath}. Create it: ssh-keygen -y -f ${keyPath} > ${pubPath}`)
}

/** Return the given password, or generate a strong one and persist it to the machine secrets file. */
function ensurePassword(envVar: string, current: string): string {
  if (current) return current
  const generated = randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)
  persistSecret(envVar, generated)
  console.log(`  Generated ${envVar} and saved it to the machine secrets file`)
  return generated
}

