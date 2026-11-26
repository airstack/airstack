/**
 * host-scripts.ts (node) — run the machine unit's host scripts the way cron runs them, with the
 * same env file, so `airstack machine check|report` show what the daily report shows.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_PLUGINS_DIR } from '../lib/core.js'
import type { NodeInfo } from './units.js'

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** host_security.sh: the machine unit's copy (matches its config), else the core copy. */
export function securityScript(info: NodeInfo): string {
  const deployed = join(info.root, 'machine', 'plugins', 'cron', 'host-status', 'host_security.sh')
  return existsSync(deployed) ? deployed : join(BUILTIN_PLUGINS_DIR, 'cron', 'deploy', 'host-status', 'host_security.sh')
}

/** The machine unit's cron script + env file for a cron name (e.g. host_alerter_report). */
export function cronScript(info: NodeInfo, cron: string, script: string): { script: string; env?: string } | undefined {
  const dir = join(info.root, 'machine', 'crons')
  const s = join(dir, script)
  if (!existsSync(s)) return undefined
  const env = join(dir, 'env.d', `airstack_${cron}.env`)
  return { script: s, env: existsSync(env) ? env : undefined }
}

/** Run a script with an optional env file sourced first. Output is captured. */
export function runWithEnv(script: string, args: string[], envFile?: string, extra: Record<string, string> = {}, timeoutMs = 120_000): { code: number; out: string; err: string } {
  const set = Object.entries(extra).map(([k, v]) => `export ${k}=${q(v)}; `).join('')
  const src = envFile ? `set -a; . ${q(envFile)}; set +a; ` : ''
  const r = spawnSync('bash', ['-c', `${src}${set}exec bash ${q(script)} ${args.map(q).join(' ')}`], {
    encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  })
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' }
}
