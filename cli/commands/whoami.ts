/** airstack whoami — mode, machine/fleet, user, version, which verbs are on and why. */

import { userInfo } from 'node:os'
import { checkVerb, type ModeInfo, type VerbSpec } from '../lib/mode.js'
import type { Output } from '../lib/output.js'

export function whoami(mode: ModeInfo, verbs: VerbSpec[], version: string, out: Output): void {
  const u = userInfo()
  const pad = (k: string) => k.padEnd(9)
  out.info(`${pad('mode')}${mode.mode}`)
  out.info(`${pad('roles')}${mode.roles.join(', ')}`)
  if (mode.marker) {
    out.info(`${pad('machine')}${mode.marker.machine ?? '(unnamed)'}  (${mode.marker.path})`)
    if (mode.marker.problem) out.warn(`untrusted marker: ${mode.marker.problem}; mutating verbs are refused`)
  } else {
    out.info(`${pad('machine')}- (no /etc/airstack/machine.yaml: this is a controller)`)
  }
  out.info(`${pad('fleet')}${mode.fleetPath ? `${mode.fleetPath}  (${mode.fleetSource})` : '-'}`)
  if (mode.fleetNote) out.warn(mode.fleetNote)
  out.info(`${pad('user')}${u.username} (uid ${u.uid})`)
  out.info(`${pad('version')}airstack ${version}`)
  if (mode.userConfigExists) out.info(`${pad('config')}${mode.userConfigPath}`)

  const on: string[] = []
  const off: string[] = []
  for (const v of verbs) {
    const c = checkVerb(mode, v)
    if (c.ok) on.push(v.name)
    else off.push(`${v.name}: ${c.short}`)
  }
  out.info(`${pad('verbs on')}${on.join(' ')}`)
  for (const o of off) out.info(`${pad('off')}${o}`)
}
