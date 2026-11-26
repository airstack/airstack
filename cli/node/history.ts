/**
 * history.ts (node) — snapshots, deploy records and the drift guard on top of the store.
 *
 * Drift guard (before deploy writes a unit). For each file deploy will write:
 *   live == incoming          nothing to lose
 *   live == last deploy       no box edit: overwrite
 *   live == pulled base       the controller saw this box edit (`airstack pull`): overwrite
 *   otherwise                 CONFLICT: deploy would lose a box edit nobody pulled
 * Hashes are git blob ids, so the controller can compute them without git.
 */

import { createHash } from 'node:crypto'
import type { Managed } from '../lib/managed.js'
import { Store } from './store.js'
import { readUnitManaged, type NodeUnit } from './units.js'

export function blobId(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

export interface SnapshotResult {
  unit: string
  commit?: string
  changed: string[]
  /** No managed.json: the unit was never deployed by an airstack with config history. */
  untracked?: boolean
}

export function snapshotUnit(store: Store, unit: NodeUnit, why = 'box edit', managed: Managed | undefined = readUnitManaged(unit)): SnapshotResult {
  if (!managed) return { unit: unit.name, changed: [], untracked: true }
  store.ensure()
  const first = !store.git(['ls-tree', '-d', 'HEAD', '--', unit.slot]).out.trim()
  store.syncSlot(unit, managed)
  const changed = store.changed(unit.slot)
  if (changed.length === 0) return { unit: unit.name, changed }
  const label = first ? 'first snapshot' : why
  const commit = store.commit(`${label}: ${unit.name}: ${summarize(changed)}`, [unit.slot])
  return { unit: unit.name, commit, changed }
}

/** After deploy synced a unit: record the new files and mark them as deployed. */
export function recordDeploy(store: Store, unit: NodeUnit, fleetCommit = 'unknown'): SnapshotResult {
  const managed = readUnitManaged(unit)
  if (!managed) return { unit: unit.name, changed: [], untracked: true }
  store.ensure()
  store.syncSlot(unit, managed)
  const changed = store.changed(unit.slot)
  const commit = changed.length ? store.commit(`deploy ${unit.name} (fleet ${fleetCommit}): ${summarize(changed)}`, [unit.slot]) : undefined
  store.markDeployed(unit.slot, commit ?? store.head())
  return { unit: unit.name, commit, changed }
}

export interface DriftResult {
  unit: string
  /** Box edits found and committed now (before the check). */
  boxEdits: string[]
  conflicts: string[]
  /** HEAD after the snapshot: the controller stores it as its base after a pull. */
  head?: string
}

export function checkDrift(store: Store, unit: NodeUnit, incoming: Record<string, string>, base?: string): DriftResult {
  const snap = snapshotUnit(store, unit, 'box edit (found before deploy)')
  if (snap.untracked) return { unit: unit.name, boxEdits: [], conflicts: [] }
  const deployed = store.lastDeployed(unit.slot)
  const pulled = base ? store.resolve(base) : undefined
  const conflicts: string[] = []
  for (const [rel, want] of Object.entries(incoming)) {
    const path = `${unit.slot}/${rel}`
    const live = store.blobAt('HEAD', path)
    if (!live || live === want) continue
    if (!deployed || store.blobAt(deployed, path) === live) continue
    if (pulled && store.blobAt(pulled, path) === live) continue
    conflicts.push(rel)
  }
  return { unit: unit.name, boxEdits: snap.changed, conflicts: conflicts.sort(), head: store.head() }
}

function summarize(files: string[]): string {
  return files.length <= 3 ? files.join(', ') : `${files.slice(0, 3).join(', ')} +${files.length - 3} more`
}
