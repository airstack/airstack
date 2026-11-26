/**
 * elevate.ts (node) — machine verbs read root-only files (<root>, .stack, /etc/airstack). A non-root
 * user runs them through `sudo -n`. Deploy sets up the airstack-admin group with a sudoers rule
 * for exactly `/usr/local/bin/airstack machine *`, so members need no password and no general sudo.
 *
 * This is a convenience, not a security boundary (AGENTS.md rule 1): sudo decides who may run it.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { COMPILED } from '../lib/core.js'
import { NODE_BIN } from '../lib/release/node-install.js'

export { ADMIN_GROUP } from '../lib/node-setup.js'

export function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

/** The command that runs this airstack again: /usr/local/bin/airstack when it points here. */
function self(): string[] {
  if (!COMPILED) return [process.execPath, process.argv[1]]
  try {
    if (existsSync(NODE_BIN) && realpathSync(NODE_BIN) === realpathSync(process.execPath)) return [NODE_BIN]
  } catch { /* fall through */ }
  return [process.execPath]
}

/** Run the same command line as root. Returns its exit code (stdio passes through). */
export function reexecAsRoot(args: string[]): { code: number; denied: boolean } {
  const [cmd, ...pre] = self()
  const r = spawnSync('sudo', ['-n', cmd, ...pre, ...args], { stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf-8' })
  const err = r.stderr ?? ''
  // sudo's own refusals start with "sudo:" (the wording differs per distro and sudoers settings).
  const denied = r.status !== 0 && /^sudo:/m.test(err)
  if (!denied && err) process.stderr.write(err)
  return { code: r.status ?? 1, denied }
}
