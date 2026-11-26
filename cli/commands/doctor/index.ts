/**
 * airstack doctor [--fix]                 check this machine (controller or node)
 * airstack doctor <machine>... | --all    on a controller: also run doctor on those nodes
 *
 * `airstack update` runs doctor afterwards: doctor is the one place for checks after a version
 * change. --fix makes only small, safe changes (file modes, .gitignore).
 */

import type { ModeInfo } from '../../lib/mode.js'
import { loadFleet, loadMachine, selectTargets } from '../../lib/fleet.js'
import { buildUnits } from '../../lib/units.js'
import { createRemoteExecutor, sshConfigFromHost } from '../../lib/ssh.js'
import { NODE_BIN } from '../../lib/release/node-install.js'
import { isRoot, reexecAsRoot } from '../../node/elevate.js'
import { EXIT, type Output } from '../../lib/output.js'
import { doctorController } from './controller.js'
import { doctorNode } from './node.js'

export async function doctorCommand(mode: ModeInfo, args: string[], out: Output): Promise<number> {
  const fix = args.includes('--fix')
  const targets = args.filter((a) => !a.startsWith('-'))

  if (mode.mode === 'node') {
    if (!isRoot()) {
      const r = reexecAsRoot(['doctor', ...args])
      if (!r.denied) return r.code
      out.warn('not root: some checks are skipped (run with sudo for all)')
    }
    doctorNode(mode, fix, out)
    return out.code()
  }

  doctorController(mode.fleetPath, fix, out)
  if ((targets.length || args.includes('--all')) && mode.fleetPath) {
    const fleet = loadFleet(mode.fleetPath)
    const { selected, unmatched } = selectTargets(fleet.machines.map((m) => m.name), targets, args.includes('--all'))
    for (const u of unmatched) out.fail(`no machine matches '${u}'`)
    for (const name of selected) {
      out.info(`\n${name}:`)
      const remote = createRemoteExecutor(sshConfigFromHost(buildUnits(fleet, loadMachine(fleet, name))[0].config.host))
      const r = await remote.run(`sudo ${NODE_BIN} doctor${fix ? ' --fix' : ''}`)
      const text = (r.stdout || r.stderr).trim()
      for (const line of text.split('\n')) out.info(`  ${line}`)
      if (r.exitCode === 2 || r.exitCode === 127) out.failures++
      else if (r.exitCode === 1) out.warnings++
    }
  }
  return out.code() === EXIT.OK ? EXIT.OK : out.code()
}
