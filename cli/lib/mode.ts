/**
 * mode.ts — which mode this machine runs in, and which verbs it may use.
 *
 * THIS IS AN ACCIDENT GUARD, NOT A SECURITY BOUNDARY (AGENTS.md rule 1). Anyone can copy the
 * binary and drop these checks; real limits are Unix permissions and sudoers.
 *
 * Resolution (plans/phase-1.md 5.1):
 *   /etc/airstack/machine.yaml exists → NODE mode
 *     - must be root-owned and not group/world writable, else every mutating verb is refused
 *     - roles: [node] → node verbs only; [node, controller] → also controller verbs, and the
 *       fleet is ONLY the root-pinned `controller.fleet` path (./airstack.yaml is ignored)
 *   no marker → CONTROLLER mode
 *     - fleet = --fleet <path> | ./airstack.yaml | `fleet:` in ~/.config/airstack/config.yaml
 *     - never a parent-directory walk
 * User config and AIRSTACK_DISABLE may only turn verbs OFF (rule 2). There is deliberately no env
 * var or flag that moves the marker location: that would let an environment widen permissions.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import * as yaml from 'js-yaml'

export type Role = 'node' | 'controller'
export type Requires = 'any' | 'controller' | 'node'

export interface VerbSpec {
  name: string
  requires: Requires
  /** Needs a fleet repo (controller verbs that read fleet config). */
  needsFleet?: boolean
  /** Changes something (files, machines). Refused when the node marker is untrustworthy. */
  mutating?: boolean
}

export interface MarkerInfo {
  path: string
  machine?: string
  fleet?: string
  roles: Role[]
  paths: Record<string, string>
  controllerFleet?: string
  /** Why the marker cannot be trusted (bad owner/mode, unreadable, invalid). */
  problem?: string
}

export interface ModeInfo {
  mode: 'controller' | 'node'
  roles: Role[]
  marker?: MarkerInfo
  userConfigPath: string
  userConfigExists: boolean
  /** Verbs disabled by user config or env, with where it came from. */
  disabled: Map<string, string>
  fleetPath?: string
  fleetSource?: 'flag' | 'cwd' | 'config' | 'pinned'
  /** Set when a fleet was looked for but rejected (e.g. ./airstack.yaml on a node). */
  fleetNote?: string
}

export interface ResolveOpts {
  cwd?: string
  fleetFlag?: string
  env?: Record<string, string | undefined>
  /** Test seams. Production callers never pass these. */
  etcDir?: string
  configDir?: string
  expectedOwnerUid?: number
}

export const MARKER_DIR = '/etc/airstack'

export function resolveMode(opts: ResolveOpts = {}): ModeInfo {
  const env = opts.env ?? process.env
  const cwd = resolve(opts.cwd ?? process.cwd())
  const etcDir = opts.etcDir ?? MARKER_DIR
  const configDir = opts.configDir ?? join(homedir(), '.config', 'airstack')
  const userConfigPath = join(configDir, 'config.yaml')

  const disabled = new Map<string, string>()
  const userConfig = readUserConfig(userConfigPath)
  for (const v of userConfig.disable) disabled.set(v, `${userConfigPath} disable`)
  for (const v of String(env.AIRSTACK_DISABLE ?? '').split(/[\s,]+/).filter(Boolean)) {
    disabled.set(v, 'AIRSTACK_DISABLE')
  }

  const markerPath = join(etcDir, 'machine.yaml')
  if (existsSync(markerPath)) {
    const marker = readMarker(markerPath, opts.expectedOwnerUid ?? 0)
    const info: ModeInfo = {
      mode: 'node',
      roles: marker.problem ? ['node'] : marker.roles,
      marker,
      userConfigPath,
      userConfigExists: userConfig.exists,
      disabled,
    }
    if (!marker.problem && marker.roles.includes('controller') && marker.controllerFleet) {
      info.fleetPath = marker.controllerFleet
      info.fleetSource = 'pinned'
    } else if (existsSync(join(cwd, 'airstack.yaml'))) {
      info.fleetNote = `ignored ./airstack.yaml: node mode uses only the fleet pinned in ${markerPath}`
    }
    return info
  }

  const info: ModeInfo = {
    mode: 'controller',
    roles: ['controller'],
    userConfigPath,
    userConfigExists: userConfig.exists,
    disabled,
  }
  if (opts.fleetFlag) {
    info.fleetPath = resolve(cwd, opts.fleetFlag)
    info.fleetSource = 'flag'
  } else if (existsSync(join(cwd, 'airstack.yaml'))) {
    info.fleetPath = cwd
    info.fleetSource = 'cwd'
  } else if (userConfig.fleet) {
    info.fleetPath = resolve(configDir, userConfig.fleet)
    info.fleetSource = 'config'
  }
  return info
}

export type VerbCheck = { ok: true } | { ok: false; reason: string; short: string }

/** Decide whether a verb may run. The message names the file/key that decided it. */
export function checkVerb(mode: ModeInfo, verb: VerbSpec): VerbCheck {
  const off = mode.disabled.get(verb.name) ?? mode.disabled.get(verb.name.split(' ')[0])
  if (off) return { ok: false, reason: `blocked: ${verb.name} is disabled (${off})`, short: `disabled (${off})` }

  const m = mode.marker
  if (m?.problem && verb.mutating) {
    return { ok: false, reason: `blocked: ${verb.name} refused because ${m.path} is not trusted: ${m.problem}`, short: `untrusted marker` }
  }
  if (verb.requires === 'controller' && !mode.roles.includes('controller')) {
    return {
      ok: false,
      reason: `blocked: ${verb.name} needs controller role (${m?.path ?? MARKER_DIR + '/machine.yaml'} roles: [${mode.roles.join(', ')}])`,
      short: `needs controller role (roles: [${mode.roles.join(', ')}])`,
    }
  }
  if (verb.requires === 'node' && mode.mode !== 'node') {
    return {
      ok: false,
      reason: `blocked: ${verb.name} runs only on a node (no ${MARKER_DIR}/machine.yaml here). Use: airstack ssh <machine> -- airstack ${verb.name}`,
      short: `node only (no ${MARKER_DIR}/machine.yaml)`,
    }
  }
  if (verb.needsFleet && !mode.fleetPath) {
    const why = mode.fleetNote ?? 'no fleet: run in a dir with airstack.yaml, or pass --fleet <path>'
    return { ok: false, reason: `blocked: ${verb.name} needs a fleet (${why})`, short: `needs a fleet (${why})` }
  }
  return { ok: true }
}

// ── readers ─────────────────────────────────────────────────────────────────

function readUserConfig(path: string): { exists: boolean; fleet?: string; disable: string[] } {
  if (!existsSync(path)) return { exists: false, disable: [] }
  try {
    const raw = (yaml.load(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>
    const disable = Array.isArray(raw.disable) ? raw.disable.map(String) : []
    return { exists: true, fleet: typeof raw.fleet === 'string' ? raw.fleet : undefined, disable }
  } catch {
    // A broken user config must not widen anything; treat as present-but-empty.
    return { exists: true, disable: [] }
  }
}

function readMarker(path: string, expectedUid: number): MarkerInfo {
  const base: MarkerInfo = { path, roles: ['node'], paths: {} }
  try {
    for (const p of [path, join(path, '..')]) {
      const st = statSync(p)
      if (st.uid !== expectedUid) return { ...base, problem: `${p} owned by uid ${st.uid}, expected ${expectedUid}` }
      if (st.mode & 0o022) return { ...base, problem: `${p} can be written by group or others (mode ${(st.mode & 0o777).toString(8)})` }
    }
    const raw = (yaml.load(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>
    const roles = (Array.isArray(raw.roles) ? raw.roles : ['node']).map(String)
    const bad = roles.filter((r) => r !== 'node' && r !== 'controller')
    if (bad.length) return { ...base, problem: `unknown roles: ${bad.join(', ')}` }
    const controller = (raw.controller ?? {}) as Record<string, unknown>
    return {
      path,
      machine: typeof raw.machine === 'string' ? raw.machine : undefined,
      fleet: typeof raw.fleet === 'string' ? raw.fleet : undefined,
      roles: (roles.includes('node') ? roles : ['node', ...roles]) as Role[],
      paths: (raw.paths ?? {}) as Record<string, string>,
      controllerFleet: typeof controller.fleet === 'string' ? controller.fleet : undefined,
    }
  } catch (e) {
    return { ...base, problem: `cannot read it: ${e instanceof Error ? e.message : String(e)}` }
  }
}
