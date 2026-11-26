/**
 * history-hooks.ts — deploy's side of the config history (the node side is cli/node/).
 * An internal plugin that deploy adds last to every unit:
 *
 *   stage      write .stack-config/managed.json (rendered files, tracked files, redact rules)
 *   pre-sync   drift guard: ask the node which box edits this deploy would overwrite. Refuse
 *              unless --force. A box edit that `airstack pull` brought down does not count.
 *   post-sync  record the deploy in the node's history
 *
 * When the node has no airstack with config history yet, the guard warns and lets deploy go on.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { writeManaged } from './managed.js'
import { NODE_BIN } from './release/node-install.js'
import type { DeployContext, Plugin } from '../types.js'

export const STACK_BASE_FILE = '.stack-base'

export interface HistoryOptions {
  /** Unit name on the node: "machine" or the stack instance name. */
  nodeUnit: string
  /** .airstack/deploy/<machine>/ (holds .stack-base after a pull). */
  machineDeployDir: string
  fleetCommit: string
  force: boolean
}

export function blobId(data: Buffer): string {
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
}

/** Fleet repo commit, with "-dirty" when the work tree has changes. */
export function fleetCommit(root: string): string {
  const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf-8' })
  const head = git('rev-parse', '--short', 'HEAD')
  if (head.status !== 0) return 'no-git'
  const dirty = git('status', '--porcelain').stdout.trim() ? '-dirty' : ''
  return `${head.stdout.trim()}${dirty}`
}

export function readStackBase(machineDeployDir: string): string | undefined {
  const f = join(machineDeployDir, STACK_BASE_FILE)
  const v = existsSync(f) ? readFileSync(f, 'utf-8').trim() : ''
  return /^[0-9a-f]{40}$/.test(v) ? v : undefined
}

export function historyPlugin(o: HistoryOptions): Plugin {
  let rendered: string[] = []
  const warn = (ctx: DeployContext, message: string) => ctx.errors.push({ phase: ctx.phase, message, fatal: false })

  return {
    name: 'airstack-history',
    scope: 'any',
    hooks: {
      stage: async (ctx) => {
        const tracked = ctx.plugins.flatMap((p) => p.tracked ?? [])
        const redact = ctx.plugins.flatMap((p) => p.redact ?? [])
        const m = writeManaged(ctx.deployDir, {
          unit: o.nodeUnit,
          kind: o.nodeUnit === 'machine' ? 'machine' : 'stack',
          fleetCommit: o.fleetCommit,
          deployedAt: new Date().toISOString(),
          tracked,
          redact,
        })
        rendered = m.rendered
      },

      'pre-sync': async (ctx) => {
        if (!ctx.remote) return
        const incoming: Record<string, string> = {}
        for (const rel of rendered) incoming[rel] = blobId(readFileSync(join(ctx.deployDir, rel)))
        const base = readStackBase(o.machineDeployDir)
        const cmd = `sudo ${NODE_BIN} machine drift ${o.nodeUnit}${base ? ` --base ${base}` : ''}`
        const r = await ctx.remote.run(cmd, { stdin: JSON.stringify({ incoming }) })
        const line = r.stdout.trim().split('\n').pop() ?? ''
        let res: { conflicts?: string[]; boxEdits?: string[] }
        try {
          res = JSON.parse(line)
        } catch {
          warn(ctx, `config history: the drift check did not run (${(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.exitCode}`}); box edits are not checked`)
          return
        }
        if (res.boxEdits?.length) ctx.log.info(`box edits saved in history: ${res.boxEdits.join(', ')}`)
        const conflicts = res.conflicts ?? []
        if (conflicts.length === 0) return
        const list = conflicts.join(', ')
        if (o.force) {
          warn(ctx, `--force: overwrites box edits to ${list} (they stay in the machine's config history)`)
          return
        }
        ctx.errors.push({
          phase: 'pre-sync',
          fatal: true,
          message: `box edits would be lost: ${list}. Run \`airstack pull <machine>\` and put the edits in the fleet repo, or deploy with --force (the edits stay in history).`,
        })
      },

      'post-sync': async (ctx) => {
        if (!ctx.remote) return
        const r = await ctx.remote.run(`sudo ${NODE_BIN} machine record-deploy ${o.nodeUnit} --commit ${o.fleetCommit}`)
        if (r.exitCode !== 0) warn(ctx, `config history: could not record the deploy (${(r.stderr || r.stdout).trim().split('\n').pop()})`)
      },
    },
  }
}
