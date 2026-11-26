import { describe, expect, it } from 'vitest'
import { findUnit, parseNodeInfo, unitNames } from '../../../cli/node/units'

const MARKER = `
machine: box1
fleet: example-fleet
paths:
  root: /opt/as
  stackUser: deployer
airstack:
  version: 0.2.0
stacks:
  web:
    installDir: /home/dev/web
    user: dev
    userKind: dev
    composeProject: web-prod
  old:
    installDir: /opt/as/stacks/old
    user: deployer
    userKind: stack
    composeProject: old
    orphan: true
  api:
    installDir: /opt/as/stacks/api
    user: deployer
    userKind: stack
    composeProject: api
`

describe('parseNodeInfo', () => {
  it('puts the machine unit first, then stacks, skipping orphans', () => {
    const info = parseNodeInfo(MARKER)
    expect(info).toMatchObject({ machine: 'box1', fleet: 'example-fleet', root: '/opt/as', stackUser: 'deployer', version: '0.2.0' })
    expect(info.units).toEqual([
      { name: 'machine', kind: 'machine', dir: '/opt/as/machine', slot: 'machine', user: 'deployer', userKind: 'stack', project: 'airstack' },
      { name: 'web', kind: 'stack', dir: '/home/dev/web', slot: 'stacks/web', user: 'dev', userKind: 'dev', project: 'web-prod' },
      { name: 'api', kind: 'stack', dir: '/opt/as/stacks/api', slot: 'stacks/api', user: 'deployer', userKind: 'stack', project: 'api' },
    ])
    expect(unitNames(info)).toBe('machine, web, api')
  })

  it('uses defaults when keys are missing', () => {
    for (const text of ['', 'machine: m1\n']) {
      const info = parseNodeInfo(text)
      expect(info.root).toBe('/srv/airstack')
      expect(info.stackUser).toBe('stackroot')
      expect(info.fleet).toBe('')
      expect(info.version).toBeUndefined()
      expect(info.units).toEqual([
        { name: 'machine', kind: 'machine', dir: '/srv/airstack/machine', slot: 'machine', user: 'stackroot', userKind: 'stack', project: 'airstack' },
      ])
    }
    expect(parseNodeInfo('').machine).toBe('unknown')
  })
})

describe('findUnit', () => {
  const info = parseNodeInfo(MARKER)
  it('finds by name; airstack means the machine unit', () => {
    expect(findUnit(info, 'machine')?.slot).toBe('machine')
    expect(findUnit(info, 'airstack')?.slot).toBe('machine')
    expect(findUnit(info, 'web')?.slot).toBe('stacks/web')
  })
  it('answers undefined for unknown or orphan units', () => {
    expect(findUnit(info, 'nope')).toBeUndefined()
    expect(findUnit(info, 'old')).toBeUndefined()
  })
})
