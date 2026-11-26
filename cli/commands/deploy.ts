/**
 * airstack deploy <machine|'pattern'...|--all> [--stack <instance>] [--stage | --dry-run] [--force]
 *                 [--prune] [--install [--step <step>]] [-v]
 *
 * Per machine: load + check config, then deploy the machine unit and each stack instance unit
 * through the deploy pipeline, then refresh /etc/airstack/machine.yaml. Machines run one after
 * another; a failed machine does not stop the others. Exit 0 ok, 1 warnings, 2 any failure, 3 usage.
 */

import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { loadFleet, loadMachine, selectTargets, type Fleet } from '../lib/fleet.js'
import { checkPluginScopes, loadPluginRef } from '../lib/fleet-check.js'
import { buildUnits, MACHINE_UNIT, type DeployUnit } from '../lib/units.js'
import { runDeploy } from '../deploy/runner.js'
import { createLoggingExecutor, createRemoteExecutor, sshConfigFromHost } from '../lib/ssh.js'
import { renderReport } from '../lib/report.js'
import { Logger } from '../lib/logger.js'
import { composeCommand } from '../lib/compose.js'
import { markerYaml, readMarker, writeMarker, type MarkerStack } from '../lib/marker.js'
import { LEGACY_MANIFEST_DIR } from '../lib/paths.js'
import { SETUP_STEPS } from '../vps-setup.js'
import { runInstall } from '../lib/install.js'
import { EXIT, type Output } from '../lib/output.js'
import type { DeployContext, DeployPhase, Plugin, RemoteExecutor } from '../types.js'

export const DEPLOY_USAGE = `Usage: airstack deploy <machine>... | '<pattern>' | --all [options]

  --stack <instance>   deploy only this stack instance (the machine unit always reconciles)
  --stage              render locally into .airstack/deploy/<machine>/ only; touches nothing remote
  --dry-run            sync + validate compose on the machine; do not start containers
  --force              recreate all services
  --prune              stop instances that were removed from the machine file (keeps their dirs)
  --install            first-time setup: base, harden, docker, rootless (if dev users), verify, reboot,
                       then lock SSH to host.ssh.port (only if it answers after the reboot),
                       write /etc/airstack/machine.yaml, then deploy
  --install --step <s> run one setup step only (${SETUP_STEPS.join(', ')})
  --finalize           with --step harden: close the bootstrap port by hand (--install does it itself)
  -v, --verbose        phase-by-phase output

Quote patterns: airstack deploy 'airstack-*'  (zsh aborts or expands unquoted globs).`

interface Flags {
  targets: string[]
  all: boolean
  stack?: string
  stage: boolean
  dryRun: boolean
  force: boolean
  prune: boolean
  install: boolean
  step?: string
  finalize: boolean
  verbose: boolean
}

function parseFlags(args: string[]): Flags | string {
  const f: Flags = { targets: [], all: false, stage: false, dryRun: false, force: false, prune: false, install: false, finalize: false, verbose: false }
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
      case '--finalize': f.finalize = true; break
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
  if (!f.all && f.targets.length === 0) return 'name at least one machine, a quoted pattern, or --all'
  return f
}

export async function deployCommand(args: string[], fleetPath: string, version: string, out: Output): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    out.info(DEPLOY_USAGE)
    return EXIT.OK
  }
  const f = parseFlags(args)
  if (typeof f === 'string') {
    out.fail(f)
    out.next('airstack deploy --help')
    return EXIT.USAGE
  }

  const fleet = loadFleet(fleetPath)
  for (const i of fleet.issues.filter((x) => x.level === 'fail')) out.fail(`${i.file}: ${i.message}`)
  if (fleet.issues.some((x) => x.level === 'fail')) return EXIT.FAIL
  if (!airstackDirIgnored(fleet.root)) {
    out.fail(`${fleet.root}/.airstack/ is not gitignored: it holds secrets and staged deploy trees`)
    out.next(`echo '.airstack/' >> ${join(fleet.root, '.gitignore')}`)
    return EXIT.FAIL
  }

  const { selected, unmatched } = selectTargets(fleet.machines.map((m) => m.name), f.targets, f.all)
  for (const u of unmatched) out.fail(`no machine matches '${u}'`)
  if (selected.length === 0) return EXIT.FAIL

  const results: { machine: string; ok: boolean; note: string }[] = []
  for (const name of selected) {
    const r = await deployMachine(fleet, name, f, version, out)
    results.push({ machine: name, ...r })
  }
  if (selected.length > 1) {
    out.info('')
    for (const r of results) (r.ok ? out.ok.bind(out) : out.fail.bind(out))(`${r.machine}: ${r.note}`)
  }
  return unmatched.length ? EXIT.FAIL : out.code()
}

async function deployMachine(fleet: Fleet, name: string, f: Flags, version: string, out: Output): Promise<{ ok: boolean; note: string }> {
  const m = loadMachine(fleet, name)
  const issues = [...m.issues, ...(await checkPluginScopes(fleet, m))]
  for (const i of issues) {
    const where = i.key ? `${i.file} ${i.key}` : i.file
    if (i.level === 'fail') out.fail(`${name}: ${where}: ${i.message}`)
    else out.warn(`${name}: ${where}: ${i.message}`)
  }
  if (issues.some((i) => i.level === 'fail')) return { ok: false, note: 'config errors (airstack fleet check)' }
  if (f.stack && !m.instances.some((i) => i.name === f.stack)) {
    out.fail(`${name}: no stack instance '${f.stack}' (have: ${m.instances.map((i) => i.name).join(', ') || 'none'})`)
    return { ok: false, note: `no instance ${f.stack}` }
  }

  let units: DeployUnit[]
  try {
    units = buildUnits(fleet, m, f.stack)
  } catch (e) {
    out.fail(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, note: 'unit build failed' }
  }
  const machineUnit = units[0]
  const remote: RemoteExecutor | undefined = f.stage ? undefined : createRemoteExecutor(sshConfigFromHost(machineUnit.config.host))

  // ── install / marker gate ──
  if (f.install) {
    const r = await runInstall(fleet, m, machineUnit, { step: f.step, finalize: f.finalize }, out)
    if (!r.ok || f.step) return r
    if (!(await writeMarker(remote!, markerYaml(fleet, m, version)))) {
      out.fail(`${name}: could not write /etc/airstack/machine.yaml`)
      return { ok: false, note: 'marker write failed' }
    }
    out.ok(`${name}: wrote /etc/airstack/machine.yaml`)
  }

  let previous: Record<string, MarkerStack> = {}
  if (remote) {
    const marker = await readMarker(remote)
    if (!marker.exists) {
      out.fail(`${name}: not an airstack node yet (no /etc/airstack/machine.yaml)`)
      out.next(`airstack deploy ${name} --install`)
      return { ok: false, note: 'not installed' }
    }
    previous = marker.stacks

    // Machine root and stacks/ belong to the stack user, closed to everyone else (docs/LAYOUT.md).
    // Dev-user stacks live outside it (fleet check enforces that).
    const su = m.host.users.stack
    const mk = await remote.run(`sudo install -d -o ${su} -g ${su} -m 750 ${m.root} ${m.root}/stacks`)
    if (mk.exitCode !== 0) {
      out.fail(`${name}: cannot create ${m.root} for ${su}: ${(mk.stderr || mk.stdout).trim()}`)
      return { ok: false, note: 'machine root' }
    }
  }

  // ── units ──
  let failed = 0
  for (const unit of units) {
    const r = await deployUnit(fleet, unit, f, remote)
    const label = unit.kind === 'machine' ? `${name}/${MACHINE_UNIT} (machine)` : `${name}/${unit.name}`
    if (r.ok) out.ok(`${label}: ${r.note}`)
    else {
      failed++
      out.fail(`${label}: ${r.note}`)
      out.info(`     log: ${relative(process.cwd(), r.logDir) || r.logDir}`)
    }
  }

  if (!remote || f.dryRun) return failed ? { ok: false, note: `${failed} unit(s) failed` } : { ok: true, note: f.stage ? 'staged' : 'dry-run ok' }

  // stack-cli kept manifests in /etc/stacks; orphan cleanup empties it, then drop the dir (only if empty).
  await remote.run(`sudo rmdir ${LEGACY_MANIFEST_DIR} 2>/dev/null || true`)

  // ── orphans, marker ──
  const current = new Set(m.instances.map((i) => i.name))
  const orphans = Object.entries(previous).filter(([inst]) => !current.has(inst))
  for (const [inst, s] of orphans) {
    if (!f.prune) {
      out.warn(`${name}/${inst}: removed from the machine file but still deployed (${s.installDir})`)
      out.next(`airstack deploy ${name} --prune`)
      continue
    }
    const ok = await pruneInstance(remote, s)
    if (ok) out.ok(`${name}/${inst}: pruned (compose down, crons and manifest removed; ${s.installDir} kept)`)
    else out.fail(`${name}/${inst}: prune failed`)
  }
  // Unpruned orphans stay listed so the next deploy still sees them.
  const keepOrphans = f.prune ? {} : Object.fromEntries(orphans)
  if (!(await writeMarker(remote, markerYaml(fleet, m, version, keepOrphans)))) {
    out.warn(`${name}: could not refresh /etc/airstack/machine.yaml`)
  }

  return failed ? { ok: false, note: `${failed} unit(s) failed` } : { ok: true, note: `${units.length} unit(s) deployed` }
}

async function deployUnit(fleet: Fleet, unit: DeployUnit, f: Flags, remote?: RemoteExecutor): Promise<{ ok: boolean; note: string; logDir: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5)
  const logDir = join(unit.logRoot, stamp)
  const log = new Logger(f.verbose ? 'info' : 'error', logDir)

  const plugins: Plugin[] = []
  for (const { ref, config } of unit.pluginRefs) {
    try {
      plugins.push((await loadPluginRef(fleet.root, ref, config)).plugin)
    } catch (e) {
      return { ok: false, note: `plugin ${ref}: ${e instanceof Error ? e.message : String(e)}`, logDir }
    }
  }
  const hasServices = unit.hasComposeTemplate || plugins.some((p) => p.composeServices?.length)
  if (!hasServices) delete unit.config.templates['docker-compose.yml']

  const ctx: DeployContext = {
    phase: 'init',
    projectRoot: unit.projectRoot,
    sharedPaths: unit.sharedPaths,
    deployDir: unit.deployDir,
    config: unit.config,
    ssh: sshConfigFromHost(unit.config.host),
    plugins,
    log,
    remote: remote ? createLoggingExecutor(remote, log) : undefined,
    errors: [],
    changes: [],
    phaseStatus: [],
    compose: { services: [], buildArgs: [], upArgs: f.force ? ['--force-recreate'] : [], profiles: [], skip: !hasServices },
    report: { data: {} },
    manifest: { destination: '', entries: {} },
    registeredFiles: { scripts: { dirs: ['plugins', 'crons'], exclude: [] }, hostFiles: [] },
    stopAfter: (f.stage ? 'stage' : f.dryRun ? 'dry-run' : undefined) as DeployPhase | undefined,
    force: f.force,
    updateConfig(dotPath: string) {
      throw new Error(`updateConfig(${dotPath}) is not supported for fleet deploys yet: put the value in .airstack/secrets/${unit.machine}.jsonc`)
    },
  }

  await runDeploy(ctx)
  try { renderReport(ctx, logDir) } catch { /* report is best effort */ }

  const fatal = ctx.errors.filter((e) => e.fatal)
  const warns = ctx.errors.filter((e) => !e.fatal)
  for (const w of warns) log.warn(`[${w.phase}] ${w.message}`)
  if (fatal.length) return { ok: false, note: `${fatal[0].phase}: ${fatal[0].message.split('\n')[0]}`, logDir }
  const what = f.stage ? 'staged' : f.dryRun ? 'synced + validated' : hasServices ? 'deployed' : 'deployed (no compose services)'
  return { ok: true, note: `${what}${warns.length ? `, ${warns.length} warning(s): ${warns[0].message.split('\n')[0]}` : ''}`, logDir }
}

async function pruneInstance(remote: RemoteExecutor, s: MarkerStack): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(s.composeProject) || !/^\/[\w./-]+$/.test(s.installDir) || !/^[a-z_][a-z0-9_-]*$/.test(s.user)) return false
  const ctx = { config: { host: { appUser: s.user }, stack: { installDir: s.installDir, projectName: s.composeProject, runUserKind: s.userKind } } } as unknown as DeployContext
  const down = await remote.run(`${composeCommand(ctx, 'down')} 2>&1`)
  await remote.run(`sudo rm -f /etc/cron.d/${s.composeProject}_* /etc/logrotate.d/${s.composeProject} /etc/airstack/stacks/${s.composeProject}.env /etc/stacks/${s.composeProject}.env`)
  return down.exitCode === 0
}

function airstackDirIgnored(root: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'pipe' })
  } catch {
    return true // not a git repo: nothing to leak into
  }
  try {
    execFileSync('git', ['check-ignore', '-q', '.airstack/x'], { cwd: root, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
