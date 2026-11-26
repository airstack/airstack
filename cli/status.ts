#!/usr/bin/env bun
/**
 * status.ts — Health check for running stack.
 *
 * Usage:
 *   stack-cli status
 */

import { resolve } from 'node:path'
import { loadConfig } from './lib/config.js'
import { createRemoteExecutor, sshConfigFromHost } from './lib/ssh.js'

const args = process.argv.slice(2)
if (args[0] === '--help' || args[0] === '-h') {
  console.log(`Usage: stack-cli status\n\nShows container status and basic health info.`)
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
const projectName = config.stack.projectName

const pass = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
const fail = (msg: string) => console.log(`  \x1b[31m✗\x1b[0m ${msg}`)
const log = (msg: string) => console.log(msg)

log(`\n\x1b[1mStack Status: ${projectName}\x1b[0m`)
log(`VPS: ${ssh.user}@${ssh.host}:${ssh.port}\n`)

// Check VPS reachability
const ping = await remote.run('echo ok')
if (ping.exitCode !== 0) {
  fail(`VPS unreachable: ${ping.stderr.trim()}`)
  process.exit(1)
}
pass('VPS reachable')

// Container status
log('\nContainers:')
const ps = await remote.run(
  `sudo docker ps --format '{{.Names}}\\t{{.Status}}' --filter 'name=${projectName}-' 2>/dev/null`
)
if (ps.stdout.trim()) {
  for (const line of ps.stdout.trim().split('\n')) {
    const [name, ...statusParts] = line.split('\t')
    const status = statusParts.join('\t')
    const healthy = status.includes('healthy') || status.includes('Up')
    if (healthy) {
      pass(`${name}: ${status}`)
    } else {
      fail(`${name}: ${status}`)
    }
  }
} else {
  fail('No containers found')
}

// Cron files
log('\nCrons:')
const crons = await remote.run(`ls /etc/cron.d/${projectName}_* 2>/dev/null | wc -l`)
const cronCount = parseInt(crons.stdout.trim(), 10)
if (cronCount > 0) {
  pass(`${cronCount} cron file(s) in /etc/cron.d/`)
} else {
  fail('No cron files found')
}

// Timezone
const tz = await remote.run(
  'timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null'
)
log(`\nTimezone: ${tz.stdout.trim()}`)
log('')
