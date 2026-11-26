// Reference resolution for `stack:` and plugin names.
// A bare name resolves in the fleet repo only. Built-ins are always `airstack/<name>`.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_PLUGINS_DIR, BUILTIN_STACKS_DIR } from '../core.js'
import type { PluginRef } from './types.js'
import { BUILTIN_PREFIX } from './util.js'

export function resolveStackRef(root: string, ref: string):
  | { ok: true; source: 'fleet' | 'builtin'; dir: string; file: string }
  | { ok: false; message: string } {
  const r = parseRef(ref)
  if (!r.ok) return r
  if (r.source === 'builtin') {
    const dir = join(BUILTIN_STACKS_DIR, r.name)
    const file = join(dir, 'stack.yaml')
    return existsSync(file) ? { ok: true, source: 'builtin', dir, file } : { ok: false, message: `no built-in stack '${ref}'` }
  }
  const dir = join(root, 'stacks', r.name)
  const file = join(dir, 'stack.yaml')
  if (existsSync(file)) return { ok: true, source: 'fleet', dir, file }
  const hint = existsSync(join(BUILTIN_STACKS_DIR, r.name, 'stack.yaml')) ? ` -> did you mean ${BUILTIN_PREFIX}${r.name}?` : ''
  return { ok: false, message: `stack '${ref}' not found at stacks/${r.name}/stack.yaml${hint}` }
}

export function resolvePluginRef(root: string, ref: string): PluginRef {
  const r = parseRef(ref)
  if (!r.ok) return { ok: false, ref, message: r.message }
  if (r.source === 'builtin') {
    const path = join(BUILTIN_PLUGINS_DIR, r.name, 'index.ts')
    return existsSync(path)
      ? { ok: true, ref, name: r.name, source: 'builtin', path }
      : { ok: false, ref, message: `no built-in plugin '${ref}'` }
  }
  const path = join(root, 'plugins', r.name, 'index.ts')
  if (existsSync(path)) return { ok: true, ref, name: r.name, source: 'fleet', path }
  const hint = existsSync(join(BUILTIN_PLUGINS_DIR, r.name, 'index.ts')) ? ` -> did you mean ${BUILTIN_PREFIX}${r.name}?` : ''
  return { ok: false, ref, message: `plugin '${ref}' not found at plugins/${r.name}/index.ts${hint}` }
}

function parseRef(ref: string): { ok: true; source: 'fleet' | 'builtin'; name: string } | { ok: false; message: string } {
  if (ref.includes('@')) return { ok: false, message: `'${ref}': versioned references are not supported yet` }
  if (ref.startsWith(BUILTIN_PREFIX)) {
    const name = ref.slice(BUILTIN_PREFIX.length)
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return { ok: false, message: `'${ref}': invalid built-in name` }
    return { ok: true, source: 'builtin', name }
  }
  if (ref.includes('/')) return { ok: false, message: `'${ref}': marketplace references are not supported yet` }
  if (!/^[a-z][a-z0-9_-]*$/.test(ref)) return { ok: false, message: `'${ref}': invalid name` }
  return { ok: true, source: 'fleet', name: ref }
}
