import { describe, it, expect } from 'vitest'
import {
  extractTunnelIdFromToken,
  checkSubdomainDepth,
  extractRootDomain,
} from '../../../cli/plugins/cloudflare/cf-tunnel'

/**
 * Tests for cf-tunnel helpers — token extraction, subdomain validation,
 * domain parsing, and Cloudflare Access detection.
 */

describe('cf-tunnel helpers', () => {
  describe('extractTunnelIdFromToken', () => {
    it('extracts tunnel ID from valid base64 JSON token', () => {
      const payload = { a: 'account-id', t: 'tunnel-id-123', s: 'secret' }
      const token = Buffer.from(JSON.stringify(payload)).toString('base64')
      expect(extractTunnelIdFromToken(token)).toBe('tunnel-id-123')
    })

    it('returns empty string for invalid token', () => {
      expect(extractTunnelIdFromToken('not-base64-json')).toBe('')
    })
  })

  describe('checkSubdomainDepth', () => {
    it('allows 2nd-level subdomain', () => {
      const result = checkSubdomainDepth('app.example.com')
      expect(result.ok).toBe(true)
      expect(result.message).toBeUndefined()
    })

    it('rejects 3rd-level subdomain', () => {
      const result = checkSubdomainDepth('app.dev.sub.example.com')
      expect(result.ok).toBe(false)
      expect(result.message).toBeDefined()
      expect(result.message).toContain('3rd-level subdomain')
    })

    it('allows bare domain', () => {
      const result = checkSubdomainDepth('example.com')
      expect(result.ok).toBe(true)
    })
  })

  describe('extractRootDomain', () => {
    it('extracts root from 2nd-level subdomain', () => {
      expect(extractRootDomain('app.example.com')).toBe('example.com')
    })

    it('extracts root from bare domain', () => {
      expect(extractRootDomain('example.com')).toBe('example.com')
    })

    it('extracts root from deep subdomain', () => {
      expect(extractRootDomain('a.b.c.example.com')).toBe('example.com')
    })
  })

})

describe('cloudflare access config', () => {
  it('defaults: required, refuse on deploy, alert on scan', async () => {
    const { parseAccessConfig } = await import('../../../cli/plugins/cloudflare/index')
    expect(parseAccessConfig(undefined)).toEqual({ required: true, exempt: [], onDeploy: 'refuse', onScan: 'alert' })
  })

  it('rejects unknown keys and bad values', async () => {
    const { parseAccessConfig } = await import('../../../cli/plugins/cloudflare/index')
    expect(() => parseAccessConfig({ requird: true })).toThrow(/access\.requird: unknown key/)
    expect(() => parseAccessConfig({ onScan: 'kill' })).toThrow(/onScan must be alert or stop/)
    expect(() => parseAccessConfig({ exempt: 'hooks.example.com' })).toThrow(/exempt must be a list/)
    expect(() => parseAccessConfig({ required: 'yes' })).toThrow(/required must be true or false/)
  })

  it('writes the settings into the machine manifest at pre-stage', async () => {
    const { register } = await import('../../../cli/plugins/cloudflare/index')
    const plugin = register({ access: { exempt: ['hooks.example.com', 'app.example.com/webhook'], onScan: 'stop' } })
    const ctx: any = { config: { stack: { projectName: 'airstack' } }, manifest: { entries: {} } }
    await plugin.hooks!['pre-stage']!(ctx, {})
    expect(ctx.manifest.entries).toEqual({
      CF_CONTAINER: 'airstack-cloudflared',
      CF_METRICS: '127.0.0.1:20241',
      CF_ACCESS_REQUIRED: 'true',
      CF_ACCESS_EXEMPT: 'hooks.example.com app.example.com/webhook',
      CF_ACCESS_ON_DEPLOY: 'refuse',
      CF_ACCESS_ON_SCAN: 'stop',
    })
  })
})
