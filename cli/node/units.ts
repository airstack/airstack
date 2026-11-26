/**
 * units.ts (node) — the deploy units on this machine, read from /etc/airstack/machine.yaml.
 *
 * The machine unit lives in <root>/machine (compose project `airstack`). Each stack instance has
 * its own install dir, run user and compose project. Names users type: `machine` (or `airstack`)
 * for the machine unit, the instance name for a stack.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { MANAGED_FILE, parseManaged, type Managed } from '../lib/managed.js'

export const MARKER = '/etc/airstack/machine.yaml'
export const REDACT_FILE = '/etc/airstack/redact.json'

export interface NodeUnit {
  name: string
  kind: 'machine' | 'stack'
  dir: string
  /** Path of this unit inside the history store: machine | stacks/<name>. */
  slot: string
  user: string
  userKind: 'stack' | 'dev'
  project: string
}

export interface NodeInfo {
  machine: string
  fleet: string
  root: string
  stackUser: string
  version?: string
  units: NodeUnit[]
}

interface MarkerDoc {
  machine?: string
  fleet?: string
  paths?: { root?: string; stackUser?: string }
  stacks?: Record<string, { installDir: string; user: string; userKind: 'stack' | 'dev'; composeProject: string; orphan?: boolean }>
  airstack?: { version?: string }
}

export function parseNodeInfo(text: string): NodeInfo {
  const doc = (yaml.load(text) ?? {}) as MarkerDoc
  const root = doc.paths?.root ?? '/srv/airstack'
  const stackUser = doc.paths?.stackUser ?? 'stackroot'
  const units: NodeUnit[] = [{
    name: 'machine', kind: 'machine', dir: join(root, 'machine'), slot: 'machine',
    user: stackUser, userKind: 'stack', project: 'airstack',
  }]
  for (const [name, s] of Object.entries(doc.stacks ?? {})) {
    if (s.orphan) continue
    units.push({ name, kind: 'stack', dir: s.installDir, slot: `stacks/${name}`, user: s.user, userKind: s.userKind, project: s.composeProject })
  }
  return { machine: doc.machine ?? 'unknown', fleet: doc.fleet ?? '', root, stackUser, version: doc.airstack?.version, units }
}

export function loadNodeInfo(path = MARKER): NodeInfo {
  return parseNodeInfo(readFileSync(path, 'utf-8'))
}

/** Find a unit by the name a user typed. */
export function findUnit(info: NodeInfo, name: string): NodeUnit | undefined {
  const n = name === 'airstack' ? 'machine' : name
  return info.units.find((u) => u.name === n)
}

export function unitNames(info: NodeInfo): string {
  return info.units.map((u) => u.name).join(', ')
}

export function readUnitManaged(unit: NodeUnit): Managed | undefined {
  const f = join(unit.dir, MANAGED_FILE)
  return existsSync(f) ? parseManaged(readFileSync(f, 'utf-8')) : undefined
}

/** Secret values deploy left for redaction on this machine (root-only file). */
export function readRedactSecrets(path = REDACT_FILE): Record<string, string> {
  try {
    const d = JSON.parse(readFileSync(path, 'utf-8')) as { secrets?: Record<string, string> }
    return d.secrets ?? {}
  } catch {
    return {}
  }
}
