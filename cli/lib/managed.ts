/**
 * managed.ts — which files of a unit airstack manages. Deploy writes this list into every staged
 * unit (.stack-config/managed.json), so the node knows the files without the fleet repo.
 *
 * File modes:
 *   rendered  every file deploy ships. Deploy overwrites it. An edit on the machine is "drift".
 *   tracked   box-owned config that a plugin names (e.g. cliproxy's .cliproxyapi/config.yaml).
 *             Deploy never writes it, but history, pull, `config read` and rollback cover it.
 *   state     everything else (auth files, data, logs). airstack never tracks it.
 */

import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { RedactRule } from './redact/index.js'

export const MANAGED_FILE = '.stack-config/managed.json'

export interface Managed {
  format: 1
  unit: string
  kind: 'machine' | 'stack'
  /** Fleet repo commit the files came from (with "-dirty" for uncommitted changes), if known. */
  fleetCommit?: string
  deployedAt: string
  rendered: string[]
  tracked: string[]
  /** Redaction rules of the unit's plugins (the machine has no fleet repo). */
  redact: RedactRule[]
}

export type ManagedInput = Omit<Managed, 'format' | 'rendered' | 'redact'> & { rendered?: string[]; redact?: RedactRule[] }

/** Paths that are never content: deploy bookkeeping rewritten on every run. */
const NOT_CONTENT = new Set([MANAGED_FILE])

/** All files under dir, relative, sorted (symlinks count as files). */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name)
      if (e.isDirectory()) walk(full)
      else out.push(relative(dir, full))
    }
  }
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir)
  return out.filter((f) => !NOT_CONTENT.has(f)).sort()
}

export function writeManaged(deployDir: string, m: ManagedInput): Managed {
  const doc: Managed = {
    format: 1,
    ...m,
    rendered: m.rendered ?? listFiles(deployDir),
    tracked: [...new Set(m.tracked)].sort(),
    redact: m.redact ?? [],
  }
  const file = join(deployDir, MANAGED_FILE)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  return doc
}

export function parseManaged(text: string): Managed | undefined {
  try {
    const d = JSON.parse(text) as Managed
    if (d.format !== 1 || !Array.isArray(d.rendered) || !Array.isArray(d.tracked)) return undefined
    return { ...d, redact: Array.isArray(d.redact) ? d.redact : [] }
  } catch {
    return undefined
  }
}

/** A relative path that stays inside its unit dir. */
export function safeRelPath(p: string): boolean {
  return !!p && !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '') && !p.includes('\0')
}
