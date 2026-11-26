#!/usr/bin/env bun
/**
 * env.ts — Show resolved config for debugging and agents.
 *
 * Usage:
 *   stack-cli env read <key>   # Read a specific config value by dot-path
 *   stack-cli env stack        # Show resolved stack.yml
 *   stack-cli env context      # Show the full enriched config
 */

import { resolve, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { loadConfig, resolvedStackYml } from './lib/config.js'

/**
 * Recursively sort an object: scalar values first (alphabetically),
 * then complex values (objects/arrays) alphabetically.
 */
function sortedForDisplay(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortedForDisplay)

  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
  const scalars = keys.filter((k) => obj[k] === null || typeof obj[k] !== 'object').sort()
  const complex = keys.filter((k) => obj[k] !== null && typeof obj[k] === 'object').sort()

  const result: Record<string, unknown> = {}
  for (const k of [...scalars, ...complex]) {
    result[k] = sortedForDisplay(obj[k])
  }
  return result
}

/**
 * Build the fully enriched context — same structure used by templates.
 * Loads config, runs pre-stage hooks, returns the context object.
 */
async function buildContext(projectRoot: string): Promise<Record<string, unknown>> {
  const config = loadConfig(projectRoot)
  const { loadPlugins } = await import('./lib/plugin-loader.js')
  const { getSharedPaths } = await import('./lib/resolve-file.js')
  const { updateConfig: _updateConfig } = await import('./lib/config-writer.js')

  const sharedPaths = getSharedPaths()
  const plugins = await loadPlugins(config.plugins, projectRoot, sharedPaths)
  const deployDir = join(projectRoot, config.deploy.stagingDir)
  mkdirSync(deployDir, { recursive: true })

  // Core manifest enrichment (same as 01a-pre-stage.ts)
  const { installDir, projectName } = config.stack
  const manifestDir = String((config.stack as any).manifestDir || '/etc/stacks')
  const manifest = {
    destination: `${manifestDir}/${projectName}.env`,
    entries: {
      PROJECT_NAME: projectName,
      INSTALL_DIR: installDir,
      CONFIG_DIR: `${installDir}/.stack-config`,
      STATE_DIR: `${installDir}/.stack-state`,
    } as Record<string, string>,
  }

  const nullLog = { error() {}, warn() {}, info() {}, debug() {} }
  const ctx = {
    phase: 'pre-stage' as const,
    projectRoot,
    sharedPaths,
    deployDir,
    config,
    ssh: {
      host: config.host.ip,
      port: config.host.sshPort,
      user: config.host.sshUser,
      keyPath: config.host.sshKey,
    },
    plugins,
    log: nullLog,
    errors: [] as any[],
    changes: [] as any[],
    phaseStatus: [] as any[],
    compose: { services: [], buildArgs: [], upArgs: [], profiles: [] },
    report: { data: {} },
    manifest,
    registeredFiles: { scripts: { dirs: ['plugins', 'crons'], exclude: [] }, hostFiles: [] },
    updateConfig(dotPath: string, value: string) {
      _updateConfig(projectRoot, config, dotPath, value)
    },
    force: false,
  }

  // Run pre-stage hooks to enrich config and populate manifest
  for (const plugin of plugins) {
    const hook = plugin.hooks?.['pre-stage']
    if (hook) {
      try {
        await hook(ctx as any, config.plugins[plugin.name])
      } catch {}
    }
  }

  return {
    host: config.host,
    stack: config.stack,
    plugins: config.plugins,
    deploy: config.deploy,
    manifest,
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const command = process.argv[2] || ''
const projectRoot = resolve(process.cwd())

if (command === '--help' || command === '-h' || !command) {
  console.log(`Usage: stack-cli env <command>

Commands:
  read <key>  Read a context config value by dot-path (e.g. host.ip, stack.installDir)
  stack       Show resolved stack.yml (with \${VAR} substitution)
  context     Show the full enriched config (same structure used in templates)`)
  process.exit(0)
}

if (command === 'stack') {
  const config = loadConfig(projectRoot)
  console.log(resolvedStackYml(projectRoot, config.stackConfig.envFile))
  process.exit(0)
}

if (command === 'read') {
  const key = process.argv[3]
  const fullContext = await buildContext(projectRoot)

  if (!key) {
    console.log(`Usage: stack-cli env read <key>

Reads a value from the enriched config using dot-path notation.
Uses the same structure as 'stack-cli env context'.

Top-level keys:`)
    for (const k of Object.keys(fullContext).sort()) {
      console.log(`  ${k}`)
    }
    console.log(`
Examples:
  stack-cli env read host.ip
  stack-cli env read stack.installDir
  stack-cli env read stack.cloudflared.tunnelToken
  stack-cli env read plugins.cloudflare.apiToken
  stack-cli env read manifest`)
    process.exit(0)
  }

  // Resolve dot-path
  const parts = key.split('.')
  let current: unknown = fullContext
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      console.error(`Key not found: ${key}`)
      process.exit(1)
    }
    current = (current as Record<string, unknown>)[part]
  }

  if (current === undefined) {
    console.error(`Key not found: ${key}`)
    process.exit(1)
  }

  if (typeof current === 'object' && current !== null) {
    console.log(yaml.dump(sortedForDisplay(current), { lineWidth: 120, noRefs: true }).trimEnd())
  } else {
    console.log(String(current))
  }
  process.exit(0)
}

if (command === 'context') {
  const fullContext = await buildContext(projectRoot)
  console.log(yaml.dump(sortedForDisplay(fullContext), { lineWidth: 120, noRefs: true }))
  process.exit(0)
}

console.error(`Unknown command: ${command}. Run: stack-cli env --help`)
process.exit(1)
