/**
 * machine history | snapshot — and two calls that deploy makes over SSH (one JSON line out):
 *   machine drift <unit> [--base <rev>]       stdin {"incoming": {"<path>": "<git blob id>"}}
 *   machine record-deploy <unit> [--commit <fleet commit>]
 */

import { readFileSync } from 'node:fs'
import { checkDrift, recordDeploy, snapshotUnit } from '../../node/history.js'
import { Store } from '../../node/store.js'
import { findUnit, unitNames, type NodeInfo, type NodeUnit } from '../../node/units.js'
import { EXIT, type Output } from '../../lib/output.js'

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function positional(args: string[], withValue: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (withValue.includes(args[i])) i++
    else if (!args[i].startsWith('-')) out.push(args[i])
  }
  return out
}

function units(info: NodeInfo, name: string | undefined, out: Output): NodeUnit[] | undefined {
  if (!name) return info.units
  const u = findUnit(info, name)
  if (!u) { out.fail(`no unit '${name}' (units: ${unitNames(info)})`); return undefined }
  return [u]
}

export function historyCmd(info: NodeInfo, args: string[], out: Output): number {
  const n = Number(opt(args, '-n') ?? 20)
  const list = units(info, positional(args, ['-n'])[0], out)
  if (!list) return EXIT.USAGE
  const store = new Store(info.root)
  if (!store.exists()) { out.info('no config history yet (it starts with the next deploy)'); return EXIT.OK }
  const paths = list.length === info.units.length ? [] : list.map((u) => u.slot)
  for (const e of store.log(paths, Number.isFinite(n) && n > 0 ? n : 20)) {
    out.info(`${e.sha.slice(0, 8)}  ${e.date.replace('T', ' ').slice(0, 19)}  ${e.subject}`)
  }
  return EXIT.OK
}

export function snapshotCmd(info: NodeInfo, args: string[], out: Output): number {
  const list = units(info, positional(args, [])[0], out)
  if (!list) return EXIT.USAGE
  const store = new Store(info.root)
  for (const u of list) {
    const r = snapshotUnit(store, u)
    if (r.untracked) out.info(`${u.name}: no file list yet (deploy once)`)
    else if (r.commit) out.ok(`${u.name}: saved box edits in ${r.commit.slice(0, 8)}: ${r.changed.join(', ')}`)
    else out.ok(`${u.name}: no changes`)
  }
  return out.code()
}

export function driftCmd(info: NodeInfo, args: string[], out: Output): number {
  const u = findUnit(info, positional(args, ['--base'])[0] ?? '')
  if (!u) { out.fail('drift: unknown unit'); return EXIT.USAGE }
  let incoming: Record<string, string> = {}
  try {
    incoming = (JSON.parse(readFileSync(0, 'utf-8')) as { incoming?: Record<string, string> }).incoming ?? {}
  } catch {
    out.fail('drift: stdin must be JSON {"incoming": {...}}')
    return EXIT.USAGE
  }
  const r = checkDrift(new Store(info.root), u, incoming, opt(args, '--base'))
  out.info(JSON.stringify(r))
  return EXIT.OK
}

export function recordDeployCmd(info: NodeInfo, args: string[], out: Output): number {
  const u = findUnit(info, positional(args, ['--commit'])[0] ?? '')
  if (!u) { out.fail('record-deploy: unknown unit'); return EXIT.USAGE }
  const r = recordDeploy(new Store(info.root), u, opt(args, '--commit'))
  out.info(JSON.stringify(r))
  return EXIT.OK
}
