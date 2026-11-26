/**
 * doctor on a controller: tools, PATH, and (in a fleet dir) the fleet repo's safety.
 *
 * --fix may: add `.airstack/` to .gitignore, chmod 600 the secrets files. Nothing else.
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION } from '../../lib/core.js'
import { loadFleet, loadMachine, loadSecrets } from '../../lib/fleet.js'
import type { Output } from '../../lib/output.js'

const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).status === 0

export function doctorController(fleetPath: string | undefined, fix: boolean, out: Output): void {
  for (const t of ['ssh', 'rsync', 'git', 'tar']) {
    if (has(t)) out.ok(`${t} found`)
    else out.fail(`${t} not found: airstack needs it`)
  }
  if (!(process.env.PATH ?? '').split(':').some((p) => p.endsWith('/.local/bin'))) {
    out.warn('~/.local/bin is not on PATH (install.sh puts airstack there)')
  }
  if (!fleetPath) {
    out.info('no fleet here (no ./airstack.yaml): fleet checks skipped')
    return
  }
  fleetChecks(fleetPath, fix, out)
}

function fleetChecks(fleetPath: string, fix: boolean, out: Output): void {
  const fleet = loadFleet(fleetPath)
  out.info(`fleet ${fleet.name}  (${fleet.root})`)

  if (fleet.versionPin && fleet.versionPin !== VERSION) {
    out.warn(`airstack.yaml pins ${fleet.versionPin}; this airstack is ${VERSION}`)
    out.next(`airstack install ${fleet.versionPin}`)
  } else if (fleet.versionPin) out.ok(`version pin ${fleet.versionPin} matches`)

  gitignore(fleet.root, fix, out)
  secretModes(fleet.root, fix, out)
  committedSecrets(fleet, out)

  let fails = 0
  for (const ref of fleet.machines) fails += loadMachine(fleet, ref.name).issues.filter((i) => i.level === 'fail').length
  if (fails) {
    out.fail(`${fails} config error(s) in machine files`)
    out.next('airstack fleet check')
  } else out.ok(`${fleet.machines.length} machine file(s) load without errors (airstack fleet check runs the full check)`)
}

function isGitRepo(root: string): boolean {
  return spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'pipe' }).status === 0
}

function gitignore(root: string, fix: boolean, out: Output): void {
  if (!isGitRepo(root)) { out.info('fleet is not a git repo: .gitignore check skipped'); return }
  if (spawnSync('git', ['check-ignore', '-q', '.airstack/x'], { cwd: root }).status === 0) {
    out.ok('.airstack/ is gitignored')
    return
  }
  if (fix) {
    appendFileSync(join(root, '.gitignore'), '\n.airstack/\n')
    out.ok('fixed: added .airstack/ to .gitignore')
  } else {
    out.fail('.airstack/ is NOT gitignored: it holds secrets and pulled machine files')
    out.next('airstack doctor --fix')
  }
}

function secretModes(root: string, fix: boolean, out: Output): void {
  const dir = join(root, '.airstack', 'secrets')
  if (!existsSync(dir)) { out.info('no .airstack/secrets/ yet'); return }
  const loose = readdirSync(dir).filter((f) => f.endsWith('.jsonc')).filter((f) => (statSync(join(dir, f)).mode & 0o077) !== 0)
  if (loose.length === 0) { out.ok('secrets files are mode 600'); return }
  if (fix) {
    for (const f of loose) chmodSync(join(dir, f), 0o600)
    out.ok(`fixed: chmod 600 ${loose.join(', ')}`)
  } else {
    out.warn(`secrets files readable by others: ${loose.join(', ')}`)
    out.next('airstack doctor --fix')
  }
}

/** A secret value inside a committed (git-tracked) file is a leak. Names only, never values. */
function committedSecrets(fleet: ReturnType<typeof loadFleet>, out: Output): void {
  if (!isGitRepo(fleet.root)) return
  const values = new Map<string, string>()
  for (const ref of fleet.machines) {
    for (const [k, v] of Object.entries(loadSecrets(fleet.root, ref.name, []))) if (v.length >= 8) values.set(v, k)
  }
  if (values.size === 0) return
  const files = spawnSync('git', ['ls-files', '-z'], { cwd: fleet.root, encoding: 'utf-8' }).stdout.split('\0').filter(Boolean)
  const hits: string[] = []
  for (const f of files) {
    const p = join(fleet.root, f)
    if (!existsSync(p) || statSync(p).size > 2_000_000) continue
    const text = readFileSync(p, 'utf-8')
    for (const [v, name] of values) if (text.includes(v)) hits.push(`${f} (${name})`)
  }
  if (hits.length) out.fail(`secret values in committed files: ${hits.join(', ')}. Use \${NAME} references instead.`)
  else out.ok(`no secret values in ${files.length} committed file(s)`)
}
