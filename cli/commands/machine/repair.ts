/**
 * machine restart | apply | rollback — repair verbs. They change the machine.
 *
 *   restart <unit> [service]     docker compose restart
 *   apply <unit>                 save box edits in history, then docker compose up -d (use after
 *                                editing a managed file on the machine)
 *   rollback <unit> [<rev>]      write the unit's managed files from a history commit (default:
 *                                the last deploy), save that as a commit, then docker compose up -d
 */

import { compose } from '../../node/compose.js'
import { snapshotUnit } from '../../node/history.js'
import { Store } from '../../node/store.js'
import { findUnit, unitNames, type NodeInfo, type NodeUnit } from '../../node/units.js'
import { EXIT, type Output } from '../../lib/output.js'
import { spawnSync } from 'node:child_process'

function unitArg(info: NodeInfo, name: string | undefined, verb: string, out: Output): NodeUnit | undefined {
  const u = name ? findUnit(info, name) : undefined
  if (!u) {
    out.fail(name ? `no unit '${name}' (units: ${unitNames(info)})` : `name a unit (${unitNames(info)})`)
    out.next(`airstack machine ${verb} <unit>`)
  }
  return u
}

function up(u: NodeUnit, out: Output): boolean {
  const r = compose(u, ['up', '-d', '--remove-orphans'])
  if (r.code !== 0) out.fail(`${u.name}: docker compose up failed: ${(r.err || r.out).trim().split('\n').pop()}`)
  return r.code === 0
}

export function restartCmd(info: NodeInfo, args: string[], out: Output): number {
  const u = unitArg(info, args[0], 'restart', out)
  if (!u) return EXIT.USAGE
  const r = compose(u, ['restart', ...(args[1] ? [args[1]] : [])])
  if (r.code !== 0) { out.fail(`${u.name}: restart failed: ${(r.err || r.out).trim().split('\n').pop()}`); return EXIT.FAIL }
  out.ok(`${u.name}: restarted ${args[1] ?? 'all services'}`)
  return EXIT.OK
}

export function applyCmd(info: NodeInfo, args: string[], out: Output): number {
  const u = unitArg(info, args[0], 'apply', out)
  if (!u) return EXIT.USAGE
  const s = snapshotUnit(new Store(info.root), u)
  if (s.commit) out.ok(`${u.name}: saved box edits in ${s.commit.slice(0, 8)}: ${s.changed.join(', ')}`)
  if (!up(u, out)) return EXIT.FAIL
  out.ok(`${u.name}: applied`)
  if (s.changed.length) out.next(`airstack pull ${info.machine}   (on the controller: bring the edits into the fleet repo)`)
  return out.code()
}

export function rollbackCmd(info: NodeInfo, args: string[], out: Output): number {
  const u = unitArg(info, args[0], 'rollback', out)
  if (!u) return EXIT.USAGE
  const store = new Store(info.root)
  if (!store.exists()) { out.fail('no config history on this machine yet'); return EXIT.FAIL }
  const want = args[1]
  const rev = want ? store.resolve(want) : store.lastDeployed(u.slot)
  if (!rev) { out.fail(want ? `unknown revision: ${want}` : `${u.name}: no deploy recorded yet`); return EXIT.FAIL }

  // Keep what is live now, so the rollback itself can be undone.
  const before = snapshotUnit(store, u, 'box edit (before rollback)')
  if (before.commit) out.ok(`${u.name}: saved current box edits in ${before.commit.slice(0, 8)}`)
  const ids = spawnSync('id', ['-u', u.user], { encoding: 'utf-8' }).stdout.trim()
  const gid = spawnSync('id', ['-g', u.user], { encoding: 'utf-8' }).stdout.trim()
  const files = store.restore(rev, u, Number(ids) || 0, Number(gid) || 0)
  if (files.length === 0) {
    out.ok(`${u.name}: files already match ${rev.slice(0, 8)}`)
    return EXIT.OK
  }
  const after = snapshotUnit(store, u, `rollback to ${rev.slice(0, 8)}`)
  out.ok(`${u.name}: restored ${files.length} file(s) from ${rev.slice(0, 8)}: ${files.join(', ')}`)
  if (after.commit) out.info(`     history: ${after.commit.slice(0, 8)}`)
  if (!up(u, out)) return EXIT.FAIL
  out.ok(`${u.name}: containers updated`)
  return out.code()
}
