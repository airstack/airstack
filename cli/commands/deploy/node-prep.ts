/**
 * node-prep.ts — before deploy writes any unit: check that the machine is an airstack node,
 * create the machine root, put the wanted airstack build on it, refresh the root-owned helper
 * files and the marker (so new instances are known to the node's history before their deploy).
 */

import type { Fleet, Machine } from '../../lib/fleet.js'
import { markerYaml, readMarker, writeMarker, type MarkerStack } from '../../lib/marker.js'
import { rolloutBinary, wantedVersion } from '../../lib/release/rollout.js'
import { ensureAdminGroup, writeRedactSecrets } from '../../lib/node-setup.js'
import type { Output } from '../../lib/output.js'
import type { RemoteExecutor } from '../../types.js'
import type { Flags } from './flags.js'

export interface NodePrep {
  ok: boolean
  note: string
  previous: Record<string, MarkerStack>
  orphans: [string, MarkerStack][]
  version: string
}

export async function prepareNode(remote: RemoteExecutor, fleet: Fleet, m: Machine, f: Flags, version: string, out: Output): Promise<NodePrep> {
  const name = m.name
  const fail = (note: string): NodePrep => ({ ok: false, note, previous: {}, orphans: [], version })

  const marker = await readMarker(remote)
  if (!marker.exists) {
    out.fail(`${name}: not an airstack node yet (no /etc/airstack/machine.yaml)`)
    out.next(`airstack deploy ${name} --install`)
    return fail('not installed')
  }
  const previous = marker.stacks
  const current = new Set(m.instances.map((i) => i.name))
  const orphans = Object.entries(previous).filter(([inst]) => !current.has(inst))

  // Machine root and stacks/ belong to the stack user, closed to everyone else (docs/LAYOUT.md).
  const su = m.host.users.stack
  const mk = await remote.run(`sudo install -d -o ${su} -g ${su} -m 750 ${m.root} ${m.root}/stacks`)
  if (mk.exitCode !== 0) {
    out.fail(`${name}: cannot create ${m.root} for ${su}: ${(mk.stderr || mk.stdout).trim()}`)
    return fail('machine root')
  }

  // --dry-run changes nothing outside the units: no binary, no helper files, no marker.
  if (f.dryRun) return { ok: true, note: '', previous, orphans, version }

  const bin = await rolloutBinary(remote, wantedVersion(fleet), (s) => out.next(`${name}: ${s}`))
  if (!bin.ok) {
    out.fail(`${name}: ${bin.note}`)
    return fail('airstack binary')
  }
  out.ok(`${name}: ${bin.note}`)
  const nodeVersion = bin.version ?? version

  if (!(await writeRedactSecrets(remote, m))) out.warn(`${name}: could not write /etc/airstack/redact.json (node output may show fewer redactions)`)
  const g = await ensureAdminGroup(remote, m.host.users.admins)
  if (!g.ok) out.warn(`${name}: ${g.note}`)

  if (!(await writeMarker(remote, markerYaml(fleet, m, nodeVersion, Object.fromEntries(orphans))))) {
    out.fail(`${name}: could not write /etc/airstack/machine.yaml`)
    return fail('marker write failed')
  }
  return { ok: true, note: '', previous, orphans, version: nodeVersion }
}
