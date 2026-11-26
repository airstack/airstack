// Port parsing (compose `ports:` entries) and host port collision checks.

import { isPlainObject } from '../merge.js'
import type { Issue } from '../fleet.js'
import { MACHINE_UNIT } from '../units.js'

export type Proto = 'tcp' | 'udp'

/** One host port that something on the machine listens on. */
export interface Published {
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

export interface KnownPort { port: number; proto: Proto; bind: string }

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

export function normBind(ip: string): string {
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

export function checkCollisions(published: Published[], mFile: string, issues: Issue[]) {
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
