// Shared constants and small helpers for the fleet loader.

import { relative } from 'node:path'

export const BUILTIN_PREFIX = 'airstack/'
/** Machine root when the machine file sets none (plans/phase-1.md: /srv is for data a host serves). */
export const DEFAULT_MACHINE_ROOT = '/srv/airstack'

export const NAME_RE = /^[a-z][a-z0-9-]*$/

export function rel(root: string, p: string): string {
  const r = relative(root, p)
  return r.startsWith('..') ? p : r
}

export function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e)
}
