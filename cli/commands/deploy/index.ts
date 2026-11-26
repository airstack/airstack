/**
 * airstack deploy <machine|'pattern'...|--all> [--stack <instance>] [--stage | --dry-run] [--force]
 *                 [--prune] [--install [--step <step>]] [-v]
 *
 * Per machine: load + check config, prepare the node (airstack build, marker), then deploy the
 * machine unit and each stack instance unit through the deploy pipeline. Machines run one after
 * another; a failed machine does not stop the others. Exit 0 ok, 1 warnings, 2 any failure, 3 usage.
 */

import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { loadFleet, loadMachine, selectTargets, type Fleet } from '../../lib/fleet.js'
import { checkPluginScopes } from '../../lib/fleet-check.js'
import { lintMachine } from '../../lib/fleet-lint.js'
import { buildUnits, MACHINE_UNIT, type DeployUnit } from '../../lib/units.js'
import { createRemoteExecutor, sshConfigFromHost } from '../../lib/ssh.js'
import { markerYaml, writeMarker } from '../../lib/marker.js'
import { LEGACY_MANIFEST_DIR } from '../../lib/paths.js'
import { runInstall } from '../../lib/install.js'
import { fleetCommit } from '../../lib/history-hooks.js'
import { EXIT, type Output } from '../../lib/output.js'
import type { RemoteExecutor } from '../../types.js'
import { DEPLOY_USAGE, parseFlags, type Flags } from './flags.js'
import { prepareNode, type NodePrep } from './node-prep.js'
import { deployUnit, pruneInstance } from './unit.js'

export { DEPLOY_USAGE } from './flags.js'

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
  const issues = [...m.issues, ...(await checkPluginScopes(fleet, m)), ...(await lintMachine(fleet, m))]
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

  if (f.install) {
    const r = await runInstall(fleet, m, machineUnit, { step: f.step, finalize: f.finalize }, out)
    if (!r.ok || f.step) return r
    if (!(await writeMarker(remote!, markerYaml(fleet, m, version)))) {
      out.fail(`${name}: could not write /etc/airstack/machine.yaml`)
      return { ok: false, note: 'marker write failed' }
    }
    out.ok(`${name}: wrote /etc/airstack/machine.yaml`)
  }

  let prep: NodePrep | undefined
  if (remote) {
    prep = await prepareNode(remote, fleet, m, f, version, out)
    if (!prep.ok) return prep
  }

  const commit = fleetCommit(fleet.root)
  let failed = 0
  for (const unit of units) {
    const r = await deployUnit(fleet, unit, f, commit, remote)
    const label = unit.kind === 'machine' ? `${name}/${MACHINE_UNIT} (machine)` : `${name}/${unit.name}`
    if (r.ok) out.ok(`${label}: ${r.note}`)
    else {
      failed++
      out.fail(`${label}: ${r.note}`)
      out.info(`     log: ${relative(process.cwd(), r.logDir) || r.logDir}`)
    }
  }

  if (!remote || !prep || f.dryRun) return failed ? { ok: false, note: `${failed} unit(s) failed` } : { ok: true, note: f.stage ? 'staged' : 'dry-run ok' }

  // Legacy cleanup: stack-cli (airstack's predecessor) kept manifests in /etc/stacks. Orphan cleanup
  // empties it; then drop the dir (only if empty).
  await remote.run(`sudo rmdir ${LEGACY_MANIFEST_DIR} 2>/dev/null || true`)

  for (const [inst, s] of prep.orphans) {
    if (!f.prune) {
      out.warn(`${name}/${inst}: removed from the machine file but still deployed (${s.installDir})`)
      out.next(`airstack deploy ${name} --prune`)
      continue
    }
    const ok = await pruneInstance(remote, s)
    if (ok) out.ok(`${name}/${inst}: removed. Containers stopped; crons and manifest deleted; files in ${s.installDir} kept.`)
    else out.fail(`${name}/${inst}: prune failed: docker compose down did not succeed`)
  }
  // Unpruned orphans stay listed in the marker so the next deploy still sees them.
  if (f.prune && prep.orphans.length && !(await writeMarker(remote, markerYaml(fleet, m, prep.version, {})))) {
    out.warn(`${name}: could not refresh /etc/airstack/machine.yaml`)
  }

  return failed ? { ok: false, note: `${failed} unit(s) failed` } : { ok: true, note: `${units.length} unit(s) deployed` }
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
