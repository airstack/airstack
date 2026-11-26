/**
 * airstack ssh <machine> [-- <command…>]   interactive SSH, or run one command
 * airstack status [<machine>... | '<pattern>' | --all]   containers per stack instance, crons, marker
 *
 * Both connect with the machine file's SSH settings (direct, or through cloudflared when
 * host.ssh.expose is tunnel).
 */

import { loadFleet, loadMachine, selectTargets, type Fleet } from '../lib/fleet.js'
import { buildUnits } from '../lib/units.js'
import { createRemoteExecutor, sshArgs, sshConfigFromHost, userHost } from '../lib/ssh.js'
import { composeCommand } from '../lib/compose.js'
import { readMarker } from '../lib/marker.js'
import { EXIT, type Output } from '../lib/output.js'
import type { DeployContext } from '../types.js'

function machineSsh(fleet: Fleet, name: string, out: Output) {
  if (!fleet.machines.some((m) => m.name === name)) {
    out.fail(`no machine '${name}' in ${fleet.root}/machines`)
    out.next('airstack fleet list')
    return undefined
  }
  const m = loadMachine(fleet, name)
  const fails = m.issues.filter((i) => i.level === 'fail')
  // Only SSH settings matter here; other config errors must not lock you out of the box.
  const sshBroken = fails.filter((i) => /host|secret/.test(`${i.key ?? ''} ${i.message}`))
  if (sshBroken.length) {
    for (const i of sshBroken) out.fail(`${name}: ${i.key ?? i.file}: ${i.message}`)
    return undefined
  }
  const units = buildUnits(fleet, m)
  return { machine: m, units, ssh: sshConfigFromHost(units[0].config.host) }
}

export async function sshCommand(args: string[], fleetPath: string, out: Output): Promise<number> {
  const name = args[0]
  if (!name || name.startsWith('-')) {
    out.fail('usage: airstack ssh <machine> [-- <command…>]')
    return EXIT.USAGE
  }
  const fleet = loadFleet(fleetPath)
  const s = machineSsh(fleet, name, out)
  if (!s) return EXIT.FAIL
  const dd = args.indexOf('--')
  const cmd = dd >= 0 ? args.slice(dd + 1) : []
  const proc = Bun.spawn(['ssh', ...sshArgs(s.ssh, { batchMode: false }), ...(cmd.length ? [] : ['-t']), userHost(s.ssh), ...cmd], {
    stdout: 'inherit', stderr: 'inherit', stdin: 'inherit',
    env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
  })
  return await proc.exited
}

export async function statusCommand(args: string[], fleetPath: string, out: Output): Promise<number> {
  const fleet = loadFleet(fleetPath)
  const targets = args.filter((a) => !a.startsWith('-'))
  const { selected, unmatched } = selectTargets(fleet.machines.map((m) => m.name), targets, args.includes('--all') || targets.length === 0)
  for (const u of unmatched) out.fail(`no machine matches '${u}'`)
  for (const name of selected) {
    const s = machineSsh(fleet, name, out)
    if (!s) continue
    const remote = createRemoteExecutor(s.ssh)
    const ping = await remote.run('true')
    if (ping.exitCode !== 0) {
      out.fail(`${name}: unreachable over SSH (${userHost(s.ssh)}:${s.ssh.port})`)
      continue
    }
    const marker = await readMarker(remote)
    if (!marker.exists) {
      out.warn(`${name}: reachable, but airstack is not installed there (no /etc/airstack/machine.yaml)`)
      out.next(`airstack deploy ${name} --install`)
      continue
    }
    for (const unit of s.units) {
      const ctx = { config: unit.config } as DeployContext
      const ps = await remote.run(`${composeCommand(ctx, `ps --all --format '{{.Service}} {{.State}} {{.Status}}'`)} 2>/dev/null`)
      const rows = ps.stdout.trim().split('\n').filter(Boolean)
      const label = `${name}/${unit.name}`
      if (ps.exitCode !== 0 || rows.length === 0) {
        out.info(`${label}: no containers`)
        continue
      }
      const bad = rows.filter((r) => !/ running /.test(` ${r} `))
      const summary = rows.map((r) => r.split(' ').slice(0, 2).join('=')).join(' ')
      if (bad.length) out.warn(`${label}: ${summary}`)
      else out.ok(`${label}: ${summary}`)
    }
    const orphans = Object.entries(marker.stacks).filter(([n]) => !s.machine.instances.some((i) => i.name === n))
    for (const [n] of orphans) out.warn(`${name}/${n}: deployed but not in the machine file -> airstack deploy ${name} --prune`)
  }
  return unmatched.length ? EXIT.FAIL : out.code()
}
