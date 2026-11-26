/**
 * airstack fleet update [<machine>... | '<pattern>' | --all]   put the pinned airstack on machines
 * airstack fleet install <version> <machine>...               put a given airstack on machines
 *
 * Only the airstack build changes (and the version in /etc/airstack/machine.yaml on the next
 * deploy). Stacks keep running. The pin is airstack.yaml `airstack.version`, else this
 * controller's version.
 */

import { loadMachine, selectTargets, type Fleet } from '../lib/fleet.js'
import { buildUnits } from '../lib/units.js'
import { createRemoteExecutor, sshConfigFromHost } from '../lib/ssh.js'
import { rolloutBinary, wantedVersion } from '../lib/release/rollout.js'
import { readMarker } from '../lib/marker.js'
import { EXIT, type Output } from '../lib/output.js'

export async function fleetUpdate(fleet: Fleet, args: string[], out: Output): Promise<number> {
  return rollout(fleet, wantedVersion(fleet), args, out)
}

export async function fleetInstall(fleet: Fleet, args: string[], out: Output): Promise<number> {
  const [version, ...targets] = args
  if (!version || !/^\d+\.\d+\.\d+([-.+][\w.]+)?$/.test(version) || targets.length === 0) {
    out.fail('usage: airstack fleet install <version> <machine>...')
    return EXIT.USAGE
  }
  if (fleet.versionPin && fleet.versionPin !== version) {
    out.warn(`airstack.yaml pins version ${fleet.versionPin}. The next deploy or fleet update installs ${fleet.versionPin} again.`)
  }
  return rollout(fleet, version, targets, out)
}

async function rollout(fleet: Fleet, version: string, args: string[], out: Output): Promise<number> {
  const targets = args.filter((a) => !a.startsWith('-'))
  const all = args.includes('--all') || targets.length === 0
  const { selected, unmatched } = selectTargets(fleet.machines.map((m) => m.name), targets, all)
  for (const u of unmatched) out.fail(`no machine matches '${u}'`)
  for (const name of selected) {
    const m = loadMachine(fleet, name)
    const remote = createRemoteExecutor(sshConfigFromHost(buildUnits(fleet, m)[0].config.host))
    if (!(await readMarker(remote)).exists) {
      out.fail(`${name}: not an airstack node yet`)
      out.next(`airstack deploy ${name} --install`)
      continue
    }
    const r = await rolloutBinary(remote, version, (s) => out.next(`${name}: ${s}`))
    if (r.ok) out.ok(`${name}: ${r.note}`)
    else out.fail(`${name}: ${r.note}`)
  }
  return unmatched.length ? EXIT.FAIL : out.code()
}

