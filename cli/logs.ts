#!/usr/bin/env bun
/**
 * logs.ts — Stream Docker Compose logs from VPS.
 *
 * Usage:
 *   stack-cli logs                    # all containers, follow
 *   stack-cli logs 200                # last 200 lines, follow
 *   stack-cli logs --no-follow        # dump all and exit
 *   stack-cli logs <service>          # specific service
 *   stack-cli logs <svc1> <svc2>      # multiple services
 */

import { resolve } from 'node:path'
import { loadConfig } from './lib/config.js'

const args = process.argv.slice(2)

if (args[0] === '--help' || args[0] === '-h') {
  console.log(`Usage: stack-cli logs [options] [service...]

Options:
  <number>        Tail this many lines (default: 100)
  --no-follow     Dump logs and exit (don't follow)
  --all           Show all lines (no tail limit)

Examples:
  stack-cli logs                  # all containers, follow
  stack-cli logs 200              # last 200 lines
  stack-cli logs vector           # specific service
  stack-cli logs --no-follow      # dump all`)
  process.exit(0)
}

const projectRoot = resolve(process.cwd())
const config = loadConfig(projectRoot)

if (!config.host.ip) {
  console.error('No VPS configured (host.ip or SSH_IP not set)')
  process.exit(1)
}

const { installDir, projectName } = config.stack
const { appUser, ip, sshUser, sshPort, sshKey } = config.host
const expandedKey = sshKey.replace(/^~/, process.env.HOME || '')

// Parse args
let follow = true
let tail = '100'
const containers: string[] = []

for (const arg of args) {
  if (arg === '--no-follow') {
    follow = false
  } else if (arg === '--all') {
    tail = 'all'
  } else if (/^\d+$/.test(arg)) {
    tail = arg
  } else if (!arg.startsWith('-')) {
    containers.push(arg)
  }
}

// Auto-prefix container names with project name if needed
if (containers.length > 0) {
  const sshCmd = [
    'ssh', '-i', expandedKey, '-p', String(sshPort),
    '-o', 'StrictHostKeyChecking=accept-new',
    `${sshUser}@${ip}`,
    `sudo -u ${appUser} bash -c 'cd ${installDir} && docker compose ps --format {{.Name}}'`,
  ]
  const ps = Bun.spawnSync(sshCmd, { stdout: 'pipe', stderr: 'pipe' })
  const serviceNames = new Set(
    new TextDecoder().decode(ps.stdout).split('\n').map(s => s.trim()).filter(Boolean)
  )

  for (let i = 0; i < containers.length; i++) {
    const name = containers[i]
    if (serviceNames.has(name)) continue
    const prefixed = `${projectName}-${name}`
    if (serviceNames.has(prefixed)) {
      containers[i] = prefixed
    } else {
      console.warn(`\x1b[33mWarning: '${name}' not found in compose services (tried '${prefixed}' too)\x1b[0m`)
    }
  }
}

const composeArgs = ['logs']
if (follow) composeArgs.push('--tail', tail, '-f')
else if (tail !== 'all') composeArgs.push('--tail', tail)
if (containers.length > 0) composeArgs.push(...containers.map(c => `'${c.replace(/'/g, "'\\''")}'`))

console.log(
  `\x1b[32mStreaming logs from ${
    containers.length > 0 ? containers.join(', ') : 'all containers'
  } on VPS (${ip})\x1b[0m`
)

const sshBase = [
  'ssh',
  '-i',
  expandedKey,
  '-p',
  String(sshPort),
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-t',
  `${sshUser}@${ip}`,
]

const proc = Bun.spawn(
  [
    ...sshBase,
    `sudo -u ${appUser} bash -c 'cd ${installDir} && docker compose ${composeArgs.join(' ')}'`,
  ],
  {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  }
)
const code = await proc.exited
process.exit(code === 130 ? 0 : code)
