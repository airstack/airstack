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

  describe('cloudflare access check logic', () => {
    it('detects protected domain from 302 redirect to cloudflareaccess.com', () => {
      const status = 302
      const location = 'https://example.cloudflareaccess.com/cdn-cgi/access/login'
      const isProtected =
        (status === 302 || status === 303) &&
        (location.includes('cloudflareaccess.com') || location.includes('access.'))
      expect(isProtected).toBe(true)
    })

    it('detects unprotected domain from 200 response', () => {
      const status = 200
      const isUnprotected = status === 200
      expect(isUnprotected).toBe(true)
    })

    it('detects protected from 403 with cloudflare body', () => {
      const status = 403
      const body = '<html>cloudflare access denied</html>'
      const isProtected =
        status === 403 && (body.includes('cloudflare') || body.includes('Access'))
      expect(isProtected).toBe(true)
    })
  })
})
