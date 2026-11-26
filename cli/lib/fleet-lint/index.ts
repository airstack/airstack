/**
 * fleet-lint — machine-wide checks that look across stack instances (plans/phase-1.md section 6):
 *
 *   1. host port collisions (two publishers of the same host port, same protocol, overlapping bind)
 *   2. two instances with the same compose project or the same / nested install dir
 *   3. dev-user (rootless Docker) stacks: no shared `airstack` network, no host port below 1024,
 *      host networking is not the machine's network
 *   4. host networking together with `ports:` (Docker ignores the ports)
 *   + tailscale `ports` / `serve` entries that name a port nothing publishes (warn only)
 *
 * Ports come from the RENDERED compose of each unit, the same way deploy renders it (plugin compose
 * services first, then the unit's compose template), parsed with js-yaml. Nothing is printed from the
 * rendered text: it can hold secrets.
 *
 * What this cannot see:
 *   - Ports an app opens itself inside `network_mode: host` (they are in app config, often VPS-only).
 *     Built-in host-network services have their known ports in KNOWN_HOST_PORTS (networks.ts). Fleet
 *     host-network services are not checked.
 *   - Compose `${VAR}` interpolation without a default (the value lives in an env file on the box).
 *   - Host processes other than sshd (host.ssh.port).
 *
 * This is an accident guard, not a security check (AGENTS.md rule 1).
 */

import { relative } from 'node:path'
import type { Fleet, Issue, Machine } from '../fleet.js'
import { buildUnits, type DeployUnit } from '../units.js'
import { renderCompose } from './render.js'
import { lintUnit } from './networks.js'
import { checkCollisions, type Published } from './ports.js'
import { checkProjectsAndDirs } from './projects.js'
import { checkTailscale } from './tailscale.js'

export { parsePortEntry } from './ports.js'

/** All cross-instance checks for one machine. Never throws. */
export async function lintMachine(fleet: Fleet, machine: Machine): Promise<Issue[]> {
  const issues: Issue[] = []
  if (!machine.file) return issues
  const mFile = relative(fleet.root, machine.file)

  checkProjectsAndDirs(machine, mFile, issues)

  let units: DeployUnit[]
  try {
    units = buildUnits(fleet, machine)
  } catch {
    return issues // a broken plugin map; loadMachine / deploy report it
  }

  const published: Published[] = []
  if (machine.host.ssh.port > 0) {
    published.push({ port: machine.host.ssh.port, proto: 'tcp', bind: '*', key: 'host.ssh.port', owner: 'sshd (host.ssh.port)', unit: 'sshd' })
  }

  for (const unit of units) {
    const rendered = await renderCompose(fleet, unit)
    const key = unit.kind === 'machine' ? 'plugins' : `stacks.${unit.name}`
    if (rendered.error) {
      issues.push({ level: 'warn', file: mFile, key, message: `cannot read the rendered compose file (${rendered.error}). Port and network checks skip this ${unit.kind === 'machine' ? 'machine project' : 'stack'}.` })
      continue
    }
    if (!rendered.doc) continue
    lintUnit(unit, rendered.doc, rendered.serviceOwners, key, mFile, issues, published)
  }

  checkCollisions(published, mFile, issues)
  checkTailscale(machine, published, mFile, issues)
  return issues
}
