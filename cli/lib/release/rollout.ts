/**
 * rollout.ts — one step used by deploy, `fleet update` and `fleet install`: make sure a node runs
 * the wanted airstack build.
 *
 * The wanted version is the fleet pin (airstack.yaml `airstack.version`), else this controller's
 * version. `fleet install <v>` passes an explicit version.
 */

import { VERSION } from '../core.js'
import type { Fleet } from '../fleet.js'
import type { RemoteExecutor } from '../../types.js'
import { obtainRelease } from './obtain.js'
import { nodeVersionLabel, pushRelease, remoteTarget } from './node-install.js'

export interface RolloutResult {
  ok: boolean
  note: string
  version?: string
}

export function wantedVersion(fleet: Fleet): string {
  return fleet.versionPin ?? VERSION
}

export async function rolloutBinary(remote: RemoteExecutor, version: string, log: (s: string) => void = () => {}): Promise<RolloutResult> {
  const target = await remoteTarget(remote)
  if (!target) return { ok: false, note: 'cannot tell the machine OS/CPU (uname -sm), or it is not supported' }
  try {
    const rel = await obtainRelease(target, version, log)
    const r = await pushRelease(remote, rel)
    const label = await nodeVersionLabel(remote)
    if (!label) return { ok: false, note: `installed ${r.name}, but /usr/local/bin/airstack does not run` }
    const what = r.sent ? 'installed' : r.switched ? 'switched to' : 'up to date:'
    return { ok: true, note: `airstack ${what} ${label}`, version: label }
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) }
  }
}
