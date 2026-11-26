#!/usr/bin/env bun
/**
 * ssh.ts — SSH into the VPS or exec into a container.
 *
 * Usage:
 *   stack-cli ssh                     # Interactive SSH to VPS
 *   stack-cli ssh <container>         # Bash into a Docker container
 *   stack-cli ssh -c <command>        # Run command on VPS
 *
 * Honors host.sshExpose: 'tunnel' routes through cloudflared (Cloudflare Access).
 */

import { resolve } from 'node:path'
import { loadConfig } from './lib/config.js'
import { sshConfigFromHost, sshArgs, userHost } from './lib/ssh.js'

const args = process.argv.slice(2)

if (args[0] === '--help' || args[0] === '-h') {
  console.log(`Usage: stack-cli ssh [container | -c command]

Modes:
  stack-cli ssh                     Interactive SSH session to VPS
  stack-cli ssh <container>         Bash into a Docker container on VPS
  stack-cli ssh -c <command>        Run a command on VPS and exit

Container names are auto-prefixed with the project name if needed.

Examples:
  stack-cli ssh                     # SSH to VPS
  stack-cli ssh cloudflared         # exec into the cloudflared container
  stack-cli ssh -c 'docker ps'      # run command on VPS`)
  process.exit(0)
}

const projectRoot = resolve(process.cwd())
const config = loadConfig(projectRoot)

const ssh = sshConfigFromHost(config.host)
const viaTunnel = ssh.viaTunnel === true

if (!config.host.ip && !(viaTunnel && ssh.tunnelHostname)) {
  console.error('No VPS configured (set host.ip / SSH_IP, or host.sshTunnelHostname for tunnel mode)')
  process.exit(1)
}

const sshTarget = userHost(ssh)
// Interactive sessions: don't force BatchMode so key/agent prompts still work in direct mode.
const sshOpts = ['ssh', ...sshArgs(ssh, { batchMode: false })]
const spawnEnv = { ...process.env, TERM: 'xterm-256color' }

// Mode 2: exec command on VPS (-c flag)
const cIdx = args.indexOf('-c')
if (cIdx !== -1) {
  const cmd = args.slice(cIdx + 1).join(' ')
  if (!cmd) {
    console.error('No command provided after -c')
    process.exit(1)
  }
  const proc = Bun.spawn([...sshOpts, sshTarget, cmd], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
    env: spawnEnv,
  })
  process.exit(await proc.exited)
}

// Mode 3: docker exec into container
if (args.length > 0 && !args[0].startsWith('-')) {
  const target = args[0]
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/.test(target)) {
    console.error(`Invalid container name: ${target}`)
    process.exit(1)
  }
  const projectName = config.stack.projectName

  // Single SSH call: list containers + probe UID of target container
  const probeProc = Bun.spawn(
    [
      ...sshOpts,
      sshTarget,
      `echo "===CONTAINERS==="; sudo docker ps --format '{{.Names}}'; ` +
        `echo "===UID==="; sudo docker exec ${target} sh -c 'cat /proc/1/status' 2>/dev/null | grep '^Uid' | awk '{print $3}'; ` +
        `sudo docker exec ${projectName}-${target} sh -c 'cat /proc/1/status' 2>/dev/null | grep '^Uid' | awk '{print $3}'`,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const probeOut = await new Response(probeProc.stdout).text()
  await probeProc.exited

  const sections = probeOut.split('===UID===')
  const running =
    (sections[0] || '').split('===CONTAINERS===')[1]?.trim().split('\n').filter(Boolean) || []
  const uidLines = (sections[1] || '').trim().split('\n').filter(Boolean)

  // Try exact match, then prefixed
  let containerName: string | undefined
  let effectiveUid = ''
  if (running.includes(target)) {
    containerName = target
    effectiveUid = uidLines[0] || ''
  } else if (running.includes(`${projectName}-${target}`)) {
    containerName = `${projectName}-${target}`
    effectiveUid = uidLines[1] || uidLines[0] || ''
  }

  if (!containerName) {
    console.error(`Container not found: ${target}`)
    if (running.length > 0) {
      console.error(`\nRunning containers:`)
      for (const c of running) console.error(`  ${c}`)
    }
    process.exit(1)
  }

  const uidNum = effectiveUid.trim()
  const userFlag = uidNum && /^\d+$/.test(uidNum) && uidNum !== '0' ? `-u ${uidNum}` : ''
  const proc = Bun.spawn(
    [...sshOpts, '-t', sshTarget, `sudo docker exec -it ${userFlag} -e TERM=xterm-256color ${containerName} bash -l`],
    { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit', env: spawnEnv },
  )
  const code = await proc.exited
  process.exit(code === 130 ? 0 : code)
}

// Mode 1: interactive SSH (no args)
const proc = Bun.spawn([...sshOpts, sshTarget], {
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
  env: spawnEnv,
})
const code = await proc.exited
process.exit(code)
