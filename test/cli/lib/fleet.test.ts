import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { loadFleet, loadMachine, selectTargets, resolveStackRef, resolvePluginRef } from '../../../cli/lib/fleet'

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/fleet-basic')

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'airstack-fleet-'))
  cpSync(FIXTURE, root, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const write = (rel: string, body: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), body)
}
const fails = (issues: { level: string; message: string; key?: string }[]) =>
  issues.filter((i) => i.level === 'fail').map((i) => `${i.key ?? ''}: ${i.message}`)

describe('fleet discovery', () => {
  it('finds both machine forms and reads the fleet marker', () => {
    const f = loadFleet(root)
    expect(f.name).toBe('example-fleet')
    expect(f.versionPin).toBe('0.1.0')
    expect(f.machines.map((m) => m.name)).toEqual(['airstack-test1', 'ops2'])
    expect(f.machines.find((m) => m.name === 'ops2')?.dir).toBe(join(root, 'machines/ops2'))
    expect(f.issues).toEqual([])
  })

  it('a machine defined in both forms is an error and is skipped', () => {
    write('machines/ops2.yaml', 'machine: ops2\nhost: { ip: 203.0.113.21 }\n')
    const f = loadFleet(root)
    expect(f.issues.map((i) => i.message).join()).toMatch(/defined twice/)
    expect(f.machines.map((m) => m.name)).toEqual(['airstack-test1'])
  })

  it('.yml is rejected; bad names are rejected', () => {
    write('machines/old.yml', 'machine: old\n')
    write('machines/Bad_Name.yaml', 'machine: Bad_Name\n')
    const msgs = loadFleet(root).issues.map((i) => i.message).join('\n')
    expect(msgs).toMatch(/use \.yaml/)
    expect(msgs).toMatch(/machine name 'Bad_Name'/)
  })

  it('missing airstack.yaml fails', () => {
    rmSync(join(root, 'airstack.yaml'))
    expect(fails(loadFleet(root).issues).join()).toMatch(/not found/)
  })
})

describe('machine loading', () => {
  it('resolves instances, refs, users, install dirs and secrets', () => {
    const m = loadMachine(loadFleet(root), 'airstack-test1')
    expect(fails(m.issues)).toEqual([])
    expect(m.host.ip).toBe('192.168.139.10')
    const byName = Object.fromEntries(m.instances.map((i) => [i.name, i]))
    expect(byName.cliproxy).toMatchObject({ ref: 'airstack/cliproxy', source: 'builtin', user: 'stackroot', installDir: '/home/deploy/stacks/cliproxy' })
    expect(byName.devstack).toMatchObject({ ref: 'nodestack', source: 'fleet', userKind: 'dev', installDir: '/home/deployuser/airstack/devstack' })
    expect((byName.devstack.config.values as any).port).toBe(3001)
    expect((byName.teststack.config.values as any).port).toBe(3002)
    expect((byName.teststack.config.values as any).greeting).toBeUndefined() // null deleted it
    expect((byName.devstack.config.values as any).apiKey).toBe('dev-key') // default used
    expect(byName.wiki.ref).toBe('wiki')
  })

  it('secrets keep their exact value and never reach display trees', () => {
    const m = loadMachine(loadFleet(root), 'airstack-test1')
    const env = (m.plugins['airstack/cron'] as any).crons.host_alerter.env
    expect(env.TELEGRAM_BOT_TOKEN).toBe('fake: token # with\nnewline')
    expect(env.TELEGRAM_CHAT_ID).toBe('123456789') // from _fleet.jsonc
    const shown = JSON.stringify(m.displayPlugins) + JSON.stringify(m.instances.map((i) => i.display))
    expect(shown).not.toContain('fake: token')
    expect(shown).toContain('${HOSTALERT_TELEGRAM_BOT_TOKEN}')
    expect(m.secretsUsed).toContain('HOSTALERT_TELEGRAM_BOT_TOKEN')
  })

  it('records origins for fleet config', () => {
    const inst = loadMachine(loadFleet(root), 'airstack-test1').instances.find((i) => i.name === 'teststack')!
    expect(inst.origins.get('values.port')).toBe('machine:machines/airstack-test1.yaml')
    expect(inst.origins.get('values.apiKey')).toBe('stack:stacks/nodestack/stack.yaml')
    expect(inst.origins.get('installDir')).toBe('default')
  })

  it('machine key must match the file name', () => {
    write('machines/ops2/machine.yaml', 'machine: ops3\nhost: { ip: 203.0.113.20 }\n')
    expect(fails(loadMachine(loadFleet(root), 'ops2').issues).join()).toMatch(/must equal the file name 'ops2'/)
  })

  it('lists every missing secret with the files that reference it', () => {
    rmSync(join(root, '.airstack/secrets/airstack-test1.jsonc'))
    const f = fails(loadMachine(loadFleet(root), 'airstack-test1').issues).join('\n')
    expect(f).toMatch(/TEST1_IP: missing secret \(referenced in machines\/airstack-test1\.yaml/)
    expect(f).toMatch(/HOSTALERT_TELEGRAM_BOT_TOKEN: missing secret/)
    expect(f).not.toMatch(/COMMENTED_OUT_SECRET/)
  })

  it('a bare stack name never falls back to a built-in', () => {
    write('machines/ops2/machine.yaml', 'machine: ops2\nhost: { ip: 203.0.113.20 }\nstacks:\n  cliproxy: {}\n')
    expect(fails(loadMachine(loadFleet(root), 'ops2').issues).join()).toMatch(/did you mean airstack\/cliproxy/)
  })

  it('a bare plugin name never falls back to a built-in', () => {
    write('machines/ops2/machine.yaml', 'machine: ops2\nhost: { ip: 203.0.113.20 }\nplugins:\n  cron: {}\n')
    expect(fails(loadMachine(loadFleet(root), 'ops2').issues).join()).toMatch(/plugin 'cron' not found .*did you mean airstack\/cron/)
  })

  it('stacks must be a map, not a list', () => {
    write('machines/ops2/machine.yaml', 'machine: ops2\nhost: { ip: 203.0.113.20 }\nstacks:\n  - name: wiki\n')
    expect(fails(loadMachine(loadFleet(root), 'ops2').issues).join()).toMatch(/must be a map/)
  })

  it('duplicate instance names are a YAML error', () => {
    write('machines/ops2/machine.yaml', 'machine: ops2\nhost: { ip: 203.0.113.20 }\nstacks:\n  wiki: {}\n  wiki: {}\n')
    expect(fails(loadMachine(loadFleet(root), 'ops2').issues).join()).toMatch(/duplicat/i)
  })

  it('run user must be the stack user or a dev user', () => {
    write('machines/ops2/machine.yaml', 'machine: ops2\nhost: { ip: 203.0.113.20 }\nstacks:\n  wiki: { user: mallory }\n')
    expect(fails(loadMachine(loadFleet(root), 'ops2').issues).join()).toMatch(/'mallory' is neither/)
  })

  it('a dev-user stack cannot live under the machine root', () => {
    const p = join(root, 'machines/airstack-test1.yaml')
    writeFileSync(p, readFileSync(p, 'utf8').replace('values: { port: 3001 }', 'values: { port: 3001 }\n    installDir: /home/deploy/devstack'))
    expect(fails(loadMachine(loadFleet(root), 'airstack-test1').issues).join()).toMatch(/dev-user stack cannot live under \/home\/deploy/)
  })

  it('host_ crons are machine-level only', () => {
    write('stacks/wiki/stack.yaml', 'plugins:\n  airstack/cron:\n    crons:\n      host_alerter: "9:00 AM"\n')
    expect(fails(loadMachine(loadFleet(root), 'ops2').issues).join()).toMatch(/host_ crons are machine-level only/)
  })

  it('versioned and marketplace references are reserved', () => {
    write('machines/ops2/machine.yaml', 'machine: ops2\nhost: { ip: 203.0.113.20 }\nstacks:\n  a: { stack: airstack/cliproxy@1.0 }\n  b: { stack: acme/thing }\n')
    const f = fails(loadMachine(loadFleet(root), 'ops2').issues).join('\n')
    expect(f).toMatch(/versioned references are not supported yet/)
    expect(f).toMatch(/marketplace references are not supported yet/)
  })

  it('invalid secrets JSONC is reported', () => {
    write('.airstack/secrets/ops2.jsonc', '{ "A": "x" ')
    expect(fails(loadMachine(loadFleet(root), 'ops2').issues).join()).toMatch(/JSONC error/)
  })
})

describe('references and targets', () => {
  it('resolves built-in and fleet refs', () => {
    expect(resolveStackRef(root, 'airstack/cliproxy')).toMatchObject({ ok: true, source: 'builtin' })
    expect(resolveStackRef(root, 'nodestack')).toMatchObject({ ok: true, source: 'fleet' })
    expect(resolvePluginRef(root, 'airstack/tailscale')).toMatchObject({ ok: true, source: 'builtin' })
    expect(resolvePluginRef(root, 'hello')).toMatchObject({ ok: true, source: 'fleet' })
    expect(resolvePluginRef(root, 'airstack/nope')).toMatchObject({ ok: false })
  })

  it('selects machines by name, pattern or --all', () => {
    const names = ['airstack-test1', 'airstack-test2', 'ops2']
    expect(selectTargets(names, ['airstack-*'], false)).toEqual({ selected: ['airstack-test1', 'airstack-test2'], unmatched: [] })
    expect(selectTargets(names, ['ops2', 'nope', 'x*'], false)).toEqual({ selected: ['ops2'], unmatched: ['nope', 'x*'] })
    expect(selectTargets(names, [], true).selected).toEqual(names)
  })
})
