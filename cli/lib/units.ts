/**
 * units.ts — turn a fleet machine into deploy units for the existing deploy pipeline.
 *
 * One machine = one MACHINE unit (compose project `airstack`: machine-scope plugins such as the
 * cloudflared sidecar, host crons, tailscale) + one unit per STACK INSTANCE (own compose project,
 * own install dir, own run user). Each unit gets a Config in the shape the deploy phases and
 * built-in plugins already read (host / stack / plugins / templates / deploy), so the pipeline
 * runs unchanged per unit. Phase 2 moves apply onto the node and can drop this adapter.
 *
 * Box files keep the stack-cli name docker-compose.yml for now; a stack template whose
 * destination is compose.yaml is staged as docker-compose.yml.
 */

import { join } from 'node:path'
import { resolveTz } from './schedule-time.js'
import { CORE_ROOT, type Fleet, type Machine, type StackInstance } from './fleet.js'
import { isPlainObject, type Plain } from './merge.js'
import type { Config, HostConfig as LegacyHost, TemplateEntry } from '../types.js'

export const MACHINE_UNIT = 'airstack'
const COMPOSE_DESTS = ['docker-compose.yml', 'compose.yaml', 'compose.yml', 'docker-compose.yaml']

export interface DeployUnit {
  name: string
  kind: 'machine' | 'stack'
  machine: string
  /** Base for the unit's deploy/ dir and template sources (stack dir, or machine dir). */
  projectRoot: string
  /** Template fallbacks: fleet root (templates/), then the core. */
  sharedPaths: string[]
  deployDir: string
  logRoot: string
  reportPath: string
  config: Config
  /** Plugin refs (airstack/x or fleet name) with their config, in declaration order. */
  pluginRefs: { ref: string; config: unknown }[]
  /** True when the unit has its own compose template (else only plugin services can add one). */
  hasComposeTemplate: boolean
  instance?: StackInstance
}

export function buildUnits(fleet: Fleet, machine: Machine, only?: string): DeployUnit[] {
  const units: DeployUnit[] = [machineUnit(fleet, machine)]
  for (const inst of machine.instances) {
    if (only && inst.name !== only) continue
    units.push(stackUnit(fleet, machine, inst))
  }
  return units
}

/** Legacy plugin key for a ref: `airstack/cron` → `cron`, fleet `hello` → `hello`. */
export function pluginKey(ref: string): string {
  return ref.startsWith('airstack/') ? ref.slice('airstack/'.length) : ref
}

function paths(fleet: Fleet, machine: Machine, unit: string) {
  const base = join(fleet.root, '.airstack')
  return {
    deployDir: join(base, 'deploy', machine.name, unit),
    logRoot: join(base, 'logs', machine.name, unit),
    reportPath: join(base, 'reports', machine.name, `${unit}.md`),
  }
}

function legacyHost(machine: Machine, runUser: string): LegacyHost {
  const h = machine.host
  return {
    hostname: h.hostname,
    timezone: h.timezone ? resolveTz(h.timezone) : '',
    ip: h.ip,
    sshUser: h.ssh.user,
    sshPort: h.ssh.port,
    sshKey: h.ssh.key,
    sudoUser: h.users.sudo,
    sudoUserPassword: machine.secrets.SUDO_USER_PASSWORD ?? '',
    appUser: runUser,
    appUserPassword: '',
    devUsers: h.users.dev,
    brewOwner: h.users.brewOwner,
    sshHardenedPort: h.ssh.hardenedPort,
    sshExpose: h.ssh.expose,
    sshTunnelHostname: h.ssh.tunnelHostname,
  }
}

function legacyPlugins(refs: Record<string, unknown>): { plugins: Record<string, unknown>; list: { ref: string; config: unknown }[] } {
  const plugins: Record<string, unknown> = {}
  const list: { ref: string; config: unknown }[] = []
  for (const [ref, cfg] of Object.entries(refs)) {
    const key = pluginKey(ref)
    if (key in plugins) throw new Error(`plugins '${ref}' and another plugin both map to '${key}'`)
    plugins[key] = cfg ?? {}
    list.push({ ref, config: cfg ?? {} })
  }
  return { plugins, list }
}

/**
 * Stack crons run as the instance's run user unless they name a user. (The cron plugin defaults
 * to root, which is right for machine-level host_ checks but never for a stack: a dev-user
 * stack's cron must not run as root.)
 */
function withStackCronUser(refs: Record<string, unknown>, user: string): Record<string, unknown> {
  const cron = refs['airstack/cron']
  if (!isPlainObject(cron) || !isPlainObject(cron.crons)) return refs
  const crons: Plain = {}
  for (const [name, v] of Object.entries(cron.crons)) {
    if (typeof v === 'string') crons[name] = { schedule: v, user }
    else if (isPlainObject(v)) crons[name] = v.user === undefined ? { ...v, user } : v
    else crons[name] = v
  }
  return { ...refs, 'airstack/cron': { ...cron, crons } }
}

function deployConfig(p: ReturnType<typeof paths>, raw: Plain = {}): Config['deploy'] {
  const sync = (raw.sync ?? {}) as Plain
  return {
    sync: {
      default: sync.default === 'preserve' ? 'preserve' : 'delete',
      preserve: Array.isArray(sync.preserve) ? sync.preserve.map(String) : [],
      delete: Array.isArray(sync.delete) ? sync.delete.map(String) : [],
    },
    hooks: (isPlainObject(raw.hooks) ? raw.hooks : {}) as Record<string, string>,
    report: { template: 'templates/deploy-report.md.hbs', destination: p.reportPath, secrets: [] },
    stagingDir: p.deployDir,
    deployLogs: p.logRoot,
  }
}

function machineUnit(fleet: Fleet, machine: Machine): DeployUnit {
  const p = paths(fleet, machine, MACHINE_UNIT)
  const { plugins, list } = legacyPlugins(machine.plugins)
  const cf = (plugins.cloudflare ?? {}) as Plain
  const config: Config = {
    stackConfig: { stackFile: machine.file, envFile: '', allowUnsafeGit: false },
    host: legacyHost(machine, machine.host.users.stack),
    stack: {
      installDir: `${machine.root}/machine`,
      projectName: MACHINE_UNIT,
      runUserKind: 'stack',
      dockerSubnet: machine.host.dockerSubnet,
      airstack: { machine: machine.name, unit: MACHINE_UNIT, kind: 'machine' },
      ...(plugins.cloudflare ? { cloudflared: { tunnelToken: String(cf.tunnelToken ?? ''), hostNetwork: Boolean(cf.hostNetwork) } } : {}),
    },
    templates: { 'docker-compose.yml': { src: 'templates/compose.machine.yaml.hbs' } },
    plugins,
    deploy: deployConfig(p),
  }
  return {
    name: MACHINE_UNIT, kind: 'machine', machine: machine.name,
    projectRoot: machine.dir ?? join(fleet.root, 'machines', `.${machine.name}`),
    sharedPaths: [fleet.root, CORE_ROOT],
    ...p, config, pluginRefs: list, hasComposeTemplate: false,
  }
}

function stackUnit(fleet: Fleet, machine: Machine, inst: StackInstance): DeployUnit {
  const p = paths(fleet, machine, inst.name)
  const c = inst.config
  const { plugins, list } = legacyPlugins(withStackCronUser((c.plugins ?? {}) as Record<string, unknown>, inst.user))
  const values = (isPlainObject(c.values) ? c.values : {}) as Plain

  const templates: Record<string, TemplateEntry> = {}
  let hasComposeTemplate = false
  for (const [dest, entry] of Object.entries((c.templates ?? {}) as Plain)) {
    const src = typeof entry === 'string' ? entry : String((entry as Plain)?.src ?? '')
    const isCompose = COMPOSE_DESTS.includes(dest)
    if (isCompose) hasComposeTemplate = true
    templates[isCompose ? 'docker-compose.yml' : dest] = { src }
  }
  if (!hasComposeTemplate) templates['docker-compose.yml'] = { src: 'templates/compose.stack.yaml.hbs' }

  const config: Config = {
    stackConfig: { stackFile: inst.stackFile, envFile: '', allowUnsafeGit: false },
    host: legacyHost(machine, inst.user),
    stack: {
      ...values,
      values,
      installDir: inst.installDir,
      projectName: inst.composeProject,
      runUserKind: inst.userKind,
      airstack: { machine: machine.name, unit: inst.name, kind: 'stack', ref: inst.ref },
    },
    templates,
    plugins,
    deploy: deployConfig(p, (c.deploy ?? {}) as Plain),
  }
  return {
    name: inst.name, kind: 'stack', machine: machine.name,
    projectRoot: inst.stackDir,
    sharedPaths: [fleet.root, CORE_ROOT],
    ...p, config, pluginRefs: list, hasComposeTemplate, instance: inst,
  }
}
