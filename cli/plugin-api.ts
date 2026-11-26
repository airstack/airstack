/**
 * plugin-api.ts — what fleet plugins get from `import { … } from 'airstack'`.
 *
 * Fleet plugins are loaded at runtime (also from the compiled binary, see plans/phase-1.md R1),
 * so they cannot import core files by path. The core registers this object as the virtual
 * module `airstack` before loading any plugin. Keep this surface small and stable: adding is
 * fine, removing or changing a signature is a breaking change for every fleet.
 */

import { parseScheduleTime } from './lib/schedule-time.js'

export const API_VERSION = 1

export const api = {
  API_VERSION,
  /** "9:30 AM" / "every 15 min" style schedules → { cronExpr, ianaTz } */
  parseScheduleTime,
}

let registered = false

/**
 * Make `import … from 'airstack'` resolve to `api`. Idempotent. Bun only: under Node (vitest)
 * it does nothing, so tests of plugins that import 'airstack' run the CLI with Bun instead.
 */
export function registerPluginApi(): boolean {
  const bun = (globalThis as { Bun?: { plugin: (p: unknown) => void } }).Bun
  if (!bun) return false
  if (registered) return true
  registered = true
  bun.plugin({
    name: 'airstack-plugin-api',
    setup(build: { module: (name: string, cb: () => { exports: unknown; loader: 'object' }) => void }) {
      build.module('airstack', () => ({ exports: api, loader: 'object' }))
    },
  })
  return true
}
