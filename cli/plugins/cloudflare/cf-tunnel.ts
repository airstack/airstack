/**
 * cf-tunnel.ts — Cloudflare Tunnel helpers and command functions.
 *
 * Helpers: API calls, token parsing, domain validation, output.
 * Commands: verify, verify-api-token, list-tunnels, create-tunnel.
 *
 * Route + Access setup is not automated here yet: stacks will declare their tunnel routes
 * (plans/phase-1.md). Until then, routes are managed in the Cloudflare dashboard and `verify`
 * checks every hostname the tunnel serves.
 */

import type { PluginCommandContext } from '../../types.js'

/**
 * Extract root domain from a full domain (e.g. app.example.com -> example.com).
 */
export function extractRootDomain(domain: string): string {
  const parts = domain.split('.')
  return parts.slice(-2).join('.')
}

// ── Constants ────────────────────────────────────────────────────────────────

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

// ── API ──────────────────────────────────────────────────────────────────────

export async function cfApi(
  token: string,
  method: string,
  endpoint: string,
  data?: unknown,
  opts?: { silent?: boolean },
): Promise<any> {
  if (!token) return null

  const fetchOpts: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }
  if (data) fetchOpts.body = JSON.stringify(data)

  const resp = await fetch(`${CF_API_BASE}${endpoint}`, fetchOpts)
  const json = (await resp.json()) as {
    success: boolean
    result?: any
    errors?: { message: string }[]
  }

  if (!json.success) {
    if (!opts?.silent) {
      const errors = json.errors?.map((e) => e.message).join(', ') || 'unknown error'
      console.error(`Cloudflare API error (${method} ${endpoint}): ${errors}`)
    }
    return null
  }
  return json
}

// ── Token / Account helpers ──────────────────────────────────────────────────

/**
 * Get the account ID. Tries multiple sources in order:
 * 1. Tunnel token (if available — always has account ID embedded)
 * 2. /accounts API (works for user-level API tokens)
 * 3. wrangler whoami --json (works for account-level API tokens via CLOUDFLARE_API_TOKEN env)
 */
export async function getAccountId(token: string, tunnelToken?: string): Promise<string> {
  // 1. Try tunnel token first (works regardless of API token type)
  if (tunnelToken) {
    try {
      const decoded = Buffer.from(tunnelToken, 'base64').toString()
      const id = JSON.parse(decoded).a || ''
      if (id) return id
    } catch {}
  }

  // 2. Try /accounts API (works for user-level tokens)
  const resp = await cfApi(token, 'GET', '/accounts?per_page=1', undefined, { silent: true })
  if (resp?.result?.[0]?.id) return resp.result[0].id

  // 3. Fall back to wrangler whoami (works for account-level tokens)
  try {
    const proc = Bun.spawn(['npx', 'wrangler', 'whoami', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const parsed = JSON.parse(stdout)
    // wrangler whoami returns { accounts: [{ id, name }] } or similar
    const accounts = parsed.accounts || parsed.result || []
    if (Array.isArray(accounts) && accounts[0]?.id) return accounts[0].id
  } catch {}

  return ''
}

/**
 * Extract tunnel ID from a Cloudflare tunnel token (base64-encoded JSON with `.t` field).
 */
export function extractTunnelIdFromToken(token: string): string {
  try {
    const decoded = Buffer.from(token, 'base64').toString()
    const parsed = JSON.parse(decoded)
    return parsed.t || ''
  } catch {
    return ''
  }
}

// ── Domain validation ────────────────────────────────────────────────────────

/**
 * Check if a domain is a 3rd-level (or deeper) subdomain.
 * Cloudflare free SSL only covers *.example.com — not *.sub.example.com.
 */
export function checkSubdomainDepth(domain: string): { ok: boolean; message?: string } {
  const dots = domain.split('.').length - 1
  if (dots >= 3) {
    return {
      ok: false,
      message:
        `'${domain}' is a 3rd-level subdomain. ` +
        `Cloudflare free SSL only covers *.example.com (2nd-level). ` +
        `Use a 2nd-level subdomain instead.`,
    }
  }
  return { ok: true }
}

// ── Cloudflare Access check ──────────────────────────────────────────────────

/**
 * Check if a domain is protected by Cloudflare Access.
 * Makes a fetch request and checks for 302/403 redirect to cloudflareaccess.com.
 * Returns: 'protected' | 'unprotected' | error description
 */
export async function checkCloudflareAccess(urlOrDomain: string): Promise<string> {
  try {
    const url = urlOrDomain.startsWith('https://') ? urlOrDomain : `https://${urlOrDomain}`
    const resp = await fetch(url.endsWith('/') ? url : url + '/', {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    })

    // 302/303 with Location containing cloudflareaccess = protected
    const location = resp.headers.get('location') || ''
    if (
      (resp.status === 302 || resp.status === 303) &&
      (location.includes('cloudflareaccess.com') || location.includes('access.'))
    ) {
      return 'protected'
    }

    // 403 from Cloudflare Access
    if (resp.status === 403) {
      const body = await resp.text()
      if (body.includes('cloudflare') || body.includes('Access')) return 'protected'
    }

    // 200 or other status = not protected
    if (resp.status === 200) return 'unprotected'

    return `HTTP ${resp.status}`
  } catch (e: any) {
    if (e?.name === 'TimeoutError') return 'timeout'
    if (e?.code === 'ENOTFOUND') return 'DNS not configured'
    return e?.message || 'unknown error'
  }
}

// ── Output helpers ───────────────────────────────────────────────────────────

export function die(msg: string): never {
  console.error(`\x1b[31mERROR: ${msg}\x1b[0m`)
  process.exit(1)
}

export function info(msg: string) {
  console.log(`  ${msg}`)
}

export function pass(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
}

export function fail(msg: string) {
  console.warn(`  \x1b[31m✗\x1b[0m ${msg}`)
}

export function header(msg: string) {
  console.log(`\n\x1b[36m=== ${msg} ===\x1b[0m`)
}

// ── Interactive prompt ───────────────────────────────────────────────────────

export async function promptForInput(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  const reader = Bun.stdin.stream().getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return new TextDecoder().decode(value).trim()
}

// ── Config accessor ──────────────────────────────────────────────────────────

function getCloudflareConfig(ctx: PluginCommandContext) {
  const cfPlugin = (ctx.config.plugins?.cloudflare || {}) as Record<string, unknown>
  const cfStack = (ctx.config.stack as any).cloudflared as Record<string, unknown> | undefined
  return {
    apiToken: String(cfPlugin.apiToken || ''),
    tunnelToken: String(cfStack?.tunnelToken || ''),
  }
}

/** Hostname ingress rules of a tunnel (empty when the API token cannot read them). */
async function getIngressRules(
  apiToken: string,
  accountId: string,
  tunnelId: string,
): Promise<{ hostname: string; path?: string; service: string }[] | null> {
  const tunnelConfig = await cfApi(
    apiToken,
    'GET',
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
  )
  const ingress = tunnelConfig?.result?.config?.ingress
  if (!Array.isArray(ingress)) return null
  return ingress.filter((r: any) => r.hostname)
}

// ── Command functions ────────────────────────────────────────────────────────

/**
 * Verify that the Cloudflare API token has the required permissions.
 */
export async function cmdVerifyApiToken(ctx: PluginCommandContext) {
  const cf = getCloudflareConfig(ctx)
  if (!cf.apiToken) die('plugins.cloudflare.apiToken not set')
  header('Verifying CF API Token Permissions')

  // Try user-level token verification first, then account-level
  const userResp = await cfApi(cf.apiToken, 'GET', '/user/tokens/verify', undefined, {
    silent: true,
  })
  if (userResp?.result?.status === 'active') {
    pass('Token is valid and active (user-level token)')
  } else {
    const accountId = await getAccountId(cf.apiToken, cf.tunnelToken)
    if (accountId) {
      const acctResp = await cfApi(cf.apiToken, 'GET', `/accounts/${accountId}/tokens/verify`)
      if (acctResp?.result?.status === 'active') {
        pass('Token is valid and active (account-level token)')
      } else {
        die('Token verification failed — could not verify via user or account endpoint')
      }
    } else {
      die('Token verification failed and could not determine account ID')
    }
  }

  const accountId = await getAccountId(cf.apiToken, cf.tunnelToken)
  if (!accountId) die('No accounts accessible with this token')
  pass(`Account ID: ${accountId}`)

  if (await cfApi(cf.apiToken, 'GET', `/accounts/${accountId}/cfd_tunnel?per_page=1`)) {
    pass('Tunnel permission: OK')
  } else {
    fail('Cannot list tunnels. Token may lack Tunnel Edit permission.')
  }

  // DNS: check the zones of the hostnames the tunnel serves (if readable)
  const tunnelId = cf.tunnelToken ? extractTunnelIdFromToken(cf.tunnelToken) : ''
  const rules = tunnelId ? await getIngressRules(cf.apiToken, accountId, tunnelId) : null
  const roots = [...new Set((rules || []).map((r) => extractRootDomain(r.hostname)))]
  for (const root of roots) {
    if (await cfApi(cf.apiToken, 'GET', `/zones?name=${root}&per_page=1`)) {
      pass(`DNS permission (${root}): OK`)
    } else {
      fail(`Cannot access zone '${root}'. Token may lack DNS Edit permission.`)
    }
  }

  const accessReadResp = await cfApi(
    cf.apiToken,
    'GET',
    `/accounts/${accountId}/access/apps?per_page=1`,
    undefined,
    { silent: true },
  )
  if (accessReadResp) {
    pass('Zero Trust (Access): OK [read]')
  } else {
    info('Zero Trust (Access): none (optional)')
  }

  info('API token verification complete')
}

/**
 * Verify the tunnel token, then for every hostname the tunnel serves: DNS CNAME and
 * Cloudflare Access protection.
 */
export async function cmdVerify(ctx: PluginCommandContext) {
  const cf = getCloudflareConfig(ctx)

  header('Validating Tunnel Token')
  if (!cf.tunnelToken) die('stack.cloudflared.tunnelToken not set in config')

  const tunnelId = extractTunnelIdFromToken(cf.tunnelToken)
  if (!tunnelId)
    die('Could not extract tunnel ID from Cloudflare Tunnel Token — invalid token format')
  pass(`Tunnel ID: ${tunnelId}`)

  let tokenAccountId = ''
  try {
    const decoded = Buffer.from(cf.tunnelToken, 'base64').toString()
    tokenAccountId = JSON.parse(decoded).a || ''
  } catch {}
  if (tokenAccountId) pass(`Account ID: ${tokenAccountId}`)

  if (!cf.apiToken) {
    info('(plugins.cloudflare.apiToken not set — skipping ingress route, DNS and Access checks)')
    info('\nVerification complete')
    return
  }

  header('Tunnel Ingress Routes')
  const accountId = tokenAccountId || (await getAccountId(cf.apiToken, cf.tunnelToken))
  const rules = accountId ? await getIngressRules(cf.apiToken, accountId, tunnelId) : null
  if (!rules) {
    fail('Could not read tunnel configuration — check API token permissions')
    return
  }
  info(`${rules.length} ingress rule(s) configured:`)
  for (const rule of rules) info(`  ${rule.hostname}${rule.path || ''} → ${rule.service}`)
  for (const rule of rules) {
    const depth = checkSubdomainDepth(rule.hostname)
    if (!depth.ok) fail(depth.message!)
  }

  const hostnames = [...new Set(rules.map((r) => r.hostname))]

  header('DNS Records')
  for (const domain of hostnames) {
    const root = extractRootDomain(domain)
    const zoneResp = await cfApi(cf.apiToken, 'GET', `/zones?name=${root}&per_page=1`)
    const zoneId = zoneResp?.result?.[0]?.id
    if (!zoneId) {
      fail(`${domain}: no zone found for ${root}`)
      continue
    }
    const dnsResp = await cfApi(
      cf.apiToken,
      'GET',
      `/zones/${zoneId}/dns_records?type=CNAME&name=${domain}`,
    )
    if (dnsResp?.result?.length > 0) {
      pass(`${domain}: CNAME → ${dnsResp.result[0].content}`)
    } else {
      fail(`${domain}: no CNAME record found`)
    }
  }

  header('Cloudflare Access Protection')
  for (const domain of hostnames) {
    const accessResult = await checkCloudflareAccess(domain)
    if (accessResult === 'protected') {
      pass(`${domain}: protected by Cloudflare Access`)
    } else if (accessResult === 'unprotected') {
      fail(`${domain}: NOT protected by Cloudflare Access — anyone with the URL can reach it`)
    } else {
      info(`${domain}: could not check (${accessResult})`)
    }
  }

  info('\nVerification complete')
}

/**
 * List active Cloudflare tunnels.
 */
export async function cmdListTunnels(ctx: PluginCommandContext) {
  const cf = getCloudflareConfig(ctx)
  if (!cf.apiToken) die('plugins.cloudflare.apiToken not set')
  const accountId = await getAccountId(cf.apiToken, cf.tunnelToken)
  if (!accountId) die('No accounts accessible')

  header('Active Cloudflare Tunnels')
  const resp = await cfApi(
    cf.apiToken,
    'GET',
    `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=50`,
  )
  if (!resp) die('Failed to list tunnels')

  const tunnels = resp.result || []
  if (tunnels.length === 0) {
    info('(no tunnels found)')
    return
  }
  for (const t of tunnels) {
    info(`${t.id}  ${t.name}  (${t.status || 'unknown'})`)
  }
}

/**
 * Create a new Cloudflare tunnel.
 */
export async function cmdCreateTunnel(ctx: PluginCommandContext, name: string) {
  if (!name) die('Usage: airstack cf-tunnel create-tunnel <name>')
  const cf = getCloudflareConfig(ctx)
  if (!cf.apiToken) die('plugins.cloudflare.apiToken not set')

  const accountId = await getAccountId(cf.apiToken, cf.tunnelToken)
  if (!accountId) die('No accounts accessible')

  header(`Creating Tunnel: ${name}`)
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
  const resp = await cfApi(cf.apiToken, 'POST', `/accounts/${accountId}/cfd_tunnel`, {
    name,
    tunnel_secret: secret,
    config_src: 'cloudflare',
  })
  if (!resp) die('Failed to create tunnel')

  const tunnelId = resp.result.id
  info(`Tunnel created: ${tunnelId}`)

  const tokenResp = await cfApi(
    cf.apiToken,
    'GET',
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
  )
  const token = tokenResp?.result
  if (token) {
    ctx.updateConfig('stack.cloudflared.tunnelToken', token)
    info('Tunnel token saved to config')
    console.log(`\nTUNNEL_ID=${tunnelId}`)
    console.log(`CLOUDFLARE_TUNNEL_TOKEN=${token}`)
  }
}

/**
 * Print usage help.
 */
export function cmdHelp() {
  console.log(`Usage: airstack cf-tunnel <command>

Commands:
  verify                      Validate the tunnel token; with an API token, list ingress routes
                              and check DNS + Cloudflare Access for every hostname
  verify-api-token            Check API token has required permissions
  list-tunnels                List active tunnels
  create-tunnel <name>        Create a new tunnel and save its token`)
}
