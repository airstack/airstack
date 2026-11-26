#!/usr/bin/env bun
/**
 * airstack — one binary, two modes (controller / node). See AGENTS.md and plans/phase-1.md.
 *
 * Every verb is registered with what it requires. The mode guard runs before anything else.
 * The guard prevents accidents; it is NOT a security boundary (AGENTS.md rule 1).
 *
 * Global options (before or after the verb):
 *   --fleet <path>   fleet repo (controller mode only; default ./airstack.yaml, no parent walk)
 */

import { resolveMode, checkVerb, type VerbSpec } from './lib/mode.js'
import { Output, EXIT } from './lib/output.js'
import * as core from './lib/core.js'

const VERSION = core.VERSION

const VERBS: (VerbSpec & { description: string })[] = [
  { name: 'whoami', requires: 'any', description: 'mode, machine/fleet, user, version, enabled verbs' },
  { name: 'version', requires: 'any', description: 'print the airstack version' },
  { name: 'help', requires: 'any', description: 'this help' },
  { name: 'doctor', requires: 'any', description: 'check this machine (and fleet / nodes); --fix for safe fixes' },
  { name: 'versions', requires: 'any', description: 'installed airstack versions on this machine' },
  { name: 'update', requires: 'any', mutating: true, description: 'install the newest airstack release here (nodes: off by default)' },
  { name: 'install', requires: 'any', mutating: true, description: 'install <version>: a given airstack release here' },
  { name: 'init', requires: 'controller', mutating: true, description: 'init [<dir>]: create a new fleet repo skeleton (no fleet needed)' },
  { name: 'fleet', requires: 'controller', needsFleet: true, description: 'list | show | config | check | plugin' },
  { name: 'deploy', requires: 'controller', needsFleet: true, mutating: true, description: 'deploy machines (--install for first-time setup)' },
  { name: 'status', requires: 'controller', needsFleet: true, description: 'containers per stack instance on each machine' },
  { name: 'ssh', requires: 'controller', needsFleet: true, mutating: true, description: 'ssh <machine> [-- <command>]' },
  { name: 'pull', requires: 'controller', needsFleet: true, description: 'copy a machine\'s live config here; show box edits (redacted)' },
  { name: 'machine', requires: 'node', mutating: true, description: 'this node: status | check | report | logs | config | history | apply | rollback' },
]

// ── argv ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
let fleetFlag: string | undefined
const rest: string[] = []
for (let i = 0; i < argv.length; i++) {
  // Everything after `--` belongs to the verb (e.g. ssh <m> -- cmd --fleet x)
  if (argv[i] === '--') { rest.push(...argv.slice(i)); break }
  if (argv[i] === '--fleet' && i + 1 < argv.length) fleetFlag = argv[++i]
  else if (argv[i].startsWith('--fleet=')) fleetFlag = argv[i].slice(8)
  else rest.push(argv[i])
}
let verbName = rest[0] ?? 'help'
if (verbName === '--help' || verbName === '-h') verbName = 'help'
if (verbName === '--version' || verbName === '-v') verbName = 'version'
const args = rest.slice(1)

const out = new Output()
const mode = resolveMode({ fleetFlag })

if (fleetFlag && mode.mode === 'node') {
  out.fail('blocked: --fleet is ignored on a node; the fleet can only be pinned in /etc/airstack/machine.yaml')
  process.exit(EXIT.USAGE)
}

// ── dispatch ────────────────────────────────────────────────────────────────

const verb = VERBS.find((v) => v.name === verbName)
if (!verb) {
  out.fail(`unknown verb: ${verbName}`)
  if (verbName === 'cf-tunnel' || verbName === 'backup' || verbName === 'tailscale') {
    out.next(`airstack fleet plugin <machine> ${verbName} ${args.join(' ')}`.trimEnd())
  } else {
    out.next('airstack help')
  }
  process.exit(EXIT.USAGE)
}

const gate = checkVerb(mode, verb)
if (!gate.ok) {
  out.fail(gate.reason)
  if (verb.needsFleet && mode.mode === 'controller') out.next(`airstack --fleet <path> ${verbName} …`)
  process.exit(EXIT.USAGE)
}

switch (verb.name) {
  case 'version':
    out.info(`airstack ${core.versionLabel()}`)
    process.exit(EXIT.OK)
  case 'help':
    printHelp()
    process.exit(EXIT.OK)
  case 'whoami': {
    const { whoami } = await import('./commands/whoami.js')
    whoami(mode, VERBS, core.versionLabel(), out)
    process.exit(out.code())
  }
  case 'doctor': {
    const { doctorCommand } = await import('./commands/doctor/index.js')
    process.exit(await doctorCommand(mode, args, out))
  }
  case 'versions': {
    const { versionsCommand } = await import('./commands/versions.js')
    process.exit(await versionsCommand(mode, out))
  }
  case 'update':
  case 'install': {
    if (verb.name === 'install' && !args[0]) {
      out.fail('usage: airstack install <version>')
      process.exit(EXIT.USAGE)
    }
    const { updateCommand } = await import('./commands/versions.js')
    const code = await updateCommand(mode, verb.name === 'install' ? args[0] : undefined, out)
    if (code > EXIT.WARN) process.exit(code)
    // doctor after a version change: the one place for post-update checks.
    const { doctorCommand } = await import('./commands/doctor/index.js')
    out.info('')
    process.exit(Math.max(code, await doctorCommand(mode, [], out)))
  }
  case 'fleet': {
    const { fleetCommand } = await import('./commands/fleet.js')
    process.exit(await fleetCommand(args, mode.fleetPath!, out))
  }
  case 'deploy': {
    const { deployCommand } = await import('./commands/deploy/index.js')
    process.exit(await deployCommand(args, mode.fleetPath!, VERSION, out))
  }
  case 'status': {
    const { statusCommand } = await import('./commands/ssh-status.js')
    process.exit(await statusCommand(args, mode.fleetPath!, out))
  }
  case 'ssh': {
    const { sshCommand } = await import('./commands/ssh-status.js')
    process.exit(await sshCommand(args, mode.fleetPath!, out))
  }
  case 'pull': {
    const { pullCommand } = await import('./commands/pull.js')
    process.exit(await pullCommand(args, mode.fleetPath!, out))
  }
  case 'machine': {
    const { machineCommand } = await import('./commands/machine/index.js')
    process.exit(machineCommand(args, out))
  }
  case 'init': {
    const { initCommand } = await import('./commands/init.js')
    process.exit(initCommand(args, out))
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function printHelp() {
  out.info(`airstack ${VERSION} — manage a fleet of VPS machines from one fleet repo

Usage: airstack [--fleet <path>] <verb> [args]
`)
  const w = Math.max(...VERBS.map((v) => v.name.length)) + 2
  for (const v of VERBS) {
    const c = checkVerb(mode, v)
    out.info(`  ${v.name.padEnd(w)}${v.description}${c.ok ? '' : '   [off here: airstack whoami]'}`)
  }
  out.info(`
Bare verbs act on this machine only; anything remote goes through fleet / deploy / ssh.`)
}
