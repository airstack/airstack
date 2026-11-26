// Per-unit service checks: host networking, rootless Docker limits, and the shared network.
// Also collects the host ports each service publishes.

import { isPlainObject, type Plain } from '../merge.js'
import type { Issue, StackInstance } from '../fleet.js'
import { pluginKey, type DeployUnit } from '../units.js'
import { parsePortEntry, type KnownPort, type Published } from './ports.js'

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

export function lintUnit(
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
