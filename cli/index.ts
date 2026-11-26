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

import { resolve } from 'node:path'
import pkg from '../package.json' with { type: 'json' }
import { resolveMode, checkVerb, type VerbSpec } from './lib/mode.js'
import { Output, EXIT } from './lib/output.js'

const VERSION = pkg.version

// Legacy stack-cli commands: still read ./stack.yml in the cwd. Replaced by fleet-aware verbs in
// phase 1 step 3. They are controller verbs and pass through the same guard.
const LEGACY: Record<string, { script: string; description: string }> = {
  deploy: { script: 'deploy.ts', description: '(legacy, ./stack.yml) deploy the stack' },
  status: { script: 'status.ts', description: '(legacy, ./stack.yml) containers and services' },
  logs: { script: 'logs.ts', description: '(legacy, ./stack.yml) stream Docker logs' },
  ssh: { script: 'ssh.ts', description: '(legacy, ./stack.yml) SSH into the VPS' },
  stacks: { script: 'stacks.ts', description: '(legacy, ./stack.yml) list/deactivate stacks' },
  env: { script: 'env.ts', description: '(legacy, ./stack.yml) resolved config' },
  'vps-setup': { script: 'vps-setup.ts', description: '(legacy, ./stack.yml) provision a VPS' },
}

const VERBS: (VerbSpec & { description: string })[] = [
  { name: 'whoami', requires: 'any', description: 'mode, machine/fleet, user, version, enabled verbs' },
  { name: 'version', requires: 'any', description: 'print the airstack version' },
  { name: 'help', requires: 'any', description: 'this help' },
  { name: 'fleet', requires: 'controller', needsFleet: true, description: 'list | show | config | check the fleet' },
  ...Object.entries(LEGACY).map(([name, l]) => ({
    name, requires: 'controller' as const, mutating: true, description: l.description,
  })),
]

// ── argv ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
let fleetFlag: string | undefined
const rest: string[] = []
for (let i = 0; i < argv.length; i++) {
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
  // Plugin commands of the legacy single-stack layout (cf-tunnel, backup, tailscale, …).
  const gate = checkVerb(mode, { name: verbName, requires: 'controller', mutating: true })
  if (!gate.ok) {
    out.fail(gate.reason)
    process.exit(EXIT.USAGE)
  }
  process.exit(await runLegacyPluginCommand(verbName, args))
}

const gate = checkVerb(mode, verb)
if (!gate.ok) {
  out.fail(gate.reason)
  if (verb.needsFleet && mode.mode === 'controller') out.next(`airstack --fleet <path> ${verbName} …`)
  process.exit(EXIT.USAGE)
}

switch (verb.name) {
  case 'version':
    out.info(`airstack ${VERSION}`)
    process.exit(EXIT.OK)
  case 'help':
    printHelp()
    process.exit(EXIT.OK)
  case 'whoami': {
    const { whoami } = await import('./commands/whoami.js')
    whoami(mode, VERBS, VERSION, out)
    process.exit(out.code())
  }
  case 'fleet': {
    const { fleetCommand } = await import('./commands/fleet.js')
    process.exit(await fleetCommand(args, mode.fleetPath!, out))
  }
  default: {
    const legacy = LEGACY[verb.name]
    const proc = Bun.spawn(['bun', new URL(legacy.script, import.meta.url).pathname, ...args], {
      stdout: 'inherit', stderr: 'inherit', stdin: 'inherit',
    })
    const code = await proc.exited
    process.exit(code === 130 ? 0 : code)
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

async function runLegacyPluginCommand(name: string, cmdArgs: string[]): Promise<number> {
  const { loadConfig } = await import('./lib/config.js')
  const { loadPlugins } = await import('./lib/plugin-loader.js')
  const { createRemoteExecutor, sshConfigFromHost } = await import('./lib/ssh.js')
  const { updateConfig: _updateConfig } = await import('./lib/config-writer.js')
  const projectRoot = resolve(process.cwd())
  try {
    const config = loadConfig(projectRoot)
    const plugins = await loadPlugins(config.plugins, projectRoot, [])
    for (const plugin of plugins) {
      const cmd = plugin.commands?.[name]
      if (!cmd) continue
      const ssh = sshConfigFromHost(config.host)
      const remote = ssh.host ? createRemoteExecutor(ssh) : undefined
      const log = { error: console.error, warn: console.warn, info: console.log, debug: () => {} }
      const updateConfig = (dotPath: string, value: string) => _updateConfig(projectRoot, config, dotPath, value)
      await cmd.run(cmdArgs, { config, ssh, remote, log, projectRoot, sharedPaths: [], updateConfig })
      return EXIT.OK
    }
  } catch {
    // no legacy stack.yml here: fall through to "unknown"
  }
  out.fail(`unknown verb: ${name}`)
  out.next('airstack help')
  return EXIT.USAGE
}
