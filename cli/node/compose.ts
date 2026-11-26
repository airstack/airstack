/**
 * compose.ts (node) — docker compose for one unit, run as the unit's user. Dev-user units talk to
 * that user's rootless daemon. Same rules as cli/lib/compose.ts on the controller.
 */

import { spawnSync } from 'node:child_process'
import type { NodeUnit } from './units.js'

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function composeArgv(unit: NodeUnit, args: string[]): string[] {
  const env = unit.userKind === 'dev' ? 'DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock ' : ''
  const inner = `${env}cd ${q(unit.dir)} && docker compose -p ${q(unit.project)} ${args.map(q).join(' ')}`
  return ['sudo', '-u', unit.user, 'bash', '-c', inner]
}

export function compose(unit: NodeUnit, args: string[], inherit = false): { code: number; out: string; err: string } {
  const [cmd, ...rest] = composeArgv(unit, args)
  const r = spawnSync(cmd, rest, { encoding: 'utf-8', stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' }
}

export interface ServiceState {
  service: string
  name: string
  state: string
  health: string
}

/** Services of a unit from `docker compose ps -a --format json` (one JSON object per line). */
export function services(unit: NodeUnit): ServiceState[] | undefined {
  const r = compose(unit, ['ps', '-a', '--format', 'json'])
  if (r.code !== 0) return undefined
  const out: ServiceState[] = []
  for (const line of r.out.split('\n').filter((l) => l.trim().startsWith('{'))) {
    try {
      const j = JSON.parse(line) as Record<string, string>
      out.push({ service: j.Service ?? '', name: j.Name ?? '', state: j.State ?? '', health: j.Health ?? '' })
    } catch { /* skip */ }
  }
  return out
}
