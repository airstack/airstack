// Fleet root loading: read airstack.yaml, find machine files, and pick target machines.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Plain } from '../merge.js'
import { parseYamlWithRefs } from '../vars.js'
import type { Fleet, Issue, MachineRef } from './types.js'
import { NAME_RE, errMsg, escapeRe, rel } from './util.js'

export function loadFleet(root: string): Fleet {
  root = resolve(root)
  const issues: Issue[] = []
  const markerFile = join(root, 'airstack.yaml')
  let name = ''
  let versionPin: string | undefined
  if (!existsSync(markerFile)) {
    issues.push({ level: 'fail', file: 'airstack.yaml', message: `not found in ${root}` })
  } else {
    try {
      const { data } = parseYamlWithRefs(readFileSync(markerFile, 'utf8'), markerFile)
      const raw = (data ?? {}) as Plain
      const fleet = (raw.fleet ?? {}) as Plain
      const air = (raw.airstack ?? {}) as Plain
      name = typeof fleet.name === 'string' ? fleet.name : ''
      versionPin = air.version !== undefined ? String(air.version) : undefined
      if (!name) issues.push({ level: 'warn', file: 'airstack.yaml', key: 'fleet.name', message: 'not set' })
    } catch (e) {
      issues.push({ level: 'fail', file: 'airstack.yaml', message: errMsg(e) })
    }
  }
  const machines = discoverMachines(root, issues)
  return { root, name: name || 'fleet', versionPin, machines, issues }
}

function discoverMachines(root: string, issues: Issue[]): MachineRef[] {
  const dir = join(root, 'machines')
  if (!existsSync(dir)) return []
  const found = new Map<string, MachineRef[]>()
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry)
    let ref: MachineRef | undefined
    if (entry.endsWith('.yaml') && statSync(p).isFile()) {
      ref = { name: entry.slice(0, -5), file: p }
    } else if (statSync(p).isDirectory() && existsSync(join(p, 'machine.yaml'))) {
      ref = { name: entry, file: join(p, 'machine.yaml'), dir: p }
    } else if (entry.endsWith('.yml')) {
      issues.push({ level: 'fail', file: rel(root, p), message: 'use .yaml, not .yml' })
    }
    if (!ref) continue
    if (!NAME_RE.test(ref.name)) {
      issues.push({ level: 'fail', file: rel(root, ref.file), message: `machine name '${ref.name}' must match ${NAME_RE}` })
      continue
    }
    found.set(ref.name, [...(found.get(ref.name) ?? []), ref])
  }
  const out: MachineRef[] = []
  for (const [name, refs] of found) {
    if (refs.length > 1) {
      issues.push({
        level: 'fail',
        file: `machines/${name}`,
        message: `defined twice: ${refs.map((r) => rel(root, r.file)).join(' and ')}`,
      })
      continue
    }
    out.push(refs[0])
  }
  return out
}

// ── targets ─────────────────────────────────────────────────────────────────

/** Machine names from args (exact names or `*` patterns) or all. */
export function selectTargets(names: string[], args: string[], all: boolean): { selected: string[]; unmatched: string[] } {
  if (all) return { selected: [...names], unmatched: [] }
  const selected = new Set<string>()
  const unmatched: string[] = []
  for (const a of args) {
    if (a.includes('*')) {
      const re = new RegExp('^' + a.split('*').map(escapeRe).join('.*') + '$')
      const hits = names.filter((n) => re.test(n))
      if (hits.length === 0) unmatched.push(a)
      hits.forEach((h) => selected.add(h))
    } else if (names.includes(a)) {
      selected.add(a)
    } else {
      unmatched.push(a)
    }
  }
  return { selected: names.filter((n) => selected.has(n)), unmatched }
}
