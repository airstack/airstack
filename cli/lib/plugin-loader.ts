/**
 * Plugin loader — discovers and registers built-in + project plugins.
 *
 * Plugins load in the order they appear in stack.yml plugins: section.
 * Each plugin is a directory with an index.ts that exports:
 *   register(pluginConfig: unknown): Plugin
 *
 * Discovery:
 *   1. Built-in: cli/plugins/{name}/index.ts
 *   2. Project: plugins/{name}/index.ts (resolved via resolveFile)
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Plugin } from '../types.js'

const BUILTIN_PLUGINS_DIR = resolve(import.meta.dirname, '..', 'plugins')

export interface PluginModule {
  register: (config: unknown) => Plugin
}

/**
 * Load all plugins declared in stack.yml plugins: section.
 * Returns plugins in declaration order.
 */
export async function loadPlugins(
  pluginsConfig: Record<string, unknown>,
  projectRoot: string,
  sharedPaths: string[],
): Promise<Plugin[]> {
  const plugins: Plugin[] = []

  for (const [name, config] of Object.entries(pluginsConfig)) {
    const plugin = await loadPlugin(name, config, projectRoot, sharedPaths)
    if (plugin) {
      plugins.push(plugin)
    }
  }

  return plugins
}

async function loadPlugin(
  name: string,
  config: unknown,
  projectRoot: string,
  sharedPaths: string[],
): Promise<Plugin | null> {
  // 1. Try built-in
  const builtinPath = join(BUILTIN_PLUGINS_DIR, name, 'index.ts')
  if (existsSync(builtinPath)) {
    return registerFromPath(builtinPath, name, config)
  }

  // 2. Try project-level (projectRoot then sharedPaths)
  const searchDirs = [projectRoot, ...sharedPaths]
  for (const dir of searchDirs) {
    const projectPath = join(dir, 'plugins', name, 'index.ts')
    if (existsSync(projectPath)) {
      return registerFromPath(projectPath, name, config)
    }
  }

  // Not found — warn and skip
  console.warn(`[plugin] Plugin '${name}' not found (checked built-in and project plugins)`)
  return null
}

async function registerFromPath(path: string, name: string, config: unknown): Promise<Plugin> {
  const mod = await import(path) as PluginModule
  if (typeof mod.register !== 'function') {
    throw new Error(`Plugin ${name} (${path}) does not export register()`)
  }
  const plugin = mod.register(config)
  // Ensure the plugin name matches the key
  plugin.name = name
  plugin.sourceDir = dirname(path)
  return plugin
}
