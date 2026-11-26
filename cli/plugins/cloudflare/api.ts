// Cloudflare API helpers: API calls, account and tunnel token parsing, domain checks, plugin config.

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

// ── Config accessor ──────────────────────────────────────────────────────────

export function getCloudflareConfig(ctx: PluginCommandContext) {
  const cfPlugin = (ctx.config.plugins?.cloudflare || {}) as Record<string, unknown>
  const cfStack = (ctx.config.stack as any).cloudflared as Record<string, unknown> | undefined
  return {
    apiToken: String(cfPlugin.apiToken || ''),
    tunnelToken: String(cfStack?.tunnelToken || ''),
  }
}

/** Hostname ingress rules of a tunnel (empty when the API token cannot read them). */
export async function getIngressRules(
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
