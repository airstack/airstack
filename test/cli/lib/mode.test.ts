import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveMode, checkVerb, type VerbSpec } from '../../../cli/lib/mode'

// The marker must be "root-owned"; in tests the current uid stands in for root.
const UID = process.getuid!()
const DEPLOY: VerbSpec = { name: 'deploy', requires: 'controller', needsFleet: true, mutating: true }
const FLEET: VerbSpec = { name: 'fleet', requires: 'controller', needsFleet: true }
const STATUS: VerbSpec = { name: 'machine status', requires: 'node' }
const RESTART: VerbSpec = { name: 'machine restart', requires: 'node', mutating: true }
const WHOAMI: VerbSpec = { name: 'whoami', requires: 'any' }

let t: string, etc: string, conf: string, cwd: string
beforeEach(() => {
  t = mkdtempSync(join(tmpdir(), 'airstack-mode-'))
  etc = join(t, 'etc-airstack')
  conf = join(t, 'config')
  cwd = join(t, 'work')
  mkdirSync(cwd)
})
afterEach(() => rmSync(t, { recursive: true, force: true }))

const marker = (body: string, mode = 0o644) => {
  mkdirSync(etc, { recursive: true, mode: 0o755 })
  chmodSync(etc, 0o755)
  writeFileSync(join(etc, 'machine.yaml'), body)
  chmodSync(join(etc, 'machine.yaml'), mode)
}
const resolve = (extra: Record<string, unknown> = {}) =>
  resolveMode({ cwd, etcDir: etc, configDir: conf, expectedOwnerUid: UID, env: {}, ...extra })

describe('controller mode (no marker)', () => {
  it('no fleet: deploy and fleet blocked, node verbs blocked, whoami ok', () => {
    const m = resolve()
    expect(m.mode).toBe('controller')
    expect(checkVerb(m, WHOAMI).ok).toBe(true)
    const d = checkVerb(m, DEPLOY)
    expect(d.ok).toBe(false)
    expect(!d.ok && d.reason).toMatch(/needs a fleet/)
    const s = checkVerb(m, STATUS)
    expect(!s.ok && s.reason).toMatch(/airstack ssh <machine> -- airstack machine status/)
  })

  it('fleet from ./airstack.yaml, never from a parent dir', () => {
    writeFileSync(join(t, 'airstack.yaml'), 'fleet: { name: parent }\n')
    expect(resolve().fleetPath).toBeUndefined()
    writeFileSync(join(cwd, 'airstack.yaml'), 'fleet: { name: here }\n')
    const m = resolve()
    expect(m.fleetPath).toBe(cwd)
    expect(m.fleetSource).toBe('cwd')
    expect(checkVerb(m, DEPLOY).ok).toBe(true)
  })

  it('--fleet flag wins; user config fleet is the fallback', () => {
    mkdirSync(conf)
    writeFileSync(join(conf, 'config.yaml'), `fleet: ${join(t, 'f')}\n`)
    expect(resolve().fleetSource).toBe('config')
    expect(resolve({ fleetFlag: '../x' }).fleetPath).toBe(join(t, 'x'))
  })

  it('user config and AIRSTACK_DISABLE can only turn verbs off', () => {
    mkdirSync(conf)
    writeFileSync(join(conf, 'config.yaml'), 'disable: [deploy]\nroles: [node, controller]\n')
    writeFileSync(join(cwd, 'airstack.yaml'), '')
    const m = resolve({ env: { AIRSTACK_DISABLE: 'fleet' } })
    expect(m.mode).toBe('controller') // a `roles:` key in user config is ignored
    expect(checkVerb(m, DEPLOY)).toMatchObject({ ok: false })
    expect(checkVerb(m, FLEET)).toMatchObject({ ok: false })
  })
})

describe('node mode (marker present)', () => {
  it('roles [node]: controller verbs blocked even with a fleet clone in cwd', () => {
    marker('machine: n1\nroles: [node]\n')
    writeFileSync(join(cwd, 'airstack.yaml'), 'fleet: { name: clone }\n')
    const m = resolve()
    expect(m.mode).toBe('node')
    expect(m.fleetPath).toBeUndefined()
    expect(m.fleetNote).toMatch(/ignored \.\/airstack\.yaml/)
    const d = checkVerb(m, DEPLOY)
    expect(!d.ok && d.reason).toMatch(/needs controller role .*roles: \[node\]/)
    expect(checkVerb(m, STATUS).ok).toBe(true)
    expect(checkVerb(m, RESTART).ok).toBe(true)
  })

  it('a --fleet flag cannot add a fleet on a node', () => {
    marker('machine: n1\nroles: [node]\n')
    expect(resolve({ fleetFlag: cwd }).fleetPath).toBeUndefined()
  })

  it('roles [node, controller]: fleet is only the pinned path', () => {
    marker(`machine: ops\nroles: [node, controller]\ncontroller:\n  fleet: ${join(t, 'pinned')}\n`)
    writeFileSync(join(cwd, 'airstack.yaml'), '')
    const m = resolve()
    expect(m.fleetPath).toBe(join(t, 'pinned'))
    expect(m.fleetSource).toBe('pinned')
    expect(checkVerb(m, DEPLOY).ok).toBe(true)
  })

  it('a writable marker is untrusted: mutating verbs refused, roles fall back to node', () => {
    marker('machine: n1\nroles: [node, controller]\ncontroller: { fleet: /x }\n', 0o666)
    const m = resolve()
    expect(m.marker?.problem).toMatch(/group\/world writable/)
    expect(m.roles).toEqual(['node'])
    expect(checkVerb(m, RESTART)).toMatchObject({ ok: false })
    expect(checkVerb(m, STATUS).ok).toBe(true) // read-only verbs still work
  })

  it('a marker owned by someone else is untrusted', () => {
    marker('machine: n1\n')
    const m = resolveMode({ cwd, etcDir: etc, configDir: conf, expectedOwnerUid: UID + 1, env: {} })
    expect(m.marker?.problem).toMatch(/owned by uid/)
  })

  it('unknown roles make the marker untrusted', () => {
    marker('roles: [node, superuser]\n')
    expect(resolve().marker?.problem).toMatch(/unknown roles/)
  })
})
