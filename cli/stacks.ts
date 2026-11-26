#!/usr/bin/env bun
/**
 * stacks.ts — List and manage stacks on VPS.
 *
 * Usage:
 *   stack-cli stacks              # List all registered stacks
 *   stack-cli stacks deactivate   # Interactive: select stack to deactivate
 *   stack-cli stacks deactivate <name>
 */

import { resolve } from 'node:path'
import { loadConfig } from './lib/config.js'
import { createRemoteExecutor, sshConfigFromHost } from './lib/ssh.js'

const args = process.argv.slice(2)
const command = args[0] || 'list'

if (command === '--help' || command === '-h') {
  console.log(`Usage: stack-cli stacks [command]

Commands:
  list                    List all registered stacks (default)
  deactivate <name>       Deactivate a specific stack
  deactivate --all        Deactivate all stacks except current`)
  process.exit(0)
}

const projectRoot = resolve(process.cwd())
const config = loadConfig(projectRoot)

if (!config.host.ip) {
  console.error('No VPS configured (host.ip or SSH_IP not set)')
  process.exit(1)
}

const ssh = sshConfigFromHost(config.host)
const remote = createRemoteExecutor(ssh)
const currentProject = config.stack.projectName
const manifestDir = String((config.stack as any).manifestDir || '/etc/stacks')

interface StackManifest {
  projectName: string
  installDir: string
  filename: string
}

async function listManifests(): Promise<StackManifest[]> {
  const ls = await remote.run(`sudo ls ${manifestDir}/*.env 2>/dev/null || true`)
  const files = ls.stdout.trim().split('\n').filter(Boolean)
  const stacks: StackManifest[] = []

  for (const file of files) {
    const cat = await remote.run(`sudo cat ${file}`)
    if (cat.exitCode !== 0) continue
    const vars: Record<string, string> = {}
    for (const line of cat.stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    if (vars.PROJECT_NAME) {
      stacks.push({
        projectName: vars.PROJECT_NAME,
        installDir: vars.INSTALL_DIR || '',
        filename: file,
      })
    }
  }
  return stacks
}

if (command === 'list' || command === '') {
  const stacks = await listManifests()
  const running = await remote.run("sudo docker ps --format '{{.Names}}' 2>/dev/null")
  const runningNames = running.stdout.trim().split('\n').filter(Boolean)

  if (stacks.length === 0) {
    console.log(`No stacks registered in ${manifestDir}/`)
    process.exit(0)
  }

  console.log(`\n\x1b[36mRegistered Stacks\x1b[0m\n`)
  for (const s of stacks) {
    const isCurrent = s.projectName === currentProject
    const anyRunning = runningNames.some((n) => n.startsWith(s.projectName + '-'))
    const icon = anyRunning ? '\x1b[32m●\x1b[0m' : '\x1b[31m○\x1b[0m'
    const label = isCurrent ? ' \x1b[33m(current)\x1b[0m' : ''
    console.log(`  ${icon} ${s.projectName}${label}`)
    console.log(`    Install: ${s.installDir}`)
    console.log(`    Status:  ${anyRunning ? 'running' : 'stopped'}`)
    console.log('')
  }
} else if (command === 'deactivate') {
  const targetName = args.find((a, i) => i > 0 && !a.startsWith('--'))
  const all = args.includes('--all')
  const stacks = await listManifests()
  const others = stacks.filter((s) => s.projectName !== currentProject)

  if (others.length === 0) {
    console.log('No other stacks to deactivate.')
    process.exit(0)
  }

  const targets = all ? others : others.filter((s) => !targetName || s.projectName === targetName)
  if (targets.length === 0) {
    console.error(`Stack "${targetName}" not found.`)
    process.exit(1)
  }

  const { appUser } = config.host
  for (const target of targets) {
    // Validate paths before using in shell commands
    if (!/^[a-zA-Z0-9_\-]+$/.test(target.projectName)) {
      console.error(`Skipping: suspicious project name '${target.projectName}'`)
      continue
    }
    if (!/^\/etc\/stacks\/[a-zA-Z0-9_.\-]+\.env$/.test(target.filename)) {
      console.error(`Skipping: suspicious manifest path '${target.filename}'`)
      continue
    }
    console.log(`\x1b[33mDeactivating: ${target.projectName}\x1b[0m`)
    await remote.run(
      `sudo -u ${appUser} bash -c 'cd ${target.installDir} && docker compose -p ${target.projectName} down' 2>&1 || true`
    )
    await remote.run(`sudo rm -f /etc/cron.d/${target.projectName}_* 2>/dev/null || true`)
    await remote.run(`sudo rm -f /etc/logrotate.d/${target.projectName} 2>/dev/null || true`)
    await remote.run(`sudo rm -f '${target.filename}'`)
    console.log(`  \x1b[32m✓ ${target.projectName} deactivated\x1b[0m`)
    console.log(`    Install dir preserved: ${target.installDir}`)
  }
} else {
  console.error(`Unknown command: ${command}. Run: stack-cli stacks --help`)
  process.exit(1)
}
