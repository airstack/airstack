/**
 * local-executor.ts — a RemoteExecutor that runs on this machine. Lets code written for SSH
 * targets (e.g. node-install.ts) act locally: a node that may update itself uses it.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import type { RemoteExecutor } from '../types.js'

export function createLocalExecutor(): RemoteExecutor {
  return {
    async run(command, opts) {
      const r = spawnSync('bash', ['-c', command], { encoding: 'utf-8', input: opts?.stdin, maxBuffer: 64 * 1024 * 1024 })
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 }
    },
    async rsync(src, dest) {
      try {
        copyFileSync(src, dest)
        return { exitCode: 0 }
      } catch {
        return { exitCode: 1 }
      }
    },
  }
}
