// Built-in Tailscale plugin — exposes selected host ports to the tailnet.
//
// Install + login is a provisioning step: `stack-cli vps-setup tailscale`.
// This plugin reconciles which ports the tailnet may reach, on every deploy:
// each listed port gets a UFW allow rule on the tailscale0 interface (tagged
// with a comment), and tagged rules no longer listed are removed. Nothing is
// opened on the public interface.
//
// Config schema (under plugins.tailscale in stack.yml):
//   authKey: ${TAILSCALE_AUTHKEY:-}   # optional, vps-setup tailscale only
//   hostname: testbox                 # optional tailnet name (default host.hostname)
//   ports:                            # tailnet-reachable ports
//     - 8317                          # tcp by default
//     - 53/udp
//   serve:                            # optional: tailnet TCP forwards to loopback services
//     - 3773                          # tailnet:3773 -> 127.0.0.1:3773
//     - { port: 8080, to: 127.0.0.1:9000 }
//
// serve: lets a service that listens only on loopback (127.0.0.1) answer on the
// tailnet, via `tailscale serve --tcp`. Targets must be loopback. The forward
// needs its port in `ports` too, or UFW blocks it (deploy warns when missing).
// Deploy makes the TCP forwards match this list: it adds missing ones, fixes changed
// targets, and removes TCP forwards that are not listed. If `serve` is absent,
// deploy leaves existing forwards alone; `serve: []` removes them all.
//
// A port only answers on the tailnet if its service listens on the tailscale
// IP or on all interfaces (e.g. a host-network container with host ""). Docker
// services published on 127.0.0.1 stay loopback-only.
//
// Registers the 'tailscale' sub-command:
//   status   tailscale status + tailnet IP + managed UFW rules
//   apply    reconcile tailnet port rules without a full deploy

import type { Plugin, DeployContext, PluginCommandContext, RemoteExecutor, DeployLogger } from '../../types.js'

export const RULE_COMMENT = 'stack-cli-tailscale'
const IFACE = 'tailscale0'

export interface PortRule {
  port: number
  proto: 'tcp' | 'udp'
}

const ruleKey = (r: PortRule) => `${r.port}/${r.proto}`

export interface ServeForward {
  port: number
  /** host:port the tailnet port forwards to (loopback only) */
  target: string
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Parse plugins.tailscale.serve. Returns undefined when the key is absent
 * (deploy then leaves forwards alone); [] means "remove all TCP forwards".
 * Entries: 3773 (forwards to 127.0.0.1:3773) or { port, to: "127.0.0.1:9000" }.
 */
export function parseServe(raw: unknown): ServeForward[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) throw new Error('plugins.tailscale.serve must be a list')
  const seen = new Map<number, ServeForward>()
  for (const entry of raw) {
    const obj: Record<string, unknown> = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : { port: entry }
    const portStr = String(obj.port ?? '').trim()
    const port = /^\d{1,5}$/.test(portStr) ? Number(portStr) : NaN
    if (!(port >= 1 && port <= 65535)) {
      throw new Error(`plugins.tailscale.serve: invalid port '${obj.port}' (expected 3773 or { port: 3773, to: 127.0.0.1:3773 })`)
    }
    const to = obj.to == null ? `127.0.0.1:${port}` : String(obj.to).trim()
    const m = to.match(/^(\[::1\]|[A-Za-z0-9.]+):(\d{1,5})$/)
    const toPort = m ? Number(m[2]) : NaN
    if (!m || !LOOPBACK_HOSTS.has(m[1]) || !(toPort >= 1 && toPort <= 65535)) {
      throw new Error(`plugins.tailscale.serve: target '${to}' must be loopback host:port (127.0.0.1, localhost or [::1])`)
    }
    seen.set(port, { port, target: to })
  }
  return [...seen.values()]
}

/** Parse `tailscale serve status --json` into the TCP forwards it lists (port -> target). */
export function parseServeStatus(json: string): Map<number, string> {
  const out = new Map<number, string>()
  const text = json.trim()
  if (!text) return out
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new Error(`could not parse tailscale serve status: ${text.slice(0, 80)}`) }
  const tcp = (data as { TCP?: Record<string, { TCPForward?: string }> } | null)?.TCP ?? {}
  for (const [port, cfg] of Object.entries(tcp)) {
    if (cfg?.TCPForward) out.set(Number(port), cfg.TCPForward)
  }
  return out
}

/** Diff desired vs current TCP forwards. A changed target is an add (serve overwrites in place). */
export function planServe(desired: ServeForward[], current: Map<number, string>): { add: ServeForward[]; remove: number[] } {
  const want = new Set(desired.map((d) => d.port))
  return {
    add: desired.filter((d) => current.get(d.port) !== d.target),
    remove: [...current.keys()].filter((p) => !want.has(p)),
  }
}

/** Parse plugins.tailscale.ports: numbers or "port[/proto]" strings. */
export function parsePorts(raw: unknown): PortRule[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('plugins.tailscale.ports must be a list')
  const seen = new Map<string, PortRule>()
  for (const entry of raw) {
    const m = String(entry).trim().match(/^(\d{1,5})(?:\/(tcp|udp))?$/i)
    const port = m ? Number(m[1]) : NaN
    if (!m || port < 1 || port > 65535) {
      throw new Error(`plugins.tailscale.ports: invalid entry '${entry}' (expected 8317 or 8317/tcp)`)
    }
    const rule: PortRule = { port, proto: (m[2]?.toLowerCase() as 'tcp' | 'udp') ?? 'tcp' }
    seen.set(ruleKey(rule), rule)
  }
  return [...seen.values()]
}

/** Extract the plugin-managed rules from `ufw status` output (v4 and v6 rows collapse). */
export function parseManagedRules(ufwStatus: string): PortRule[] {
  const seen = new Map<string, PortRule>()
  for (const line of ufwStatus.split('\n')) {
    if (!line.includes(`# ${RULE_COMMENT}`)) continue
    const m = line.match(new RegExp(`(\\d+)/(tcp|udp)(?: \\(v6\\))? on ${IFACE}`))
    if (!m) continue
    const rule: PortRule = { port: Number(m[1]), proto: m[2] as 'tcp' | 'udp' }
    seen.set(ruleKey(rule), rule)
  }
  return [...seen.values()]
}

/** Diff desired vs current managed rules. */
export function planRules(desired: PortRule[], current: PortRule[]): { add: PortRule[]; remove: PortRule[] } {
  const want = new Set(desired.map(ruleKey))
  const have = new Set(current.map(ruleKey))
  return {
    add: desired.filter((r) => !have.has(ruleKey(r))),
    remove: current.filter((r) => !want.has(ruleKey(r))),
  }
}

const ufwSpec = (r: PortRule) => `in on ${IFACE} to any port ${r.port} proto ${r.proto}`

/** Reconcile UFW tailnet rules on the VPS. Returns false if tailscale isn't set up. */
async function applyRules(remote: RemoteExecutor, desired: PortRule[], log: DeployLogger): Promise<boolean> {
  const iface = await remote.run(`ip link show ${IFACE} >/dev/null 2>&1 && echo ok`)
  if (iface.stdout.trim() !== 'ok') {
    log.warn(`[tailscale] ${IFACE} not found — run: stack-cli vps-setup tailscale`)
    return false
  }

  // With tailscale's default netfilter mode, INPUT jumps to ts-input which
  // accepts all tailscale0 traffic before UFW — these rules would be moot.
  const divert = await remote.run('sudo iptables -C INPUT -j ts-input 2>/dev/null && echo divert')
  if (divert.stdout.trim() === 'divert') {
    log.warn(`[tailscale] netfilter divert is on — ALL host ports are open to the tailnet; re-run: airstack deploy <machine> --install --step tailscale`)
  }

  const status = await remote.run('sudo ufw status')
  if (status.exitCode !== 0) throw new Error(`ufw status failed: ${status.stderr.trim()}`)
  const { add, remove } = planRules(desired, parseManagedRules(status.stdout))

  for (const r of remove) {
    const res = await remote.run(`sudo ufw delete allow ${ufwSpec(r)}`)
    if (res.exitCode !== 0) throw new Error(`ufw delete ${ruleKey(r)} failed: ${res.stderr.trim()}`)
    log.info(`[tailscale] closed ${ruleKey(r)} on ${IFACE}`)
  }
  for (const r of add) {
    const res = await remote.run(`sudo ufw allow ${ufwSpec(r)} comment '${RULE_COMMENT}'`)
    if (res.exitCode !== 0) throw new Error(`ufw allow ${ruleKey(r)} failed: ${res.stderr.trim()}`)
    log.info(`[tailscale] opened ${ruleKey(r)} on ${IFACE}`)
  }
  if (!add.length && !remove.length) {
    log.info(`[tailscale] tailnet ports up to date: ${desired.map(ruleKey).join(', ') || '(none)'}`)
  }
  return true
}

/** Reconcile `tailscale serve --tcp` forwards. No-op when plugins.tailscale.serve is absent. */
async function applyServe(
  remote: RemoteExecutor,
  serve: ServeForward[] | undefined,
  ports: PortRule[],
  log: DeployLogger,
): Promise<void> {
  if (serve === undefined) return

  for (const f of serve) {
    if (!ports.some((p) => p.proto === 'tcp' && p.port === f.port)) {
      log.warn(`[tailscale] serve ${f.port} is not in plugins.tailscale.ports — UFW will block it on ${IFACE}`)
    }
  }

  const status = await remote.run('sudo tailscale serve status --json')
  if (status.exitCode !== 0) throw new Error(`tailscale serve status failed: ${status.stderr.trim()}`)
  const { add, remove } = planServe(serve, parseServeStatus(status.stdout))

  for (const port of remove) {
    const res = await remote.run(`sudo tailscale serve --tcp=${port} off`)
    if (res.exitCode !== 0) throw new Error(`tailscale serve --tcp=${port} off failed: ${res.stderr.trim()}`)
    log.info(`[tailscale] removed TCP forward ${port}`)
  }
  for (const f of add) {
    const res = await remote.run(`sudo tailscale serve --bg --tcp ${f.port} tcp://${f.target}`)
    if (res.exitCode !== 0) throw new Error(`tailscale serve --tcp ${f.port} failed: ${res.stderr.trim()}`)
    log.info(`[tailscale] forwarding tailnet:${f.port} -> ${f.target}`)
  }
  if (!add.length && !remove.length) {
    log.info(`[tailscale] TCP forwards up to date: ${serve.map((f) => `${f.port}->${f.target}`).join(', ') || '(none)'}`)
  }
}

async function postDeployHook(ctx: DeployContext, raw: unknown): Promise<void> {
  if (!ctx.remote) return
  const cfg = (raw ?? {}) as Record<string, unknown>
  try {
    const desired = parsePorts(cfg.ports)
    const serve = parseServe(cfg.serve)
    const ok = await applyRules(ctx.remote, desired, ctx.log)
    if (ok) await applyServe(ctx.remote, serve, desired, ctx.log)
    ctx.report.data.tailscale = {
      ports: desired.map(ruleKey),
      serve: (serve ?? []).map((f) => `${f.port}->${f.target}`),
      applied: ok,
    }
  } catch (e: any) {
    ctx.errors.push({ phase: 'post-deploy', message: `[tailscale] ${e.message}`, fatal: false })
  }
}

async function tailscaleCommand(args: string[], ctx: PluginCommandContext): Promise<void> {
  const command = args[0] || ''
  const cfg = (ctx.config.plugins.tailscale ?? {}) as Record<string, unknown>
  if (!ctx.remote && (command === 'status' || command === 'apply')) {
    console.error('No VPS configured')
    process.exit(1)
  }

  switch (command) {
    case 'status': {
      const res = await ctx.remote!.run(
        `tailscale status; echo; echo "Tailnet IPv4: $(tailscale ip -4)"; echo; sudo ufw status | grep -E '${IFACE}' || echo '(no tailnet port rules)'; echo; echo "TCP forwards:"; sudo tailscale serve status --json | tr -d '\n' || true; echo`,
      )
      console.log(res.stdout.trimEnd())
      if (res.stderr.trim()) console.error(res.stderr.trimEnd())
      break
    }
    case 'apply': {
      const ports = parsePorts(cfg.ports)
      const serve = parseServe(cfg.serve)
      const ok = await applyRules(ctx.remote!, ports, ctx.log)
      if (!ok) process.exit(1)
      await applyServe(ctx.remote!, serve, ports, ctx.log)
      break
    }
    case '--help': case '-h': case '':
      console.log(`Usage: stack-cli tailscale <command>

Commands:
  status   Show tailnet peers, this box's tailnet IP, and tailnet port rules
  apply    Open/close tailnet ports to match plugins.tailscale.ports and
           make TCP forwards match plugins.tailscale.serve
           (also runs automatically on deploy)

Install + login: stack-cli vps-setup tailscale`)
      break
    default:
      console.error(`Unknown tailscale command: ${command}. Run: stack-cli tailscale --help`)
      process.exit(1)
  }
}

export function register(_config: unknown): Plugin {
  return {
    name: 'tailscale',
    scope: 'machine',
    hooks: {
      'post-deploy': postDeployHook,
    },
    commands: {
      tailscale: {
        description: 'Tailscale tailnet status and port rules',
        run: tailscaleCommand,
      },
    },
  }
}
