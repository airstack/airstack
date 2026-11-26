// Tailscale `ports` / `serve` checks: warn when they name a port that nothing publishes.

import { isPlainObject, type Plain } from '../merge.js'
import type { Issue, Machine } from '../fleet.js'
import { normBind, type Proto, type Published } from './ports.js'

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
export function checkTailscale(machine: Machine, published: Published[], mFile: string, issues: Issue[]) {
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
