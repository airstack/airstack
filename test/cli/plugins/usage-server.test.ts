import { describe, it, expect } from 'vitest'
import {
  compareVersions, maxVersion, newestDeployed, parseVersion, resolveUsageServer, shq,
} from '../../../cli/plugins/cliproxyapi/usage-server'
import { USAGE_SERVER_PIN } from '../../../cli/plugins/cliproxyapi/usage-server-pin'

describe('usage-server versions', () => {
  it('parses and compares numerically', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('dev')).toBeNull()
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0)
  })
  it('maxVersion ignores junk', () => {
    expect(maxVersion(['', 'dev', '0.1.0', 'v0.3.1', '0.2.9'])).toBe('0.3.1')
    expect(maxVersion(['', 'dev'])).toBeUndefined()
  })
  it('newestDeployed looks at every source', () => {
    const base = { runningImageVersion: '', localImageTags: [], pluginStatusVersion: '', markerVersion: '', soExists: false, imageForPinExists: false }
    expect(newestDeployed({ ...base, localImageTags: ['0.1.0', 'dev'], pluginStatusVersion: '0.2.0' })).toBe('0.2.0')
    expect(newestDeployed(base)).toBeUndefined()
  })
})

describe('resolveUsageServer', () => {
  it('is disabled without a block', () => {
    expect(resolveUsageServer(undefined)).toBeNull()
  })
  it('fills defaults into the shared object', () => {
    const raw: Record<string, unknown> = { uid: 1002, gid: 1002, transcriptsDir: '/t' }
    const us = resolveUsageServer(raw)!
    expect(us.version).toBe(USAGE_SERVER_PIN)
    expect(raw.version).toBe(USAGE_SERVER_PIN)
    expect(us.port).toBe(18090)
  })
  it('requires uid, gid and transcriptsDir', () => {
    expect(() => resolveUsageServer({ gid: 1, transcriptsDir: '/t' })).toThrow(/uid/)
    expect(() => resolveUsageServer({ uid: 1, gid: 1 })).toThrow(/transcriptsDir/)
    expect(() => resolveUsageServer({ uid: 1, gid: 1, transcriptsDir: '/t', version: 'main' })).toThrow(/1\.2\.3/)
  })
})

describe('shq', () => {
  it('escapes single quotes', () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`)
  })
})
