/**
 * deploy-guard.ts — the deploy half of the Cloudflare Access guard (post-deploy hook).
 *
 * After the machine unit starts cloudflared: read the live routes from cloudflared's metrics
 * server on the machine, probe each public hostname from this controller, and act on
 * access.onDeploy:
 *   refuse  stop cloudflared and fail the deploy (names each public route)
 *   warn    keep the tunnel up, add a warning
 * A route that cannot be verified ("unknown") only warns: it never stops the tunnel.
 */

import { composeCommand } from '../../lib/compose.js'
import type { DeployContext } from '../../types.js'
import { checkRoutes, parseIngress, violations, type AccessConfig, type IngressRule, type Prober } from './access.js'

export const CF_METRICS = '127.0.0.1:20241'
const PHASE = 'post-deploy'

export interface GuardOptions {
  probe?: Prober
  /** Tries to read the routes while cloudflared connects (default 15, one per 2 s). */
  tries?: number
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Live ingress from the machine; undefined when cloudflared does not answer in time. */
export async function readRoutes(ctx: DeployContext, opts: GuardOptions = {}): Promise<IngressRule[] | undefined> {
  const tries = opts.tries ?? 15
  const sleep = opts.sleep ?? wait
  for (let i = 0; i < tries; i++) {
    const r = await ctx.remote!.run(`curl -s -m 3 http://${CF_METRICS}/config`)
    const rules = r.exitCode === 0 ? parseIngress(r.stdout) : undefined
    if (rules) return rules
    if (i < tries - 1) await sleep(2000)
  }
  return undefined
}

export async function accessGuard(ctx: DeployContext, cfg: AccessConfig, opts: GuardOptions = {}): Promise<void> {
  if (!ctx.remote || ctx.compose.skip) return
  const warn = (message: string) => ctx.errors.push({ phase: PHASE, message, fatal: false })

  const rules = await readRoutes(ctx, opts)
  if (!rules) {
    warn(`Cloudflare Access: cannot read the tunnel routes (cloudflared metrics on ${CF_METRICS} do not answer); routes not checked`)
    return
  }
  if (rules.length === 0) {
    ctx.log.info('Cloudflare Access: the tunnel has no public hostnames')
    return
  }

  let results = await checkRoutes(rules, cfg, opts.probe)
  // A first request can time out (cold DNS, a new tunnel connection). Ask once more before warning.
  const unknown = rules.filter((_, i) => results[i].state === 'unknown')
  if (unknown.length) {
    await (opts.sleep ?? wait)(3000)
    const again = await checkRoutes(unknown, cfg, opts.probe)
    results = results.map((r) => (r.state === 'unknown' ? again.find((a) => a.url === r.url) ?? r : r))
  }
  for (const r of results) {
    if (r.state === 'protected') ctx.log.info(`Cloudflare Access: ${r.label} is protected`)
    if (r.state === 'unknown') warn(`Cloudflare Access: cannot verify ${r.label} (HTTP ${r.code || 'no answer'})`)
  }
  const bad = violations(results, cfg)
  if (bad.length === 0) return

  const list = bad.map((r) => `${r.label} (HTTP ${r.code} → ${r.service})`).join(', ')
  if (cfg.onDeploy === 'warn') {
    warn(`Cloudflare Access: PUBLIC without Access: ${list}. Set access.onDeploy: refuse to stop the tunnel.`)
    return
  }
  const stop = await ctx.remote.run(`${composeCommand(ctx, 'stop cloudflared')} 2>&1`)
  const stopped = stop.exitCode === 0 ? 'cloudflared is stopped' : `could not stop cloudflared: ${stop.stdout.trim()}`
  ctx.errors.push({
    phase: PHASE,
    fatal: true,
    message: `Cloudflare Access: PUBLIC without Access: ${list}; ${stopped}. `
      + 'Add an Access application for the hostname, or list it in access.exempt, then deploy again.',
  })
}
