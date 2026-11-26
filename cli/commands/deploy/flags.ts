/** deploy flags and usage text. */

import { SETUP_STEPS } from '../../vps-setup.js'

export const DEPLOY_USAGE = `Usage: airstack deploy <machine>... | '<pattern>' | --all [options]

  --stack <instance>   deploy only this stack instance (the machine unit always reconciles)
  --stage              render locally into .airstack/deploy/<machine>/ only; touches nothing remote
  --dry-run            sync + validate compose on the machine; do not start containers
  --force              recreate all services, and overwrite box edits (they stay in history)
  --prune              stop instances that were removed from the machine file (keeps their dirs)
  --install            first-time setup: base, harden, docker, rootless (if dev users), verify, reboot,
                       then lock SSH to host.ssh.port (only if it answers after the reboot),
                       write /etc/airstack/machine.yaml, then deploy
  --adopt              take over a machine that is already set up: checks it, then writes the
                       marker and the airstack build. No setup scripts, no container changes
  --install --step <s> run one setup step only (${SETUP_STEPS.join(', ')})
  --finalize           with --step harden: close the bootstrap port by hand (--install does it itself)
  --undo               with --step lockdown: open the external SSH port again
  -v, --verbose        phase-by-phase output

Quote patterns: airstack deploy 'airstack-*'  (zsh aborts or expands unquoted globs).`

export interface Flags {
  targets: string[]
  all: boolean
  stack?: string
  stage: boolean
  dryRun: boolean
  force: boolean
  prune: boolean
  install: boolean
  adopt: boolean
  step?: string
  finalize: boolean
  undo: boolean
  verbose: boolean
}

export function parseFlags(args: string[]): Flags | string {
  const f: Flags = { targets: [], all: false, stage: false, dryRun: false, force: false, prune: false, install: false, adopt: false, finalize: false, undo: false, verbose: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    switch (a) {
      case '--all': f.all = true; break
      case '--stack': f.stack = args[++i]; if (!f.stack) return '--stack needs an instance name'; break
      case '--stage': f.stage = true; break
      case '--dry-run': f.dryRun = true; break
      case '--force': f.force = true; break
      case '--prune': f.prune = true; break
      case '--install': f.install = true; break
      case '--adopt': f.adopt = true; break
      case '--finalize': f.finalize = true; break
      case '--undo': f.undo = true; break
      case '--step': f.step = args[++i]; if (!f.step) return '--step needs a step name'; break
      case '-v': case '--verbose': f.verbose = true; break
      default:
        if (a.startsWith('-')) return `unknown option: ${a}`
        f.targets.push(a)
    }
  }
  if (f.step && !f.install) return '--step only works with --install'
  if (f.step && !(SETUP_STEPS as readonly string[]).includes(f.step)) return `unknown step '${f.step}' (${SETUP_STEPS.join(', ')})`
  if (f.stage && f.dryRun) return '--stage and --dry-run are exclusive'
  if (f.install && (f.stage || f.dryRun)) return '--install changes the machine: it does not work with --stage or --dry-run'
  if (f.adopt && (f.install || f.stage || f.dryRun || f.stack)) return '--adopt works alone: not with --install, --stage, --dry-run or --stack'
  if (f.undo && f.step !== 'lockdown') return '--undo only works with --install --step lockdown'
  if (!f.all && f.targets.length === 0) return 'name at least one machine, a quoted pattern, or --all'
  return f
}
