/**
 * fleet.ts — fleet repo loader (plans/phase-1.md sections 3 and 4).
 *
 *   airstack.yaml                 fleet marker + version pin
 *   machines/<m>.yaml             machine (simple form)
 *   machines/<m>/machine.yaml     machine (dir form, may hold deploy/ files)
 *   stacks/<s>/stack.yaml         reusable stack
 *   plugins/<p>/index.ts          fleet plugin (bare name)
 *   .airstack/secrets/_fleet.jsonc, <machine>.jsonc   secrets (gitignored)
 *
 * References: `stack: x` / plugin `x` resolve in the fleet repo ONLY; built-ins are always
 * `airstack/x`. A bare name never falls back to a built-in (typo / rename protection).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser'
import { resolveDefaults } from './defaults.js'
import { mergeLayers, isPlainObject, type Plain } from './merge.js'
import { parseYamlWithRefs, resolveRefs } from './vars.js'

import { BUILTIN_PLUGINS_DIR, BUILTIN_STACKS_DIR } from './core.js'

export { CORE_ROOT, BUILTIN_PLUGINS_DIR, BUILTIN_STACKS_DIR } from './core.js'
export const BUILTIN_PREFIX = 'airstack/'
/** Machine root when the machine file sets none (plans/phase-1.md: /srv is for data a host serves). */
export const DEFAULT_MACHINE_ROOT = '/srv/airstack'

const NAME_RE = /^[a-z][a-z0-9-]*$/
const STACK_KEYS = new Set(['user', 'installDir', 'composeProject', 'values', 'templates', 'plugins', 'deploy'])
const MACHINE_KEYS = new Set(['machine', 'host', 'root', 'plugins', 'stacks'])

// ── types ───────────────────────────────────────────────────────────────────

export interface Issue {
  level: 'fail' | 'warn'
  /** Path relative to the fleet root when possible. */
  file: string
  /** Config key path inside the file, if any. */
  key?: string
  message: string
}

export interface Fleet {
  root: string
  name: string
  versionPin?: string
  machines: MachineRef[]
  issues: Issue[]
}

export interface MachineRef {
  name: string
  file: string
  /** Set for the dir form (machines/<m>/). */
  dir?: string
}

export interface HostConfig {
  hostname: string
  ip: string
  timezone: string
  /** port/user = the FINISHED machine; bootstrap* = a fresh box before setup (used only by --install). */
  ssh: { user: string; port: number; key: string; hardenedPort: number; bootstrapPort: number; bootstrapUser: string; expose: 'public' | 'tunnel'; tunnelHostname: string }
  users: { sudo: string; stack: string; dev: string[]; brewOwner: string }
  dockerSubnet: string
}

export interface StackInstance {
  name: string
  ref: string
  source: 'fleet' | 'builtin'
  stackDir: string
  stackFile: string
  user: string
  userKind: 'stack' | 'dev'
  installDir: string
  composeProject: string
  /** Merged config (secrets resolved). */
  config: Plain
  /** Same tree with `${NAME}` left in place, safe to print. */
  display: Plain
  origins: Map<string, string>
}

export interface Machine {
  name: string
  file: string
  dir?: string
  host: HostConfig
  root: string
  /** host + root with `${NAME}` left in place, safe to print. */
  displayHost: Plain
  /** Machine-scope plugin refs → config (secrets resolved). */
  plugins: Record<string, unknown>
  displayPlugins: Record<string, unknown>
  instances: StackInstance[]
  /** Secret names referenced anywhere for this machine (redaction list later). */
  secretsUsed: string[]
  /** Secret values (for redaction). Never print. */
  secretValues: string[]
  /** All secrets for this machine (_fleet + machine file). Never print. */
  secrets: Record<string, string>
  issues: Issue[]
}

export type PluginRef =
  | { ok: true; ref: string; name: string; source: 'fleet' | 'builtin'; path: string }
  | { ok: false; ref: string; message: string }

// ── fleet root ──────────────────────────────────────────────────────────────

export function loadFleet(root: string): Fleet {
  root = resolve(root)
  const issues: Issue[] = []
  const markerFile = join(root, 'airstack.yaml')
  let name = ''
  let versionPin: string | undefined
  if (!existsSync(markerFile)) {
    issues.push({ level: 'fail', file: 'airstack.yaml', message: `not found in ${root}` })
  } else {
    try {
      const { data } = parseYamlWithRefs(readFileSync(markerFile, 'utf8'), markerFile)
      const raw = (data ?? {}) as Plain
      const fleet = (raw.fleet ?? {}) as Plain
      const air = (raw.airstack ?? {}) as Plain
      name = typeof fleet.name === 'string' ? fleet.name : ''
      versionPin = air.version !== undefined ? String(air.version) : undefined
      if (!name) issues.push({ level: 'warn', file: 'airstack.yaml', key: 'fleet.name', message: 'not set' })
    } catch (e) {
      issues.push({ level: 'fail', file: 'airstack.yaml', message: errMsg(e) })
    }
  }
  const machines = discoverMachines(root, issues)
  return { root, name: name || 'fleet', versionPin, machines, issues }
}

function discoverMachines(root: string, issues: Issue[]): MachineRef[] {
  const dir = join(root, 'machines')
  if (!existsSync(dir)) return []
  const found = new Map<string, MachineRef[]>()
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry)
    let ref: MachineRef | undefined
    if (entry.endsWith('.yaml') && statSync(p).isFile()) {
      ref = { name: entry.slice(0, -5), file: p }
    } else if (statSync(p).isDirectory() && existsSync(join(p, 'machine.yaml'))) {
      ref = { name: entry, file: join(p, 'machine.yaml'), dir: p }
    } else if (entry.endsWith('.yml')) {
      issues.push({ level: 'fail', file: rel(root, p), message: 'use .yaml, not .yml' })
    }
    if (!ref) continue
    if (!NAME_RE.test(ref.name)) {
      issues.push({ level: 'fail', file: rel(root, ref.file), message: `machine name '${ref.name}' must match ${NAME_RE}` })
      continue
    }
    found.set(ref.name, [...(found.get(ref.name) ?? []), ref])
  }
  const out: MachineRef[] = []
  for (const [name, refs] of found) {
    if (refs.length > 1) {
      issues.push({
        level: 'fail',
        file: `machines/${name}`,
        message: `defined twice: ${refs.map((r) => rel(root, r.file)).join(' and ')}`,
      })
      continue
    }
    out.push(refs[0])
  }
  return out
}

// ── targets ─────────────────────────────────────────────────────────────────

/** Machine names from args (exact names or `*` patterns) or all. */
export function selectTargets(names: string[], args: string[], all: boolean): { selected: string[]; unmatched: string[] } {
  if (all) return { selected: [...names], unmatched: [] }
  const selected = new Set<string>()
  const unmatched: string[] = []
  for (const a of args) {
    if (a.includes('*')) {
      const re = new RegExp('^' + a.split('*').map(escapeRe).join('.*') + '$')
      const hits = names.filter((n) => re.test(n))
      if (hits.length === 0) unmatched.push(a)
      hits.forEach((h) => selected.add(h))
    } else if (names.includes(a)) {
      selected.add(a)
    } else {
      unmatched.push(a)
    }
  }
  return { selected: names.filter((n) => selected.has(n)), unmatched }
}

// ── secrets ─────────────────────────────────────────────────────────────────

export function loadSecrets(root: string, machine: string, issues: Issue[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['_fleet', machine]) {
    const file = join(root, '.airstack', 'secrets', `${name}.jsonc`)
    if (!existsSync(file)) continue
    const errors: ParseError[] = []
    const data = parseJsonc(readFileSync(file, 'utf8'), errors, { allowTrailingComma: true })
    if (errors.length) {
      issues.push({ level: 'fail', file: rel(root, file), message: `JSONC error: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}` })
      continue
    }
    if (!isPlainObject(data)) {
      issues.push({ level: 'fail', file: rel(root, file), message: 'must be an object of NAME: value' })
      continue
    }
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
      else issues.push({ level: 'fail', file: rel(root, file), key: k, message: 'value must be a string, number or boolean' })
    }
  }
  return out
}

// ── references ──────────────────────────────────────────────────────────────

export function resolveStackRef(root: string, ref: string):
  | { ok: true; source: 'fleet' | 'builtin'; dir: string; file: string }
  | { ok: false; message: string } {
  const r = parseRef(ref)
  if (!r.ok) return r
  if (r.source === 'builtin') {
    const dir = join(BUILTIN_STACKS_DIR, r.name)
    const file = join(dir, 'stack.yaml')
    return existsSync(file) ? { ok: true, source: 'builtin', dir, file } : { ok: false, message: `no built-in stack '${ref}'` }
  }
  const dir = join(root, 'stacks', r.name)
  const file = join(dir, 'stack.yaml')
  if (existsSync(file)) return { ok: true, source: 'fleet', dir, file }
  const hint = existsSync(join(BUILTIN_STACKS_DIR, r.name, 'stack.yaml')) ? ` -> did you mean ${BUILTIN_PREFIX}${r.name}?` : ''
  return { ok: false, message: `stack '${ref}' not found at stacks/${r.name}/stack.yaml${hint}` }
}

export function resolvePluginRef(root: string, ref: string): PluginRef {
  const r = parseRef(ref)
  if (!r.ok) return { ok: false, ref, message: r.message }
  if (r.source === 'builtin') {
    const path = join(BUILTIN_PLUGINS_DIR, r.name, 'index.ts')
    return existsSync(path)
      ? { ok: true, ref, name: r.name, source: 'builtin', path }
      : { ok: false, ref, message: `no built-in plugin '${ref}'` }
  }
  const path = join(root, 'plugins', r.name, 'index.ts')
  if (existsSync(path)) return { ok: true, ref, name: r.name, source: 'fleet', path }
  const hint = existsSync(join(BUILTIN_PLUGINS_DIR, r.name, 'index.ts')) ? ` -> did you mean ${BUILTIN_PREFIX}${r.name}?` : ''
  return { ok: false, ref, message: `plugin '${ref}' not found at plugins/${r.name}/index.ts${hint}` }
}

function parseRef(ref: string): { ok: true; source: 'fleet' | 'builtin'; name: string } | { ok: false; message: string } {
  if (ref.includes('@')) return { ok: false, message: `'${ref}': versioned references are not supported yet` }
  if (ref.startsWith(BUILTIN_PREFIX)) {
    const name = ref.slice(BUILTIN_PREFIX.length)
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return { ok: false, message: `'${ref}': invalid built-in name` }
    return { ok: true, source: 'builtin', name }
  }
  if (ref.includes('/')) return { ok: false, message: `'${ref}': marketplace references are not supported yet` }
  if (!/^[a-z][a-z0-9_-]*$/.test(ref)) return { ok: false, message: `'${ref}': invalid name` }
  return { ok: true, source: 'fleet', name: ref }
}

// ── machine ─────────────────────────────────────────────────────────────────

interface ParsedFile {
  file: string
  resolved: Plain
  display: Plain
}

function readConfigFile(
  root: string,
  file: string,
  secrets: Record<string, string>,
  issues: Issue[],
  missing: Map<string, Set<string>>,
  used: Set<string>,
): ParsedFile | undefined {
  try {
    const { data, refs } = parseYamlWithRefs(readFileSync(file, 'utf8'), rel(root, file))
    if (data != null && !isPlainObject(data)) {
      issues.push({ level: 'fail', file: rel(root, file), message: 'top level must be a mapping' })
      return undefined
    }
    const withDefaults = resolveDefaults((data ?? {}) as Plain)
    const res = resolveRefs(withDefaults, refs, secrets, 'resolve')
    const disp = resolveRefs(withDefaults, refs, secrets, 'display')
    for (const n of res.missing) missing.set(n, (missing.get(n) ?? new Set()).add(rel(root, file)))
    res.used.forEach((n) => used.add(n))
    return { file, resolved: res.value as Plain, display: disp.value as Plain }
  } catch (e) {
    issues.push({ level: 'fail', file: rel(root, file), message: errMsg(e) })
    return undefined
  }
}

export function loadMachine(fleet: Fleet, name: string): Machine {
  const root = fleet.root
  const ref = fleet.machines.find((m) => m.name === name)
  const issues: Issue[] = []
  const empty: Machine = {
    name, file: '', host: normalizeHost({}, name), displayHost: {}, root: '', plugins: {}, displayPlugins: {},
    instances: [], secretsUsed: [], secretValues: [], secrets: {}, issues,
  }
  if (!ref) {
    issues.push({ level: 'fail', file: 'machines/', message: `no machine '${name}'` })
    return empty
  }
  const secrets = loadSecrets(root, name, issues)
  const missing = new Map<string, Set<string>>()
  const used = new Set<string>()

  const mf = readConfigFile(root, ref.file, secrets, issues, missing, used)
  if (!mf) return { ...empty, file: ref.file, dir: ref.dir }
  const m = mf.resolved
  const mFile = rel(root, ref.file)

  if (m.machine !== name) {
    issues.push({
      level: 'fail', file: mFile, key: 'machine',
      message: m.machine === undefined ? `required: machine: ${name}` : `'${String(m.machine)}' must equal the file name '${name}'`,
    })
  }
  for (const k of Object.keys(m)) {
    if (!MACHINE_KEYS.has(k)) issues.push({ level: 'warn', file: mFile, key: k, message: 'unknown key' })
  }

  const host = normalizeHost((m.host ?? {}) as Plain, name)
  if (!host.ip && !host.hostname) issues.push({ level: 'fail', file: mFile, key: 'host.ip', message: 'host.ip or host.hostname is required' })
  const machineRoot = typeof m.root === 'string' ? m.root : DEFAULT_MACHINE_ROOT
  if (!isAbsolute(machineRoot)) issues.push({ level: 'fail', file: mFile, key: 'root', message: 'must be an absolute path' })

  const plugins = (isPlainObject(m.plugins) ? m.plugins : {}) as Record<string, unknown>
  const displayPlugins = (isPlainObject(mf.display.plugins) ? mf.display.plugins : {}) as Record<string, unknown>
  checkPluginRefs(root, plugins, mFile, 'plugins', issues)

  // stacks: map of instance name → overlay
  const instances: StackInstance[] = []
  const stacksRaw = m.stacks ?? {}
  if (!isPlainObject(stacksRaw)) {
    issues.push({ level: 'fail', file: mFile, key: 'stacks', message: 'must be a map of instance name → overlay (not a list)' })
  } else {
    const stacksDisplay = (mf.display.stacks ?? {}) as Plain
    for (const [inst, overlayRaw] of Object.entries(stacksRaw)) {
      const key = `stacks.${inst}`
      if (!NAME_RE.test(inst)) {
        issues.push({ level: 'fail', file: mFile, key, message: `instance name must match ${NAME_RE}` })
        continue
      }
      const overlay = (overlayRaw ?? {}) as Plain
      const overlayDisplay = (stacksDisplay[inst] ?? {}) as Plain
      if (!isPlainObject(overlay)) {
        issues.push({ level: 'fail', file: mFile, key, message: 'must be a mapping' })
        continue
      }
      const stackRef = typeof overlay.stack === 'string' ? overlay.stack : inst
      const sr = resolveStackRef(root, stackRef)
      if (!sr.ok) {
        issues.push({ level: 'fail', file: mFile, key: `${key}.stack`, message: sr.message })
        continue
      }
      const sf = readConfigFile(root, sr.file, secrets, issues, missing, used)
      if (!sf) continue
      const sFile = sr.source === 'builtin' ? stackRef : rel(root, sr.file)
      for (const k of Object.keys(sf.resolved)) {
        if (!STACK_KEYS.has(k)) issues.push({ level: 'warn', file: sFile, key: k, message: 'unknown key' })
      }
      const { stack: _s, ...over } = overlay
      const { stack: _d, ...overDisp } = overlayDisplay
      for (const k of Object.keys(over)) {
        if (!STACK_KEYS.has(k)) issues.push({ level: 'warn', file: mFile, key: `${key}.${k}`, message: 'unknown key' })
      }
      const merged = mergeLayers([
        { name: `stack:${sFile}`, value: sf.resolved },
        { name: `machine:${mFile}`, value: over },
      ])
      const display = mergeLayers([
        { name: `stack:${sFile}`, value: sf.display },
        { name: `machine:${mFile}`, value: overDisp },
      ]).value

      const instance = finishInstance(inst, stackRef, sr, merged.value, display, merged.origins, host, machineRoot, mFile, issues)
      checkPluginRefs(root, (instance.config.plugins ?? {}) as Record<string, unknown>, mFile, `${key}.plugins`, issues)
      checkStackCrons(instance, mFile, issues)
      instances.push(instance)
    }
  }

  for (const [n, files] of missing) {
    issues.push({
      level: 'fail', file: `.airstack/secrets/${name}.jsonc`, key: n,
      message: `missing secret (referenced in ${[...files].join(', ')}, no default)`,
    })
  }

  const usedNames = [...used].sort()
  return {
    name, file: ref.file, dir: ref.dir, host, root: machineRoot, plugins, displayPlugins, instances,
    displayHost: { host: normalizeHost((mf.display.host ?? {}) as Plain, name), root: mf.display.root ?? machineRoot },
    secretsUsed: usedNames,
    secretValues: usedNames.map((n) => secrets[n]).filter((v) => v && v.length >= 6),
    secrets,
    issues,
  }
}

function finishInstance(
  name: string, ref: string, sr: { source: 'fleet' | 'builtin'; dir: string; file: string },
  config: Plain, display: Plain, origins: Map<string, string>,
  host: HostConfig, machineRoot: string, mFile: string, issues: Issue[],
): StackInstance {
  const key = `stacks.${name}`
  const setDefault = (k: string, v: unknown) => {
    if (config[k] === undefined) {
      config[k] = v
      display[k] = v
      origins.set(k, 'default')
    }
  }
  setDefault('user', host.users.stack)
  const user = String(config.user)
  let userKind: 'stack' | 'dev' = 'stack'
  if (user === host.users.stack) userKind = 'stack'
  else if (host.users.dev.includes(user)) userKind = 'dev'
  else issues.push({ level: 'fail', file: mFile, key: `${key}.user`, message: `'${user}' is neither host.users.stack (${host.users.stack}) nor in host.users.dev` })

  setDefault('installDir', userKind === 'dev' ? `/home/${user}/airstack/${name}` : `${machineRoot}/stacks/${name}`)
  setDefault('composeProject', name)
  const installDir = String(config.installDir)
  if (!isAbsolute(installDir)) issues.push({ level: 'fail', file: mFile, key: `${key}.installDir`, message: 'must be an absolute path' })
  if (userKind === 'dev' && (installDir === machineRoot || installDir.startsWith(machineRoot + '/'))) {
    issues.push({
      level: 'fail', file: mFile, key: `${key}.installDir`,
      message: `a dev-user stack cannot live under ${machineRoot} (the stack user's 750 dir)`,
    })
  }
  const composeProject = String(config.composeProject)
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(composeProject)) {
    issues.push({ level: 'fail', file: mFile, key: `${key}.composeProject`, message: 'must be lowercase letters, digits, - or _' })
  }
  return {
    name, ref, source: sr.source, stackDir: sr.dir, stackFile: sr.file,
    user, userKind, installDir, composeProject, config, display, origins,
  }
}

function checkPluginRefs(root: string, plugins: Record<string, unknown>, file: string, key: string, issues: Issue[]) {
  for (const ref of Object.keys(plugins)) {
    const r = resolvePluginRef(root, ref)
    if (!r.ok) issues.push({ level: 'fail', file, key: `${key}.${ref}`, message: r.message })
  }
}

/** Host-level checks (host_alerter, host_cleanup, …) can only be configured on the machine. */
function checkStackCrons(inst: StackInstance, mFile: string, issues: Issue[]) {
  const cron = ((inst.config.plugins ?? {}) as Plain)['airstack/cron']
  const crons = isPlainObject(cron) && isPlainObject(cron.crons) ? cron.crons : {}
  for (const name of Object.keys(crons)) {
    if (name.startsWith('host_')) {
      issues.push({
        level: 'fail', file: mFile, key: `stacks.${inst.name}.plugins.airstack/cron.crons.${name}`,
        message: 'host_ crons are machine-level only (move to the machine file plugins)',
      })
    }
  }
}

function normalizeHost(h: Plain, machine: string): HostConfig {
  const ssh = (h.ssh ?? {}) as Plain
  const users = (h.users ?? {}) as Plain
  const sudo = String(users.sudo ?? 'adminuser')
  // ssh.port is the port of the finished machine (default 222); a fresh box answers on bootstrapPort.
  const port = Number(ssh.port ?? 222)
  return {
    hostname: String(h.hostname ?? machine),
    ip: String(h.ip ?? ''),
    timezone: String(h.timezone ?? ''),
    ssh: {
      user: String(ssh.user ?? sudo),
      port,
      key: String(ssh.key ?? ''),
      hardenedPort: port,
      bootstrapPort: Number(ssh.bootstrapPort ?? 22),
      bootstrapUser: String(ssh.bootstrapUser ?? 'root'),
      expose: String(ssh.expose ?? 'public') === 'tunnel' ? 'tunnel' : 'public',
      tunnelHostname: String(ssh.tunnelHostname ?? ''),
    },
    users: {
      sudo,
      stack: String(users.stack ?? 'stackroot'),
      dev: Array.isArray(users.dev) ? users.dev.map(String) : [],
      brewOwner: String(users.brewOwner ?? ''),
    },
    dockerSubnet: String(h.dockerSubnet ?? '10.200.0.0/24'),
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function rel(root: string, p: string): string {
  const r = relative(root, p)
  return r.startsWith('..') ? p : r
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e)
}
