import { describe, expect, it } from 'vitest'
import {
  checkRoutes, classify, isExempt, parseAccessConfig, parseIngress, probePath, violations, type ProbeAnswer,
} from '../../../cli/plugins/cloudflare/access'
import { accessGuard } from '../../../cli/plugins/cloudflare/deploy-guard'
import type { DeployContext } from '../../../cli/types'
import { nullLogger } from '../helpers'

const LOGIN = 'https://team.cloudflareaccess.com/cdn-cgi/access/login/app.example.com?kid=x'
const answer = (code: number, location = '', access403 = false): ProbeAnswer => ({ code, location, access403 })

describe('classify (same rules as host_security.sh --access)', () => {
  it('a redirect to the Access login page or the Access 403 page is protected', () => {
    expect(classify(answer(302, LOGIN))).toBe('protected')
    expect(classify(answer(307, LOGIN))).toBe('protected')
    expect(classify(answer(403, '', true))).toBe('protected')
  })
  it('no answer and Cloudflare/tunnel 5xx are unknown, never public', () => {
    for (const c of [0, 502, 503, 504, 520, 525, 530]) expect(classify(answer(c))).toBe('unknown')
  })
  it('everything else is unprotected', () => {
    expect(classify(answer(200))).toBe('unprotected')
    expect(classify(answer(401))).toBe('unprotected')
    expect(classify(answer(403))).toBe('unprotected')
    expect(classify(answer(302, 'https://evil.example.com/cdn-cgi/access/login'))).toBe('unprotected')
    expect(classify(answer(302, 'http://team.cloudflareaccess.com/cdn-cgi/access/login'))).toBe('unprotected')
  })
})

describe('parseIngress', () => {
  it('reads cloudflared /config and drops catch-all rules', () => {
    const json = JSON.stringify({ version: 3, config: { ingress: [
      { hostname: 'app.example.com', path: null, service: 'http://localhost:8317' },
      { hostname: 'app.example.com', path: '^/admin/.*', service: 'http://localhost:9000' },
      { service: 'http_status:404' },
    ] } })
    expect(parseIngress(json)).toEqual([
      { hostname: 'app.example.com', path: '', service: 'http://localhost:8317' },
      { hostname: 'app.example.com', path: '^/admin/.*', service: 'http://localhost:9000' },
    ])
  })
  it('answers undefined for anything that is not a config', () => {
    expect(parseIngress('')).toBeUndefined()
    expect(parseIngress('{"version":1}')).toBeUndefined()
    expect(parseIngress('404 page not found')).toBeUndefined()
  })
})

describe('probePath and exemptions', () => {
  it('turns a path rule into its literal prefix', () => {
    expect(probePath('')).toBe('/')
    expect(probePath('^/admin/.*')).toBe('/admin/')
    expect(probePath('/hooks/(a|b)')).toBe('/hooks/')
    expect(probePath('api')).toBe('/api')
  })
  it('matches hostname or hostname/path entries', () => {
    expect(isExempt(['hooks.example.com'], 'hooks.example.com', '/')).toBe(true)
    expect(isExempt(['app.example.com/webhook'], 'app.example.com', '/webhook/')).toBe(true)
    expect(isExempt(['app.example.com/webhook'], 'app.example.com', '/')).toBe(false)
  })
})

describe('checkRoutes + violations', () => {
  const rules = [
    { hostname: 'a.example.com', path: '', service: 'http://localhost:1' },
    { hostname: 'b.example.com', path: '', service: 'http://localhost:2' },
    { hostname: 'c.example.com', path: '', service: 'http://localhost:3' },
    { hostname: 'd.example.com', path: '', service: 'http://localhost:4' },
  ]
  const probe = async (url: string) => ({
    'https://a.example.com/': answer(302, LOGIN),
    'https://b.example.com/': answer(200),
    'https://c.example.com/': answer(0),
    'https://d.example.com/': answer(200),
  }[url] ?? answer(0))

  it('reports public routes that are not exempt', async () => {
    const cfg = parseAccessConfig({ exempt: ['d.example.com'] })
    const results = await checkRoutes(rules, cfg, probe)
    expect(results.map((r) => r.state)).toEqual(['protected', 'unprotected', 'unknown', 'unprotected'])
    expect(violations(results, cfg).map((r) => r.label)).toEqual(['b.example.com'])
  })
  it('access.required: false never reports a violation', async () => {
    const cfg = parseAccessConfig({ required: false })
    expect(violations(await checkRoutes(rules, cfg, probe), cfg)).toEqual([])
  })
})

describe('accessGuard (deploy)', () => {
  const config = JSON.stringify({ config: { ingress: [{ hostname: 'app.example.com', service: 'http://localhost:8317' }, { service: 'http_status:404' }] } })

  function ctx(configJson: string | null) {
    const cmds: string[] = []
    const c = {
      config: { host: { appUser: 'stackuser' }, stack: { installDir: '/srv/airstack/machine', projectName: 'airstack', runUserKind: 'stack' } },
      compose: { skip: false },
      errors: [],
      log: nullLogger,
      remote: {
        run: async (cmd: string) => {
          cmds.push(cmd)
          if (cmd.startsWith('curl')) return configJson === null ? { stdout: '', stderr: '', exitCode: 7 } : { stdout: configJson, stderr: '', exitCode: 0 }
          return { stdout: '', stderr: '', exitCode: 0 }
        },
        rsync: async () => ({ exitCode: 0 }),
      },
    } as unknown as DeployContext
    return { c, cmds }
  }
  const opts = (code: number, location = '') => ({ probe: async () => answer(code, location), tries: 2, sleep: async () => {} })

  it('a protected route passes without errors', async () => {
    const { c, cmds } = ctx(config)
    await accessGuard(c, parseAccessConfig({}), opts(302, LOGIN))
    expect(c.errors).toEqual([])
    expect(cmds.some((x) => x.includes('stop cloudflared'))).toBe(false)
  })
  it('refuse: stops cloudflared and fails, naming the route', async () => {
    const { c, cmds } = ctx(config)
    await accessGuard(c, parseAccessConfig({}), opts(200))
    expect(cmds.some((x) => x.includes('docker compose -p airstack stop cloudflared'))).toBe(true)
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]).toMatchObject({ fatal: true, phase: 'post-deploy' })
    expect(c.errors[0].message).toMatch(/app\.example\.com \(HTTP 200 → http:\/\/localhost:8317\); cloudflared is stopped/)
  })
  it('warn: keeps the tunnel up and adds a warning', async () => {
    const { c, cmds } = ctx(config)
    await accessGuard(c, parseAccessConfig({ onDeploy: 'warn' }), opts(200))
    expect(cmds.some((x) => x.includes('stop cloudflared'))).toBe(false)
    expect(c.errors[0]).toMatchObject({ fatal: false })
  })
  it('an unknown route or unreadable routes only warn', async () => {
    const a = ctx(config)
    await accessGuard(a.c, parseAccessConfig({}), opts(530))
    expect(a.c.errors.map((e) => e.fatal)).toEqual([false])
    const b = ctx(null)
    await accessGuard(b.c, parseAccessConfig({}), opts(200))
    expect(b.c.errors[0].message).toMatch(/cannot read the tunnel routes/)
    expect(b.c.errors[0].fatal).toBe(false)
  })
})

describe('accessGuard retries an unknown route once', () => {
  it('a route that times out first and answers next is protected, no warning', async () => {
    let calls = 0
    const probe = async () => (++calls === 1 ? answer(0) : answer(302, LOGIN))
    const json = JSON.stringify({ config: { ingress: [{ hostname: 'app.example.com', service: 'http://localhost:1' }] } })
    const c = {
      config: { host: { appUser: 'u' }, stack: { installDir: '/d', projectName: 'airstack', runUserKind: 'stack' } },
      compose: { skip: false }, errors: [], log: nullLogger,
      remote: { run: async () => ({ stdout: json, stderr: '', exitCode: 0 }), rsync: async () => ({ exitCode: 0 }) },
    } as unknown as DeployContext
    await accessGuard(c, parseAccessConfig({}), { probe, tries: 1, sleep: async () => {} })
    expect(calls).toBe(2)
    expect(c.errors).toEqual([])
  })
})
