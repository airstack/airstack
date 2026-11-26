import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { loadFleet, loadMachine } from '../../../cli/lib/fleet'
import { buildUnits, MACHINE_UNIT, pluginKey } from '../../../cli/lib/units'

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/fleet-basic')
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'airstack-units-'))
  cpSync(FIXTURE, root, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const units = (only?: string) => {
  const fleet = loadFleet(root)
  return buildUnits(fleet, loadMachine(fleet, 'airstack-test1'), only)
}

describe('buildUnits', () => {
  it('machine unit first, then one unit per instance', () => {
    expect(units().map((u) => `${u.kind}:${u.name}`)).toEqual([
      `machine:${MACHINE_UNIT}`, 'stack:cliproxy', 'stack:devstack', 'stack:teststack', 'stack:wiki',
    ])
  })

  it('--stack keeps the machine unit plus that instance', () => {
    expect(units('devstack').map((u) => u.name)).toEqual([MACHINE_UNIT, 'devstack'])
  })

  it('machine unit: stack user, <root>/machine, machine plugins under legacy keys', () => {
    const m = units()[0]
    expect(m.config.host.appUser).toBe('stackroot')
    expect(m.config.stack.installDir).toBe('/home/deploy/machine')
    expect(m.config.stack.projectName).toBe('airstack')
    expect(Object.keys(m.config.plugins)).toEqual(['cron', 'tailscale'])
    expect(m.deployDir).toBe(join(root, '.airstack/deploy/airstack-test1/airstack'))
  })

  it('stack unit: own project, install dir, run user and values', () => {
    const dev = units().find((u) => u.name === 'devstack')!
    expect(dev.config.host.appUser).toBe('deployuser')
    expect(dev.config.stack).toMatchObject({
      installDir: '/home/deployuser/airstack/devstack', projectName: 'devstack', runUserKind: 'dev', port: 3001,
    })
    expect(dev.projectRoot).toBe(join(root, 'stacks/nodestack'))
    expect(dev.config.templates['docker-compose.yml']).toEqual({ src: 'compose.yaml.hbs' }) // compose.yaml dest aliased
    expect(dev.hasComposeTemplate).toBe(true)
  })

  it('stack crons default to the run user; host crons stay root (machine)', () => {
    const dev = units().find((u) => u.name === 'devstack')!
    expect((dev.config.plugins.cron as any).crons.backup).toEqual({ schedule: '3:00 AM', user: 'deployuser' })
    const m = units()[0]
    expect((m.config.plugins.cron as any).crons.host_alerter.user).toBeUndefined()
  })

  it('an instance without a compose template gets the default stack template', () => {
    const cp = units().find((u) => u.name === 'cliproxy')!
    expect(cp.hasComposeTemplate).toBe(false)
    expect(cp.config.templates['docker-compose.yml']).toEqual({ src: 'templates/compose.stack.yaml.hbs' })
    expect(cp.pluginRefs.map((r) => r.ref)).toEqual(['airstack/cliproxyapi'])
  })

  it('pluginKey strips the built-in prefix only', () => {
    expect(pluginKey('airstack/cron')).toBe('cron')
    expect(pluginKey('hello')).toBe('hello')
  })
})
