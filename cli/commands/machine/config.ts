/**
 * machine config read | diff — managed files with secrets redacted. Never prints a raw secret.
 *
 *   config read <unit>            list the unit's managed files (rendered / tracked)
 *   config read <unit> <file>     the live file, redacted, with line numbers
 *   config diff [<unit>]          box edits since the last deploy, redacted
 *   config diff <unit> --since <rev>
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact, redactDiff, withLineNumbers, type RedactOptions } from '../../lib/redact/index.js'
import { safeRelPath, type Managed } from '../../lib/managed.js'
import { snapshotUnit } from '../../node/history.js'
import { Store } from '../../node/store.js'
import { findUnit, readRedactSecrets, readUnitManaged, unitNames, type NodeInfo, type NodeUnit } from '../../node/units.js'
import { EXIT, type Output } from '../../lib/output.js'

export function configCmd(info: NodeInfo, args: string[], out: Output): number {
  const [sub, ...rest] = args
  if (sub === 'read') return readCmd(info, rest, out)
  if (sub === 'diff') return diffCmd(info, rest, out)
  out.fail(sub ? `unknown: machine config ${sub}` : 'machine config needs read or diff')
  out.next('airstack machine config read <unit> [<file>]   |   airstack machine config diff [<unit>]')
  return EXIT.USAGE
}

function unitOrFail(info: NodeInfo, name: string | undefined, out: Output): NodeUnit | undefined {
  const u = name ? findUnit(info, name) : undefined
  if (!u) out.fail(name ? `no unit '${name}' (units: ${unitNames(info)})` : `name a unit (${unitNames(info)})`)
  return u
}

function managedOrFail(u: NodeUnit, out: Output): Managed | undefined {
  const m = readUnitManaged(u)
  if (!m) {
    out.fail(`${u.name}: no file list yet (deploy this machine once with this airstack version)`)
    out.next('airstack deploy <machine>   (on the controller)')
  }
  return m
}

export function redactOpts(m: Managed, file?: string): RedactOptions {
  return { secrets: readRedactSecrets(), rules: m.redact, file }
}

function readCmd(info: NodeInfo, args: string[], out: Output): number {
  const u = unitOrFail(info, args[0], out)
  if (!u) return EXIT.USAGE
  const m = managedOrFail(u, out)
  if (!m) return EXIT.FAIL
  const file = args[1]
  if (!file) {
    out.info(`${u.name}  (${u.dir})`)
    for (const f of m.tracked) out.info(`  tracked   ${f}${existsSync(join(u.dir, f)) ? '' : '  (missing)'}`)
    for (const f of m.rendered) out.info(`  rendered  ${f}`)
    return EXIT.OK
  }
  const rel = file.replace(/^\.\//, '')
  const mode = m.tracked.includes(rel) ? 'tracked' : m.rendered.includes(rel) ? 'rendered' : undefined
  if (!safeRelPath(rel) || !mode) {
    out.fail(`${u.name}: ${file} is not a managed file`)
    out.next(`airstack machine config read ${u.name}   (lists the files)`)
    return EXIT.USAGE
  }
  const path = join(u.dir, rel)
  if (!existsSync(path)) { out.fail(`${u.name}: ${rel} does not exist on this machine`); return EXIT.FAIL }
  const r = redact(readFileSync(path, 'utf-8'), redactOpts(m, rel))
  out.info(`# ${u.name}/${rel}  (${mode}; ${r.count} value(s) redacted)`)
  out.info(withLineNumbers(r.text).replace(/\n$/, ''))
  return EXIT.OK
}

function diffCmd(info: NodeInfo, args: string[], out: Output): number {
  let since: string | undefined
  const pos: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since') since = args[++i]
    else pos.push(args[i])
  }
  const units = pos[0] ? [unitOrFail(info, pos[0], out)] : info.units
  if (units.some((u) => !u)) return EXIT.USAGE
  const store = new Store(info.root)
  let any = false
  for (const u of units as NodeUnit[]) {
    const m = readUnitManaged(u)
    if (!m) continue
    snapshotUnit(store, u, 'box edit', m)
    const from = since ? store.resolve(since) : store.lastDeployed(u.slot)
    if (since && !from) { out.fail(`unknown revision: ${since}`); return EXIT.USAGE }
    if (!from) { out.info(`${u.name}: no deploy recorded yet`); continue }
    const diff = store.diff(from, 'HEAD', [u.slot], u.slot)
    if (!diff.trim()) continue
    any = true
    const r = redactDiff(diff, { secrets: readRedactSecrets(), rules: m.redact })
    out.warn(`${u.name}: box edits since ${since ?? 'the last deploy'} (${r.count} value(s) redacted)`)
    out.info(r.text.replace(/\n$/, ''))
  }
  if (!any) out.ok(`no box edits since ${since ?? 'the last deploy'}`)
  return out.code()
}
