// CLI-level tests: run the real entry point with Bun (plugin loading and the `airstack`
// virtual module need Bun; vitest itself runs under Node).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const CLI = resolve(import.meta.dirname, '../../cli/index.ts')
const FIXTURE = resolve(import.meta.dirname, '../fixtures/fleet-basic')

const run = (args: string[], cwd: string) => {
  const r = spawnSync('bun', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  return { code: r.status, out: r.stdout }
}

let root: string
let elsewhere: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'airstack-cli-'))
  cpSync(FIXTURE, root, { recursive: true })
  elsewhere = mkdtempSync(join(tmpdir(), 'airstack-nofleet-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

describe('airstack CLI', () => {
  it('fleet check passes on the fixture (loads the fleet plugin that imports airstack)', () => {
    const r = run(['fleet', 'check'], root)
    expect(r.out).toContain('ok   airstack-test1: 4 stack instance(s), 2 machine plugin(s)')
    expect(r.out).not.toMatch(/^fail/m)
    expect(r.code).toBe(0)
  })

  it('fleet check reports scope violations and exits 2', () => {
    writeFileSync(join(root, 'machines/ops2/machine.yaml'),
      'machine: ops2\nhost: { ip: 203.0.113.20 }\nplugins:\n  airstack/backup: {}\nstacks:\n  wiki:\n    plugins:\n      airstack/tailscale: {}\n')
    const r = run(['fleet', 'check', 'ops2'], root)
    expect(r.out).toContain('airstack/backup is a stack-level plugin and cannot be configured on a machine')
    expect(r.out).toContain('airstack/tailscale is a machine-level plugin and cannot be configured on a stack')
    expect(r.code).toBe(2)
  })

  it('a fleet plugin without a scope gets a warning (exit 1)', () => {
    mkdirSync(join(root, 'plugins/noscope'))
    writeFileSync(join(root, 'plugins/noscope/index.ts'), 'export function register() { return { name: "noscope" } }\n')
    writeFileSync(join(root, 'machines/ops2/machine.yaml'), 'machine: ops2\nhost: { ip: 203.0.113.20 }\nplugins:\n  noscope: {}\n')
    const r = run(['fleet', 'check', 'ops2'], root)
    expect(r.out).toMatch(/^warn .*noscope declares no scope/m)
    expect(r.code).toBe(1)
  })

  it('fleet config never prints secrets', () => {
    const r = run(['fleet', 'config', 'airstack-test1'], root)
    expect(r.out).toContain('${HOSTALERT_TELEGRAM_BOT_TOKEN}')
    expect(r.out).toContain('${TEST1_IP}')
    expect(r.out).not.toContain('fake: token')
    expect(r.out).not.toContain('192.168.139.10')
    for (const v of [['fleet', 'list'], ['fleet', 'show', 'airstack-test1']]) expect(run(v, root).out).not.toContain('192.168.139.10')
  })

  it('outside a fleet, fleet verbs are blocked with exit 3 and a hint', () => {
    const r = run(['fleet', 'list'], elsewhere)
    expect(r.code).toBe(3)
    expect(r.out).toMatch(/^fail blocked: fleet needs a fleet/m)
    expect(r.out).toMatch(/^-> {3}airstack --fleet <path> fleet/m)
  })

  it('--fleet points at a fleet from anywhere; whoami reports it', () => {
    expect(run(['--fleet', root, 'fleet', 'list'], elsewhere).code).toBe(0)
    const w = run(['whoami', '--fleet', root], elsewhere)
    expect(w.out).toMatch(/^mode +controller/m)
    expect(w.out).toContain(`${root}  (flag)`)
  })

  it('AIRSTACK_DISABLE turns a verb off', () => {
    const r = spawnSync('bun', [CLI, 'fleet', 'list'], { cwd: root, encoding: 'utf8', env: { ...process.env, AIRSTACK_DISABLE: 'fleet' } })
    expect(r.status).toBe(3)
    expect(r.stdout).toMatch(/fleet is disabled \(AIRSTACK_DISABLE\)/)
  })

  it('unknown verbs exit 3', () => {
    const r = run(['frobnicate'], elsewhere)
    expect(r.code).toBe(3)
    expect(r.out).toMatch(/unknown verb: frobnicate/)
  })
})
