/**
 * fleet-check.ts — checks that need plugin code loaded (scopes), on top of loadMachine's
 * static checks. Fleet plugins are trusted code: loading them runs their module top level.
 */

import { pathToFileURL } from 'node:url'
import { dirname, relative } from 'node:path'
import type { Plugin, PluginScope } from '../types.js'
import { registerPluginApi } from '../plugin-api.js'
import { BUILTIN_PLUGINS } from '../plugins/builtin.js'
import { resolvePluginRef, type Fleet, type Issue, type Machine } from './fleet.js'

export interface LoadedPlugin {
  ref: string
  source: 'fleet' | 'builtin'
  plugin: Plugin
  scope: PluginScope
}

/** Import a plugin by reference and call register(config). Throws with a clear message. */
export async function loadPluginRef(root: string, ref: string, config: unknown): Promise<LoadedPlugin> {
  const r = resolvePluginRef(root, ref)
  if (!r.ok) throw new Error(r.message)
  registerPluginApi()
  const mod = r.source === 'builtin' && BUILTIN_PLUGINS[r.name] ? BUILTIN_PLUGINS[r.name] : await import(pathToFileURL(r.path).href)
  if (typeof mod.register !== 'function') throw new Error(`${ref}: ${relative(root, r.path)} does not export register()`)
  const plugin = mod.register(config) as Plugin
  plugin.name = r.name
  plugin.sourceDir = dirname(r.path)
  return { ref, source: r.source, plugin, scope: plugin.scope ?? 'any' }
}

/** Scope violations and plugin load errors for one machine. */
export async function checkPluginScopes(fleet: Fleet, machine: Machine): Promise<Issue[]> {
  const issues: Issue[] = []
  const mFile = relative(fleet.root, machine.file)
  const check = async (ref: string, config: unknown, where: 'machine' | 'stack', key: string) => {
    if (!resolvePluginRef(fleet.root, ref).ok) return // already reported by loadMachine
    try {
      const lp = await loadPluginRef(fleet.root, ref, config)
      if (lp.plugin.scope === undefined && lp.source === 'fleet') {
        issues.push({ level: 'warn', file: mFile, key, message: `${ref} declares no scope, so airstack treats it as 'any'. Add scope: 'machine' | 'stack' | 'any'` })
      }
      if (lp.scope !== 'any' && lp.scope !== where) {
        issues.push({
          level: 'fail', file: mFile, key,
          message: `${ref} is a ${lp.scope}-level plugin and cannot be configured on a ${where}`,
        })
      }
    } catch (e) {
      issues.push({ level: 'fail', file: mFile, key, message: `cannot load ${ref}: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  for (const [ref, cfg] of Object.entries(machine.plugins)) await check(ref, cfg, 'machine', `plugins.${ref}`)
  for (const inst of machine.instances) {
    const plugins = (inst.config.plugins ?? {}) as Record<string, unknown>
    for (const [ref, cfg] of Object.entries(plugins)) await check(ref, cfg, 'stack', `stacks.${inst.name}.plugins.${ref}`)
  }
  return issues
}
