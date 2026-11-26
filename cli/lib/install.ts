/**
 * install.ts — `airstack deploy <machine> --install`: take a fresh box to a finished, locked-down node.
 *
 * The machine file describes the FINISHED machine (host.ssh.user / host.ssh.port, e.g. adminroot:222).
 * A fresh box answers on host.ssh.bootstrapPort (default 22) as host.ssh.bootstrapUser (default root).
 * Each step connects with the first connection that works, in this order:
 *   final user @ final port  →  final user @ bootstrap port  →  bootstrap user @ bootstrap port
 *
 * Sequence (each step is safe to re-run):
 *   base → harden (phase 1: final port opened, bootstrap port still open) → docker → rootless → verify
 *   → REBOOT, wait for SSH on the final port (proves sshd + firewall come back after a restart)
 *   → harden --finalize (bootstrap port closed, AllowUsers = admin only)
 *   → check: final port answers, bootstrap port refuses
 * Lockdown never happens unless SSH on the final port works after the reboot. When the final port is
 * the bootstrap port (ssh.port: 22), nothing moves and finalize is skipped.
 */

import { CORE_ROOT, type Fleet, type Machine } from './fleet.js'
import type { DeployUnit } from './units.js'
import { testSSHConnection } from './remote-script.js'
import { sshConfigFromHost } from './ssh.js'
import { upsertSecret } from './secrets-writer.js'
import { runVpsSetup, SetupFailed, type SetupStep } from '../vps-setup.js'
import type { Config, SSHConfig } from '../types.js'
import type { Output } from './output.js'

interface Conn { user: string; port: number }

const fmt = (c: Conn) => `${c.user}@:${c.port}`

function withConn(config: Config, c: Conn): Config {
  return { ...config, host: { ...config.host, sshUser: c.user, sshPort: c.port } }
}

function sshFor(config: Config, c: Conn): SSHConfig {
  return sshConfigFromHost(withConn(config, c).host)
}

/** First connection that works, in preference order; undefined when none does. */
export async function pickConnection(m: Machine, config: Config, timeoutSec = 6): Promise<Conn | undefined> {
  const s = m.host.ssh
  const tries: Conn[] = [
    { user: s.user, port: s.port },
    { user: s.user, port: s.bootstrapPort },
    { user: s.bootstrapUser, port: s.bootstrapPort },
  ]
  const seen = new Set<string>()
  for (const c of tries) {
    const k = fmt(c)
    if (seen.has(k)) continue
    seen.add(k)
    if (await testSSHConnection(sshFor(config, c), timeoutSec)) return c
  }
  return undefined
}

export interface InstallResult { ok: boolean; note: string }

export async function runInstall(
  fleet: Fleet, m: Machine, unit: DeployUnit, opts: { step?: string; finalize?: boolean; undo?: boolean }, out: Output,
): Promise<InstallResult> {
  const name = m.name
  const s = m.host.ssh
  const moves = s.port !== s.bootstrapPort

  const run = async (step: SetupStep, conn: Conn, finalize = false): Promise<boolean> => {
    out.info(`${name}: setup ${step}${finalize ? ' --finalize' : ''} (as ${conn.user}, port ${conn.port}) …`)
    try {
      await runVpsSetup(step, {
        config: withConn(unit.config, conn),
        projectRoot: m.dir ?? fleet.root,
        sharedPaths: [fleet.root, CORE_ROOT],
        persistSecret: (k, v) => upsertSecret(fleet.root, name, k, v),
        flags: { finalize, undo: opts.undo, quiet: !opts.step },
      })
      out.ok(`${name}: setup ${step}${finalize ? ' --finalize' : ''}`)
      return true
    } catch (e) {
      out.fail(`${name}: setup ${step}: ${e instanceof SetupFailed ? e.message : String(e)}`)
      return false
    }
  }
  const connect = async (): Promise<Conn | undefined> => {
    const c = await pickConnection(m, unit.config)
    if (!c) {
      out.fail(`${name}: no SSH connection works (tried ${s.user}@:${s.port}, ${s.user}@:${s.bootstrapPort}, ${s.bootstrapUser}@:${s.bootstrapPort})`)
    }
    return c
  }

  // Single step (manual use): run it over whatever works.
  if (opts.step) {
    const c = await connect()
    if (!c) return { ok: false, note: 'no SSH connection' }
    return (await run(opts.step as SetupStep, c, !!opts.finalize)) ? { ok: true, note: `setup ${opts.step} done` } : { ok: false, note: `setup ${opts.step} failed` }
  }

  // 1. base → harden phase 1 → docker → rootless → verify (reconnect before each: base creates the
  //    admin user, harden opens the final port).
  const steps: SetupStep[] = ['base', 'harden', 'docker', ...(m.host.users.dev.length ? (['rootless'] as SetupStep[]) : []), 'verify']
  for (const step of steps) {
    const c = await connect()
    if (!c) return { ok: false, note: 'no SSH connection' }
    if (!(await run(step, c))) return { ok: false, note: `setup ${step} failed` }
  }

  if (!moves) {
    out.info(`${name}: host.ssh.port is the same as the bootstrap port (${s.port}). SSH stays on that port, so there is no lockdown step.`)
    return { ok: true, note: 'installed' }
  }

  const final: Conn = { user: s.user, port: s.port }
  const boot: Conn = { user: s.user, port: s.bootstrapPort }
  if (!(await testSSHConnection(sshFor(unit.config, final), 8))) {
    out.fail(`${name}: SSH as ${s.user} on port ${s.port} does not work after harden. Lockdown stopped; port ${s.bootstrapPort} stays open.`)
    return { ok: false, note: 'final port unreachable' }
  }

  // Already finalized? (bootstrap port refuses while the final port works)
  if (!(await testSSHConnection(sshFor(unit.config, boot), 6))) {
    out.ok(`${name}: already locked down (port ${s.bootstrapPort} is closed, port ${s.port} is open)`)
    return { ok: true, note: 'installed' }
  }

  // 2. Reboot over the final port; it must come back on the final port before anything is closed.
  if (!(await run('reboot', final))) {
    out.fail(`${name}: machine did not come back on port ${s.port} after reboot. Lockdown stopped; port ${s.bootstrapPort} stays open.`)
    return { ok: false, note: 'no SSH after reboot' }
  }

  // 3. Finalize, then prove: final port works, bootstrap port refuses.
  if (!(await run('harden', final, true))) return { ok: false, note: 'finalize failed' }
  if (!(await testSSHConnection(sshFor(unit.config, final), 8))) {
    out.fail(`${name}: SSH on port ${s.port} stopped working after finalize. Use your VPS provider's web console to log in and fix it.`)
    return { ok: false, note: 'locked out after finalize' }
  }
  if (await testSSHConnection(sshFor(unit.config, boot), 6)) {
    out.warn(`${name}: port ${s.bootstrapPort} still accepts SSH after finalize. Check the firewall: sudo ufw status`)
  } else {
    out.ok(`${name}: locked down. SSH works only on port ${s.port} as ${s.user}. Port ${s.bootstrapPort} is closed.`)
  }
  return { ok: true, note: 'installed' }
}
