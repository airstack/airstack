/**
 * store.ts (node) — config history: a git repo at <root>/.stack (root only, mode 700).
 *
 * The work tree mirrors the managed files of every unit:
 *   .stack/machine/…          the machine unit (<root>/machine)
 *   .stack/stacks/<name>/…    each stack instance (its install dir)
 * It holds the exact live files, secrets included. That is why only root can read it. It is the
 * only change history: box edits, deploys, diffs and rollbacks all use it.
 *
 * Refs:
 *   main                               every snapshot ("box edit …", "deploy …", "rollback …")
 *   refs/airstack/deployed/<slot>      the commit of the last deploy of a unit
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, chownSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listFiles, safeRelPath, type Managed } from '../lib/managed.js'
import type { NodeUnit } from './units.js'

const IDENT = ['-c', 'user.name=airstack', '-c', 'user.email=airstack@localhost', '-c', 'core.quotePath=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false']
// The store ignores the global and system git config: hooks, signing or aliases there must not
// break (or change) snapshots.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

export interface LogEntry {
  sha: string
  date: string
  subject: string
}

export class Store {
  readonly dir: string

  constructor(root: string) {
    this.dir = join(root, '.stack')
  }

  git(args: string[], input?: string): { out: string; err: string; code: number } {
    const r = spawnSync('git', [...IDENT, '-C', this.dir, ...args], { encoding: 'utf-8', input, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 })
    return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 }
  }

  exists(): boolean {
    return existsSync(join(this.dir, '.git'))
  }

  ensure(): void {
    if (this.exists()) return
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.dir, 0o700)
    const r = this.git(['init', '-q', '-b', 'main'])
    if (r.code !== 0) throw new Error(`cannot create the history store: ${r.err.trim()}`)
    writeFileSync(join(this.dir, 'README'), 'airstack config history. Root only: it holds live files with secrets.\n')
    this.git(['add', 'README'])
    this.git(['commit', '-q', '-m', 'start config history'])
  }

  /** Make the unit's slot match the live managed files (rendered + tracked that exist). */
  syncSlot(unit: NodeUnit, managed: Managed): void {
    const slot = join(this.dir, unit.slot)
    rmSync(slot, { recursive: true, force: true })
    for (const rel of [...managed.rendered, ...managed.tracked]) {
      if (!safeRelPath(rel)) continue
      const src = join(unit.dir, rel)
      if (!existsSync(src) || !lstatSync(src).isFile()) continue
      const dst = join(slot, rel)
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(src, dst)
      chmodSync(dst, statSync(src).mode & 0o100 ? 0o700 : 0o600)
    }
  }

  /** Commit everything that changed under the given slots. Returns the new commit, or undefined. */
  commit(message: string, slots: string[]): string | undefined {
    this.git(['add', '-A', '--', ...slots])
    const st = this.git(['diff', '--cached', '--quiet'])
    if (st.code === 0) return undefined
    const r = this.git(['commit', '-q', '-m', message])
    if (r.code !== 0) throw new Error(`commit failed: ${r.err.trim()}`)
    return this.head()
  }

  /** Files that differ between HEAD and the work tree under a slot (after syncSlot). */
  changed(slot: string): string[] {
    this.git(['add', '-A', '--', slot])
    const r = this.git(['diff', '--cached', '--name-only', '--', slot])
    this.git(['reset', '-q', '--', slot])
    return r.out.split('\n').filter(Boolean).map((p) => p.slice(slot.length + 1))
  }

  head(): string {
    return this.git(['rev-parse', 'HEAD']).out.trim()
  }

  resolve(rev: string): string | undefined {
    if (!/^[\w./^~@{}-]+$/.test(rev)) return undefined
    const r = this.git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    return r.code === 0 ? r.out.trim() : undefined
  }

  deployedRef(slot: string): string {
    return `refs/airstack/deployed/${slot.replace(/\//g, '_')}`
  }

  markDeployed(slot: string, sha: string): void {
    this.git(['update-ref', this.deployedRef(slot), sha])
  }

  lastDeployed(slot: string): string | undefined {
    return this.resolve(this.deployedRef(slot))
  }

  /** Content of slot/path at a commit, or undefined when it is not there. */
  fileAt(rev: string, path: string): Buffer | undefined {
    const r = spawnSync('git', ['-C', this.dir, 'show', `${rev}:${path}`], { env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 })
    return r.status === 0 ? r.stdout : undefined
  }

  /** git blob hash of a file at a commit (cheap content compare), or undefined. */
  blobAt(rev: string, path: string): string | undefined {
    const r = this.git(['rev-parse', '--verify', '--quiet', `${rev}:${path}`])
    return r.code === 0 ? r.out.trim() : undefined
  }

  log(paths: string[], limit = 20): LogEntry[] {
    const r = this.git(['log', `-n${limit}`, '--format=%H%x09%cI%x09%s', '--', ...paths])
    return r.out.split('\n').filter(Boolean).map((l) => {
      const [sha, date, ...s] = l.split('\t')
      return { sha, date, subject: s.join('\t') }
    })
  }

  /** Unified diff; with `relative`, paths in the diff are relative to that slot. */
  diff(from: string | undefined, to: string | undefined, paths: string[], relative?: string): string {
    const args = ['diff', '--no-color', '--no-ext-diff', ...(relative ? [`--relative=${relative}/`] : [])]
    if (from) args.push(from)
    if (to) args.push(to)
    return this.git([...args, '--', ...paths]).out
  }

  /**
   * Write the unit's files from a commit back to the live dir. Existing files keep their owner
   * and mode; new files belong to the unit's run user, mode 600. Returns the restored paths.
   */
  restore(rev: string, unit: NodeUnit, uid: number, gid: number): string[] {
    const r = this.git(['ls-tree', '-r', '--name-only', rev, '--', unit.slot])
    const done: string[] = []
    for (const path of r.out.split('\n').filter(Boolean)) {
      const rel = path.slice(unit.slot.length + 1)
      if (!safeRelPath(rel)) continue
      const data = this.fileAt(rev, path)
      if (!data) continue
      const live = join(unit.dir, rel)
      if (existsSync(live) && readFileSync(live).equals(data)) continue
      const isNew = !existsSync(live)
      mkdirSync(dirname(live), { recursive: true })
      writeFileSync(live, data)
      if (isNew) {
        chmodSync(live, 0o600)
        try { chownSync(live, uid, gid) } catch { /* not root: leave the owner */ }
      }
      done.push(rel)
    }
    return done
  }

  /** Every file in a slot at HEAD (for tests and listings). */
  slotFiles(slot: string): string[] {
    return listFiles(join(this.dir, slot))
  }
}
