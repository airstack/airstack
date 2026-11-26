/**
 * airstack pull <machine> — bring the machine's live managed files to this controller.
 *
 * Steps:
 *   1. On the machine: save box edits in the config history (`airstack machine snapshot`).
 *   2. Copy the history work tree to .airstack/pull/<machine>/ (raw files, secrets included;
 *      .airstack/ is gitignored).
 *   3. Write .airstack/deploy/<machine>/.stack-base (the history commit you saw). The next deploy
 *      then may overwrite those box edits: you have seen them.
 *   4. Stage the fleet locally and print a REDACTED diff: fleet render → machine, per unit. Box-owned
 *      (tracked) files show what changed since the last pull.
 * Put the edits you want into the fleet repo (templates, values), then deploy.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { loadFleet, loadMachine, type Machine } from '../lib/fleet.js'
import { buildUnits, type DeployUnit } from '../lib/units.js'
import { createRemoteExecutor, sshConfigFromHost } from '../lib/ssh.js'
import { fleetCommit, STACK_BASE_FILE } from '../lib/history-hooks.js'
import { parseManaged, MANAGED_FILE } from '../lib/managed.js'
import { NODE_BIN } from '../lib/release/node-install.js'
import { redactDiff, type RedactRule } from '../lib/redact/index.js'
import { EXIT, type Output } from '../lib/output.js'
import { deployUnit } from './deploy/unit.js'
import type { Flags } from './deploy/flags.js'

export const PULL_USAGE = `Usage: airstack pull <machine>

Copies the machine's live managed files to .airstack/pull/<machine>/ and shows how they differ
from the fleet (secrets redacted). After a pull, deploy may overwrite the box edits you saw.`

const STAGE_FLAGS: Flags = { targets: [], all: false, stage: true, dryRun: false, force: false, prune: false, install: false, finalize: false, verbose: false }

export async function pullCommand(args: string[], fleetPath: string, out: Output): Promise<number> {
  const name = args.find((a) => !a.startsWith('-'))
  if (!name || args.includes('--help') || args.includes('-h')) {
    out.info(PULL_USAGE)
    return name ? EXIT.OK : EXIT.USAGE
  }
  const fleet = loadFleet(fleetPath)
  if (!fleet.machines.some((m) => m.name === name)) {
    out.fail(`no machine '${name}' in ${fleet.root}/machines`)
    return EXIT.USAGE
  }
  const m = loadMachine(fleet, name)
  if (m.issues.some((i) => i.level === 'fail')) {
    out.fail(`${name}: the machine config has errors`)
    out.next(`airstack fleet check ${name}`)
    return EXIT.FAIL
  }
  const units = buildUnits(fleet, m)
  const remote = createRemoteExecutor(sshConfigFromHost(units[0].config.host))
  const pullDir = join(fleet.root, '.airstack', 'pull', name)
  const prevDir = `${pullDir}.prev`
  const store = `${m.root}/.stack`

  // 1. snapshot
  const snap = await remote.run(`sudo ${NODE_BIN} machine snapshot`)
  if (snap.exitCode !== 0) {
    out.fail(`${name}: snapshot failed: ${(snap.stderr || snap.stdout).trim().split('\n').pop()}`)
    out.next(`airstack deploy ${name}   (puts an airstack with config history on the machine)`)
    return EXIT.FAIL
  }
  for (const l of snap.stdout.split('\n').filter((x) => x.includes('saved box edits'))) out.info(`     ${l.replace(/^\S+\s+/, '')}`)

  // 2. copy (keep the previous pull to diff box-owned files)
  rmSync(prevDir, { recursive: true, force: true })
  if (existsSync(pullDir)) cpSync(pullDir, prevDir, { recursive: true })
  mkdirSync(pullDir, { recursive: true, mode: 0o700 })
  const dl = await remote.download!(`${store}/`, `${pullDir}/`, ['--delete', '--exclude=.git', '--exclude=README'])
  if (dl.exitCode !== 0) {
    out.fail(`${name}: copy from ${store} failed (rsync exit ${dl.exitCode})`)
    return EXIT.FAIL
  }

  // 3. base
  const head = await remote.run(`sudo git -C ${store} rev-parse HEAD`)
  const base = head.stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(base)) {
    out.fail(`${name}: cannot read the history commit`)
    return EXIT.FAIL
  }
  const deployRoot = join(fleet.root, '.airstack', 'deploy', name)
  mkdirSync(deployRoot, { recursive: true })
  writeFileSync(join(deployRoot, STACK_BASE_FILE), `${base}\n`)
  out.ok(`${name}: pulled history ${base.slice(0, 8)} into ${relative(process.cwd(), pullDir) || pullDir}`)

  // 4. compare with the fleet render
  const commit = fleetCommit(fleet.root)
  for (const unit of units) {
    const r = await deployUnit(fleet, unit, STAGE_FLAGS, commit)
    if (!r.ok) { out.fail(`${unit.name}: cannot stage the fleet: ${r.note}`); continue }
    compareUnit(m, unit, pullDir, prevDir, out)
  }
  rmSync(prevDir, { recursive: true, force: true })
  return out.code()
}

function compareUnit(m: Machine, unit: DeployUnit, pullDir: string, prevDir: string, out: Output): void {
  const slot = unit.kind === 'machine' ? 'machine' : `stacks/${unit.name}`
  const label = unit.kind === 'machine' ? 'machine' : unit.name
  const box = join(pullDir, slot)
  const mf = join(unit.deployDir, MANAGED_FILE)
  const managed = existsSync(mf) ? parseManaged(readFileSync(mf, 'utf-8')) : undefined
  if (!managed) return
  if (!existsSync(box)) { out.info(`${label}: not on the machine yet`); return }
  const opts = { secrets: m.secrets, rules: managed.redact as RedactRule[] }

  const differ = managed.rendered.filter((f) => existsSync(join(box, f)) && !sameFile(join(unit.deployDir, f), join(box, f)))
  if (differ.length === 0) out.ok(`${label}: rendered files match the fleet`)
  else {
    out.warn(`${label}: ${differ.length} file(s) on the machine differ from the fleet: ${differ.join(', ')}`)
    for (const f of differ) printDiff(join(unit.deployDir, f), join(box, f), `fleet/${f}`, `machine/${f}`, opts, out)
  }

  const prev = join(prevDir, slot)
  for (const f of managed.tracked) {
    const now = join(box, f)
    if (!existsSync(now)) continue
    const before = join(prev, f)
    if (!existsSync(before)) { out.info(`${label}: ${f} is owned by the machine (deploy does not write it); first pull`); continue }
    if (sameFile(before, now)) continue
    out.warn(`${label}: ${f} (owned by the machine) changed since the last pull`)
    printDiff(before, now, `last-pull/${f}`, `machine/${f}`, opts, out)
  }
}

function sameFile(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b))
}

function printDiff(a: string, b: string, la: string, lb: string, opts: { secrets: Record<string, string>; rules: RedactRule[] }, out: Output): void {
  // Run from / with relative paths, so the labels in the diff are easy to replace.
  const ra = relative('/', a)
  const rb = relative('/', b)
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--src-prefix=', '--dst-prefix=', ra, rb], { cwd: '/', encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 })
  const text = (r.stdout ?? '').replaceAll(ra, la).replaceAll(rb, lb)
  const red = redactDiff(text, { ...opts, file: lb.replace(/^machine\//, '') })
  out.info(red.text.replace(/\n$/, ''))
}
