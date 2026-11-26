// Steps `base` (packages, hostname, users) and `harden` (UFW, SSH, swap, fail2ban, sysctl).

import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { Config } from '../types.js'
import { expandKey } from '../lib/ssh.js'
import { resolveScript, executeSetupScript } from '../lib/remote-script.js'
import { fail, getDistro, type SetupContext } from './context.js'

// ── base ────────────────────────────────────────────────────────────────────

export async function cmdBase(ctx: SetupContext) {
  const { config, projectRoot, sharedPaths, flags, ssh, persistSecret } = ctx
  const distro = await getDistro(ctx)
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'base')

  const sudoUser = config.host.sudoUser
  const appUser = config.host.appUser
  const hostname = config.host.hostname

  // The admin user gets the SSH public key that pairs with host.sshKey.
  const authorizedKey = resolveAuthorizedKey(config)
  // Passwords are generated once and persisted to the machine secrets file so re-runs are idempotent.
  const sudoPassword = ensurePassword(persistSecret, 'SUDO_USER_PASSWORD', config.host.sudoUserPassword)
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

export async function cmdHarden(ctx: SetupContext) {
  const { config, projectRoot, sharedPaths, flags, ssh } = ctx
  const distro = await getDistro(ctx)
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve the SSH public key that pairs with host.sshKey (reads <key>.pub, or derives it). */
function resolveAuthorizedKey(config: Config): string {
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
function ensurePassword(persistSecret: (key: string, value: string) => void, envVar: string, current: string): string {
  if (current) return current
  const generated = randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)
  persistSecret(envVar, generated)
  console.log(`  Generated ${envVar} and saved it to the machine secrets file`)
  return generated
}
