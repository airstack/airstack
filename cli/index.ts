#!/usr/bin/env bun
/**
 * Stack CLI v2 — unified entry point for all stack management commands.
 *
 * Usage: stack-cli <command> [args...]
 */

import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'

const repoRoot = resolve(import.meta.dirname, '..')

// Parse --stack <name> from full argv (can appear before or after command)
const allArgs = process.argv.slice(2)
let stackName: string | undefined
const filteredArgs: string[] = []
for (let i = 0; i < allArgs.length; i++) {
  if (allArgs[i] === '--stack' && i + 1 < allArgs.length) {
    stackName = allArgs[i + 1]
    i++
  } else {
    filteredArgs.push(allArgs[i])
  }
}

// Validate stack directory
const stackCwd = (() => {
  if (stackName === undefined) return undefined
  const stackDir = join(repoRoot, 'stacks', stackName)
  if (!existsSync(stackDir)) {
    console.error(`Stack not found: stacks/${stackName}/`)
    process.exit(1)
  }
  return stackDir
})()

const command = filteredArgs[0] || ''
const subArgs = filteredArgs.slice(1)

const COMMANDS: Record<string, { script: string; description: string }> = {
  deploy:   { script: 'deploy.ts',   description: 'Deploy stack to VPS' },
  status:   { script: 'status.ts',   description: 'Health check — containers, services' },
  logs:     { script: 'logs.ts',     description: 'Stream Docker logs' },
  ssh:      { script: 'ssh.ts',      description: 'SSH into VPS' },
  stacks:   { script: 'stacks.ts',   description: 'List and manage stacks on VPS' },
  env:      { script: 'env.ts',      description: 'Show resolved config for debugging' },
  'vps-setup': { script: 'vps-setup.ts', description: 'Provision VPS (base, harden, docker, verify)' },
}

if (!command || command === '--help' || command === '-h') {
  console.log(`
\x1b[1mStack CLI v2\x1b[0m

Usage: stack-cli [--stack <name>] <command> [args...]

\x1b[36mGlobal Options:\x1b[0m

  --stack <name>   Run command in the context of stacks/<name>/

\x1b[36mCommands:\x1b[0m
`)
  const maxLen = Math.max(...Object.keys(COMMANDS).map(k => k.length))
  for (const [name, { description }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(maxLen + 2)} ${description}`)
  }
  // Show plugin commands if config is loadable
  try {
    const { loadConfig } = await import('./lib/config.js')
    const { loadPlugins } = await import('./lib/plugin-loader.js')
    const { getSharedPaths } = await import('./lib/resolve-file.js')
    const projectRoot = resolve(stackCwd || process.cwd())
    const config = loadConfig(projectRoot)
    const plugins = await loadPlugins(config.plugins, projectRoot, getSharedPaths())
    const pluginCmds: [string, string][] = []
    for (const plugin of plugins) {
      if (plugin.commands) {
        for (const [name, cmd] of Object.entries(plugin.commands)) {
          pluginCmds.push([name, cmd.description])
        }
      }
    }
    if (pluginCmds.length > 0) {
      console.log(`\n\x1b[36mPlugin Commands:\x1b[0m\n`)
      const maxPluginLen = Math.max(...pluginCmds.map(([k]) => k.length))
      for (const [name, desc] of pluginCmds) {
        console.log(`  ${name.padEnd(maxPluginLen + 2)} ${desc}`)
      }
    }
  } catch {
    // Config not loadable — skip plugin commands in help
  }

  console.log(`
Run \x1b[33mstack-cli <command> --help\x1b[0m for command-specific usage.
`)
  process.exit(0)
}

const cmd = COMMANDS[command]

if (cmd) {
  // Built-in command — spawn subprocess
  const scriptPath = new URL(cmd.script, import.meta.url).pathname
  const spawnEnv = stackName !== undefined
    ? { ...process.env, STACK_CLI_SHARED_PATH: repoRoot }
    : process.env

  const proc = Bun.spawn(['bun', scriptPath, ...subArgs], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
    cwd: stackCwd,
    env: spawnEnv,
  })
  const code = await proc.exited
  process.exit(code === 130 ? 0 : code)
} else {
  // Try plugin commands
  const { loadConfig } = await import('./lib/config.js')
  const { loadPlugins } = await import('./lib/plugin-loader.js')
  const { getSharedPaths } = await import('./lib/resolve-file.js')
  const { createRemoteExecutor, sshConfigFromHost } = await import('./lib/ssh.js')
  const { updateConfig: _updateConfig } = await import('./lib/config-writer.js')

  const projectRoot = resolve(stackCwd || process.cwd())
  // Ensure STACK_CLI_SHARED_PATH is set for plugin commands (same as built-in commands)
  if (stackName !== undefined) process.env.STACK_CLI_SHARED_PATH = repoRoot
  const sharedPaths = getSharedPaths()

  try {
    const config = loadConfig(projectRoot)
    const plugins = await loadPlugins(config.plugins, projectRoot, sharedPaths)

    for (const plugin of plugins) {
      const pluginCmd = plugin.commands?.[command]
      if (pluginCmd) {
        const ssh = sshConfigFromHost(config.host)
        const remote = ssh.host ? createRemoteExecutor(ssh) : undefined
        const log = { error: console.error, warn: console.warn, info: console.log, debug: () => {} }
        const updateConfig = (dotPath: string, value: string) => _updateConfig(projectRoot, config, dotPath, value)
        await pluginCmd.run(subArgs, { config, ssh, remote, log, projectRoot, sharedPaths, updateConfig })
        process.exit(0)
      }
    }
  } catch (e: any) {
    // Config load failed — can't check plugins
  }

  console.error(`Unknown command: ${command}`)
  console.error(`Run stack-cli --help for available commands.`)
  process.exit(1)
}
