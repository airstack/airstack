// Machine loading: read one machine file, merge its stacks, and check the result.

import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { resolveDefaults } from '../defaults.js'
import { mergeLayers, isPlainObject, type Plain } from '../merge.js'
import { parseYamlWithRefs, resolveRefs } from '../vars.js'
import type { Fleet, HostConfig, Issue, Machine, StackInstance } from './types.js'
import { normalizeHost } from './host.js'
import { resolvePluginRef, resolveStackRef } from './refs.js'
import { loadSecrets } from './secrets.js'
import { DEFAULT_MACHINE_ROOT, NAME_RE, errMsg, rel } from './util.js'

const STACK_KEYS = new Set(['user', 'installDir', 'composeProject', 'values', 'templates', 'plugins', 'deploy'])
const MACHINE_KEYS = new Set(['machine', 'host', 'root', 'plugins', 'stacks'])

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
    issues.push({ level: 'fail', file: mFile, key: 'stacks', message: 'must be a map of instance name → settings for that instance (not a list)' })
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
  else issues.push({ level: 'fail', file: mFile, key: `${key}.user`, message: `'${user}' must be host.users.stack (${host.users.stack}) or a user listed in host.users.dev` })

  setDefault('installDir', userKind === 'dev' ? `/home/${user}/airstack/${name}` : `${machineRoot}/stacks/${name}`)
  setDefault('composeProject', name)
  const installDir = String(config.installDir)
  if (!isAbsolute(installDir)) issues.push({ level: 'fail', file: mFile, key: `${key}.installDir`, message: 'must be an absolute path' })
  if (userKind === 'dev' && (installDir === machineRoot || installDir.startsWith(machineRoot + '/'))) {
    issues.push({
      level: 'fail', file: mFile, key: `${key}.installDir`,
      message: `a stack run by a dev user cannot live under ${machineRoot}: only the stack user can enter that folder (mode 750)`,
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
        message: 'host_ crons are machine-level only. Move them to plugins.cron in the machine file.',
      })
    }
  }
}
