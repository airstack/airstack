/**
 * fleet-lint.ts — machine-wide checks that look across stack instances (plans/phase-1.md section 6):
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
 *     Built-in host-network services have their known ports in KNOWN_HOST_PORTS below. Fleet
 *     host-network services are not checked.
 *   - Compose `${VAR}` interpolation without a default (the value lives in an env file on the box).
 *   - Host processes other than sshd (host.ssh.port).
 *
 * This is an accident guard, not a security check (AGENTS.md rule 1).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import Handlebars from 'handlebars'
import yaml from 'js-yaml'
import { isPlainObject, type Plain } from './merge.js'
import { loadPluginRef } from './fleet-check.js'
import type { Fleet, Issue, Machine, StackInstance } from './fleet.js'
import { buildUnits, pluginKey, MACHINE_UNIT, type DeployUnit } from './units.js'
import { resolveFileOptional } from './resolve-file.js'

type Proto = 'tcp' | 'udp'

/** One host port that something on the machine listens on. */
interface Published {
  port: number
  proto: Proto
  /** '*' = all interfaces, else one address (brackets removed, localhost → 127.0.0.1). */
  bind: string
  /** Config key that owns it (issue key). */
  key: string
  /** Who publishes it, e.g. `stacks.web-a`, `the machine project`, `sshd (host.ssh.port)`. */
  owner: string
  service?: string
  /** Unit name (instance name, `airstack`, or `sshd`). */
  unit: string
}

interface KnownPort { port: number; proto: Proto; bind: string }

/**
 * Host-network services of built-in plugins and the host ports their apps open.
 * Keyed by plugin ref, then compose service name. Plugin config is the (default-filled) plugin block.
 */
const KNOWN_HOST_PORTS: Record<string, Record<string, (cfg: Plain) => KnownPort[]>> = {
  'airstack/cliproxyapi': {
    // CLIProxyAPI listens on 8317, all interfaces (its config.yaml is VPS-only; 8317 is the default
    // that the usage-server and the tailscale docs assume).
    'cli-proxy-api': () => [{ port: 8317, proto: 'tcp', bind: '*' }],
    'usage-server': (cfg) => {
      const us = isPlainObject(cfg.usageServer) ? cfg.usageServer : {}
      return [{ port: Number(us.port ?? 18090), proto: 'tcp', bind: '127.0.0.1' }]
    },
  },
  'airstack/cloudflare': {
    // Host-network cloudflared serves metrics on 127.0.0.1:20241 (see its compose template).
    cloudflared: () => [{ port: 20241, proto: 'tcp', bind: '127.0.0.1' }],
  },
}

const SHARED_NETWORK = 'airstack'

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

// ── 2. compose project and install dir ─────────────────────────────────────

function checkProjectsAndDirs(machine: Machine, mFile: string, issues: Issue[]) {
  const machineDir = `${machine.root}/machine`
  const seenProject = new Map<string, string>()
  const seenDir: { dir: string; owner: string }[] = [{ dir: machineDir, owner: `the machine project (${machineDir})` }]
  for (const inst of machine.instances) {
    const key = `stacks.${inst.name}`
    if (inst.composeProject === MACHINE_UNIT) {
      issues.push({ level: 'fail', file: mFile, key: `${key}.composeProject`, message: `compose project '${MACHINE_UNIT}' is the machine project. Use another composeProject.` })
    } else {
      const other = seenProject.get(inst.composeProject)
      if (other) {
        issues.push({ level: 'fail', file: mFile, key: `${key}.composeProject`, message: `compose project '${inst.composeProject}' is already used by stacks.${other}. Use another composeProject.` })
      } else {
        seenProject.set(inst.composeProject, inst.name)
      }
    }
    const dir = inst.installDir.replace(/\/+$/, '')
    for (const s of seenDir) {
      let why = ''
      if (dir === s.dir) why = `install dir ${dir} is already used by ${s.owner}`
      else if (dir.startsWith(s.dir + '/')) why = `install dir ${dir} is inside the install dir of ${s.owner}`
      else if (s.dir.startsWith(dir + '/')) why = `install dir ${dir} contains the install dir of ${s.owner}`
      if (why) {
        issues.push({ level: 'fail', file: mFile, key: `${key}.installDir`, message: `${why}. Deploy can delete the other stack's files. Use a separate installDir.` })
        break
      }
    }
    seenDir.push({ dir, owner: `stacks.${inst.name}` })
  }
}

// ── render ──────────────────────────────────────────────────────────────────

interface Rendered {
  doc?: Plain
  /** Compose service name → plugin ref that contributed it. */
  serviceOwners: Map<string, string>
  error?: string
}

/** Render a unit's compose like deploy stage does (no enrichment hooks run). */
async function renderCompose(fleet: Fleet, unit: DeployUnit): Promise<Rendered> {
  const serviceOwners = new Map<string, string>()
  // Plugins may fill defaults into their config block: work on a copy, never on the Machine.
  const plugins = structuredClone(unit.config.plugins ?? {}) as Record<string, unknown>
  const ctx: Record<string, unknown> = {
    host: unit.config.host,
    stack: unit.config.stack,
    plugins,
    deploy: unit.config.deploy,
    manifest: { entries: {} },
    compose: {},
  }
  const blocks: string[] = []
  for (const { ref } of unit.pluginRefs) {
    const cfg = plugins[pluginKey(ref)]
    let lp
    try {
      lp = await loadPluginRef(fleet.root, ref, cfg)
    } catch {
      continue // load errors are reported by checkPluginScopes
    }
    for (const svc of lp.plugin.composeServices ?? []) {
      const p = join(lp.plugin.sourceDir ?? '', svc.template)
      if (!existsSync(p)) continue // deploy stage reports it
      let block: string
      try {
        block = Handlebars.compile(readFileSync(p, 'utf8'), { noEscape: true })(ctx)
      } catch (e) {
        return { serviceOwners, error: `${ref} service ${svc.name}: ${short(e)}` }
      }
      blocks.push(block)
      try {
        const part = yaml.load(`services:\n${block}`) as Plain | undefined
        if (isPlainObject(part?.services)) for (const name of Object.keys(part.services)) serviceOwners.set(name, ref)
      } catch {
        serviceOwners.set(svc.name, ref)
      }
    }
  }
  ;(ctx.compose as Plain).pluginServices = blocks.join('\n')

  const entry = unit.config.templates['docker-compose.yml']
  if (!entry) return { serviceOwners }
  const src = resolveFileOptional(unit.projectRoot, unit.sharedPaths, entry.src)
  if (!src) return { serviceOwners } // deploy stage reports a missing template
  let text: string
  try {
    text = entry.src.endsWith('.hbs')
      ? Handlebars.compile(readFileSync(src, 'utf8'), { noEscape: true })(ctx)
      : readFileSync(src, 'utf8')
  } catch (e) {
    return { serviceOwners, error: short(e) }
  }
  try {
    const doc = yaml.load(text)
    if (doc == null) return { serviceOwners }
    if (!isPlainObject(doc)) return { serviceOwners, error: 'top level is not a mapping' }
    return { doc, serviceOwners }
  } catch (e) {
    // js-yaml's message quotes the line, which can hold a secret: keep reason + line only.
    const ye = e as { reason?: string; mark?: { line?: number } }
    return { serviceOwners, error: `YAML: ${ye.reason ?? 'parse error'}${ye.mark?.line !== undefined ? ` at line ${ye.mark.line + 1}` : ''}` }
  }
}

function short(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 120)
}

// ── 1/3/4 per unit ──────────────────────────────────────────────────────────

function lintUnit(
  unit: DeployUnit, doc: Plain, serviceOwners: Map<string, string>, unitKey: string,
  mFile: string, issues: Issue[], published: Published[],
) {
  const inst: StackInstance | undefined = unit.instance
  const dev = inst?.userKind === 'dev'
  const services = isPlainObject(doc.services) ? doc.services : {}
  const plugins = (unit.config.plugins ?? {}) as Record<string, unknown>
  const owner = unit.kind === 'machine' ? 'the machine project' : unitKey

  for (const [svcName, svcRaw] of Object.entries(services)) {
    if (!isPlainObject(svcRaw)) continue
    const svc = svcRaw
    const pluginRef = serviceOwners.get(svcName)
    const key = unit.kind === 'machine' && pluginRef ? `plugins.${pluginRef}` : unitKey
    const hostNet = svc.network_mode === 'host'
    const ports = Array.isArray(svc.ports) ? svc.ports : []

    // 4. host networking ignores ports:
    if (hostNet && ports.length > 0) {
      issues.push({ level: 'warn', file: mFile, key, message: `service ${svcName} uses network_mode: host and also lists ports. Docker ignores these ports. Remove ports, or remove network_mode: host.` })
    }
    // 3. rootless host networking is RootlessKit's namespace, not the machine's network.
    if (hostNet && dev) {
      issues.push({ level: 'warn', file: mFile, key, message: `service ${svcName} uses network_mode: host, but ${inst!.user}'s rootless Docker has its own host network. The machine cannot reach it there. Publish ports instead.` })
    }

    if (hostNet) {
      const known = pluginRef ? KNOWN_HOST_PORTS[pluginRef]?.[svcName] : undefined
      const cfg = pluginRef && isPlainObject(plugins[pluginKey(pluginRef)]) ? (plugins[pluginKey(pluginRef)] as Plain) : {}
      for (const k of known?.(cfg) ?? []) {
        if (k.port >= 1 && k.port <= 65535) published.push({ ...k, key, owner, service: svcName, unit: unit.name })
      }
      continue
    }

    for (const raw of ports) {
      for (const p of parsePortEntry(raw)) {
        published.push({ ...p, key, owner, service: svcName, unit: unit.name })
        if (dev && p.port < 1024) {
          issues.push({ level: 'fail', file: mFile, key, message: `service ${svcName} publishes host port ${p.port}, but ${inst!.user}'s rootless Docker cannot bind ports below 1024. Use a port of 1024 or more.` })
        }
      }
    }
  }

  // 3. shared network: a rootless daemon cannot see the root daemon's `airstack` network.
  if (unit.kind === 'stack') {
    const nets = isPlainObject(doc.networks) ? doc.networks : {}
    for (const [netKey, def] of Object.entries(nets)) {
      const d = isPlainObject(def) ? def : {}
      const name = typeof d.name === 'string' ? d.name : netKey
      if (name !== SHARED_NETWORK) continue
      if (dev) {
        issues.push({
          level: 'fail', file: mFile, key: unitKey,
          message: `the compose file joins the shared '${SHARED_NETWORK}' network, but this stack runs in ${inst!.user}'s rootless Docker. That network is in the root Docker daemon. Remove network '${netKey}', and reach root-daemon services through host loopback ports.`,
        })
      } else if (d.external !== true) {
        issues.push({
          level: 'fail', file: mFile, key: unitKey,
          message: `network '${netKey}' uses the name '${SHARED_NETWORK}' without external: true. The machine project owns that network. Add external: true.`,
        })
      }
    }
  }
}

// ── port parsing ────────────────────────────────────────────────────────────

const MAX_RANGE = 1024

/** Host ports from one compose `ports:` entry. Entries without a fixed host port give nothing. */
export function parsePortEntry(raw: unknown): KnownPort[] {
  if (typeof raw === 'number') return [] // container port only: Docker picks a random host port
  if (isPlainObject(raw)) {
    if (raw.published === undefined || raw.published === null || raw.published === '') return []
    const proto = String(raw.protocol ?? 'tcp').toLowerCase()
    if (proto !== 'tcp' && proto !== 'udp') return []
    return expand(String(raw.published), normBind(String(raw.host_ip ?? '')), proto)
  }
  if (typeof raw !== 'string') return []
  let s = interpolateDefaults(raw.trim())
  if (s === undefined) return []
  let proto: string = 'tcp'
  const pm = s.match(/\/([a-z]+)$/i)
  if (pm) {
    proto = pm[1].toLowerCase()
    s = s.slice(0, -pm[0].length)
  }
  if (proto !== 'tcp' && proto !== 'udp') return []
  let ip = ''
  const v6 = s.match(/^\[([^\]]*)\]:(.*)$/)
  if (v6) {
    ip = v6[1]
    s = v6[2]
  }
  const parts = s.split(':')
  let host: string
  if (v6) {
    if (parts.length !== 2) return []
    host = parts[0]
  } else if (parts.length === 2) {
    host = parts[0]
  } else if (parts.length === 3) {
    ip = parts[0]
    host = parts[1]
  } else {
    return [] // container port only, or a shape we do not read
  }
  if (host === '') return []
  return expand(host, normBind(ip), proto)
}

/** `${VAR:-8080}` / `${VAR-8080}` → 8080. Undefined when a variable has no default. */
function interpolateDefaults(s: string): string | undefined {
  const out = s.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g, '$1')
  return out.includes('$') ? undefined : out
}

function expand(host: string, bind: string, proto: Proto): KnownPort[] {
  const m = host.match(/^(\d{1,5})(?:-(\d{1,5}))?$/)
  if (!m) return []
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : a
  if (a < 1 || b > 65535 || b < a || b - a >= MAX_RANGE) return []
  const out: KnownPort[] = []
  for (let p = a; p <= b; p++) out.push({ port: p, proto, bind })
  return out
}

function normBind(ip: string): string {
  const s = ip.trim().replace(/^\[|\]$/g, '')
  if (s === '' || s === '0.0.0.0' || s === '::') return '*'
  if (s === 'localhost') return '127.0.0.1'
  return s
}

function bindsOverlap(a: string, b: string): boolean {
  return a === '*' || b === '*' || a === b
}

function portText(p: { port: number; proto: Proto; bind: string }): string {
  return `${p.bind === '*' ? '' : p.bind.includes(':') ? `[${p.bind}]:` : `${p.bind}:`}${p.port}${p.proto === 'udp' ? '/udp' : ''}`
}

// ── 1. collisions ───────────────────────────────────────────────────────────

function checkCollisions(published: Published[], mFile: string, issues: Issue[]) {
  for (let i = 0; i < published.length; i++) {
    const b = published[i]
    for (let j = 0; j < i; j++) {
      const a = published[j]
      if (a.port !== b.port || a.proto !== b.proto || !bindsOverlap(a.bind, b.bind)) continue
      // One service that lists the same port twice is one listener, not two.
      if (a.unit === b.unit && a.service === b.service) continue
      const by = a.unit === b.unit
        ? `service ${a.service} in the same ${b.unit === MACHINE_UNIT ? 'project' : 'stack'}`
        : `${a.owner}${a.service ? ` (service ${a.service})` : ''}`
      issues.push({
        level: 'fail', file: mFile, key: b.key,
        message: `${b.service ? `service ${b.service}: ` : ''}host port ${portText(b)} is already used by ${by}. Use another port.`,
      })
      break
    }
  }
}

// ── tailscale ───────────────────────────────────────────────────────────────

function isTailnetIp(ip: string): boolean {
  const m = ip.match(/^100\.(\d+)\.\d+\.\d+$/)
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

function isLoopback(ip: string): boolean {
  return ip.startsWith('127.') || ip === '::1'
}

/**
 * tailscale `ports` and `serve` point at ports that other things publish; they never collide.
 * Warn when they name a port that nothing on the machine publishes where the tailnet can reach it.
 */
function checkTailscale(machine: Machine, published: Published[], mFile: string, issues: Issue[]) {
  const ts = machine.plugins['airstack/tailscale']
  if (!isPlainObject(ts)) return
  const base = 'plugins.airstack/tailscale'
  const serve: { port: number; targetHost: string; targetPort: number }[] = []
  if (Array.isArray(ts.serve)) {
    for (const e of ts.serve) {
      const o: Plain = isPlainObject(e) ? e : { port: e }
      const port = Number(o.port)
      if (!Number.isInteger(port)) continue
      const to = o.to == null ? `127.0.0.1:${port}` : String(o.to)
      const m = to.match(/^(\[::1\]|[A-Za-z0-9.]+):(\d{1,5})$/)
      if (!m) continue // the plugin rejects it at deploy
      serve.push({ port, targetHost: normBind(m[1]), targetPort: Number(m[2]) })
    }
  }
  const servePorts = new Set(serve.map((s) => s.port))

  if (Array.isArray(ts.ports)) {
    for (const e of ts.ports) {
      const m = String(e).trim().match(/^(\d{1,5})(?:\/(tcp|udp))?$/i)
      if (!m) continue // the plugin rejects it at deploy
      const port = Number(m[1])
      const proto = (m[2]?.toLowerCase() ?? 'tcp') as Proto
      if (proto === 'tcp' && servePorts.has(port)) continue // tailscale serve answers on it
      const same = published.filter((p) => p.port === port && p.proto === proto)
      if (same.some((p) => p.bind === '*' || isTailnetIp(p.bind))) continue
      const text = `${port}${proto === 'udp' ? '/udp' : ''}`
      if (same.length > 0 && same.every((p) => isLoopback(p.bind))) {
        issues.push({ level: 'warn', file: mFile, key: `${base}.ports`, message: `port ${text} is published on loopback only (${same[0].owner}${same[0].service ? `, service ${same[0].service}` : ''}). The tailnet cannot reach it. Add it to serve, or publish it on all interfaces.` })
      } else if (same.length === 0) {
        issues.push({ level: 'warn', file: mFile, key: `${base}.ports`, message: `no stack on this machine publishes port ${text}. Remove it from ports, or publish the port in a stack.` })
      }
    }
  }

  for (const s of serve) {
    const ok = published.some((p) => p.port === s.targetPort && p.proto === 'tcp' && (p.bind === '*' || p.bind === s.targetHost))
    if (!ok) {
      issues.push({ level: 'warn', file: mFile, key: `${base}.serve`, message: `serve port ${s.port} forwards to ${s.targetHost}:${s.targetPort}, but no airstack stack publishes that port. This is correct if a service outside airstack listens there.` })
    }
  }
}
