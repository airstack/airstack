/**
 * marker.ts — /etc/airstack/machine.yaml on a node: written by deploy (root:root 644), read back
 * to find instances that were removed from the machine file (orphans).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as yaml from 'js-yaml'
import type { RemoteExecutor } from '../types.js'
import type { Fleet, Machine } from './fleet.js'

export const MARKER_PATH = '/etc/airstack/machine.yaml'

export interface MarkerStack {
  installDir: string
  user: string
  userKind: 'stack' | 'dev'
  composeProject: string
}

/** `orphans`: instances removed from the machine file but not pruned yet (kept listed so later deploys still see them). */
export function markerYaml(fleet: Fleet, machine: Machine, version: string, orphans: Record<string, MarkerStack> = {}): string {
  const stacks: Record<string, MarkerStack & { orphan?: boolean }> = {}
  for (const i of machine.instances) {
    stacks[i.name] = { installDir: i.installDir, user: i.user, userKind: i.userKind, composeProject: i.composeProject }
  }
  for (const [n, s] of Object.entries(orphans)) stacks[n] = { ...s, orphan: true }
  const doc = {
    machine: machine.name,
    fleet: fleet.name,
    roles: ['node'],
    paths: { root: machine.root, stackUser: machine.host.users.stack, adminGroup: 'airstack-admin' },
    stacks,
    update: { source: 'controller', allowSourceUpdate: false },
    airstack: { version },
  }
  return `# Written by airstack deploy. The only global marker for this node. Root-owned on purpose.\n${yaml.dump(doc, { lineWidth: 120 })}`
}

export async function readMarker(remote: RemoteExecutor): Promise<{ exists: boolean; stacks: Record<string, MarkerStack> }> {
  const r = await remote.run(`sudo cat ${MARKER_PATH} 2>/dev/null`)
  if (r.exitCode !== 0 || !r.stdout.trim()) return { exists: false, stacks: {} }
  try {
    const doc = (yaml.load(r.stdout) ?? {}) as { stacks?: Record<string, MarkerStack> }
    return { exists: true, stacks: doc.stacks ?? {} }
  } catch {
    return { exists: true, stacks: {} }
  }
}

/** Upload via rsync to a temp path, then install root:root 0644 (no heredoc, no shell quoting of content). */
export async function writeMarker(remote: RemoteExecutor, content: string): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'airstack-marker-'))
  const local = join(dir, 'machine.yaml')
  writeFileSync(local, content, { mode: 0o644 })
  const tmpRemote = `/tmp/airstack-marker-${process.pid}-${Date.now()}.yaml`
  try {
    const up = await remote.rsync(local, tmpRemote)
    if (up.exitCode !== 0) return false
    const r = await remote.run(
      `sudo install -d -o root -g root -m 0755 /etc/airstack && sudo install -o root -g root -m 0644 ${tmpRemote} ${MARKER_PATH}; rc=$?; sudo rm -f ${tmpRemote}; exit $rc`,
    )
    return r.exitCode === 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
