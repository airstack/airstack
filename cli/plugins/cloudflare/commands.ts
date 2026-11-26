// cf-tunnel command functions: verify, verify-api-token, list-tunnels, create-tunnel, help.
//
// Route + Access setup is not automated here yet: stacks will declare their tunnel routes
// (plans/phase-1.md). Until then, routes are managed in the Cloudflare dashboard and `verify`
// checks every hostname the tunnel serves.

import type { PluginCommandContext } from '../../types.js'
import { classify, fetchProber } from './access.js'
import {
  cfApi, checkSubdomainDepth, extractRootDomain, extractTunnelIdFromToken, getAccountId,
  getCloudflareConfig, getIngressRules,
} from './api.js'
import { die, fail, header, info, pass } from './output.js'

// ── Command functions ────────────────────────────────────────────────────────

/**
 * Verify that the Cloudflare API token has the required permissions.
 */
export async function cmdVerifyApiToken(ctx: PluginCommandContext) {
  const cf = getCloudflareConfig(ctx)
  if (!cf.apiToken) die('plugins.cloudflare.apiToken is not set')
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
        die('Cloudflare did not accept the API token (the user and the account token checks both failed)')
      }
    } else {
      die('Token check failed, and the account ID is unknown')
    }
  }

  const accountId = await getAccountId(cf.apiToken, cf.tunnelToken)
  if (!accountId) die('This token cannot see any Cloudflare account')
  pass(`Account ID: ${accountId}`)

  if (await cfApi(cf.apiToken, 'GET', `/accounts/${accountId}/cfd_tunnel?per_page=1`)) {
    pass('Tunnel permission: OK')
  } else {
    fail('Cannot list tunnels. The token may not have the Tunnel Edit permission.')
  }

  // DNS: check the zones of the hostnames the tunnel serves (if readable)
  const tunnelId = cf.tunnelToken ? extractTunnelIdFromToken(cf.tunnelToken) : ''
  const rules = tunnelId ? await getIngressRules(cf.apiToken, accountId, tunnelId) : null
  const roots = [...new Set((rules || []).map((r) => extractRootDomain(r.hostname)))]
  for (const root of roots) {
    if (await cfApi(cf.apiToken, 'GET', `/zones?name=${root}&per_page=1`)) {
      pass(`DNS permission (${root}): OK`)
    } else {
      fail(`Cannot access zone '${root}'. The token may not have the DNS Edit permission.`)
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
  if (!cf.tunnelToken) die('stack.cloudflared.tunnelToken is not set')

  const tunnelId = extractTunnelIdFromToken(cf.tunnelToken)
  if (!tunnelId)
    die('The tunnel token is not valid: it holds no tunnel ID')
  pass(`Tunnel ID: ${tunnelId}`)

  let tokenAccountId = ''
  try {
    const decoded = Buffer.from(cf.tunnelToken, 'base64').toString()
    tokenAccountId = JSON.parse(decoded).a || ''
  } catch {}
  if (tokenAccountId) pass(`Account ID: ${tokenAccountId}`)

  if (!cf.apiToken) {
    info('(plugins.cloudflare.apiToken is not set, so the route, DNS and Access checks are skipped)')
    info('\nVerification complete')
    return
  }

  header('Tunnel Ingress Routes')
  const accountId = tokenAccountId || (await getAccountId(cf.apiToken, cf.tunnelToken))
  const rules = accountId ? await getIngressRules(cf.apiToken, accountId, tunnelId) : null
  if (!rules) {
    fail('Cannot read the tunnel config. Check the API token permissions.')
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
    const answer = await fetchProber(`https://${domain}/`)
    const state = classify(answer)
    if (state === 'protected') {
      pass(`${domain}: protected by Cloudflare Access`)
    } else if (state === 'unprotected') {
      fail(`${domain}: NOT protected by Cloudflare Access. Anyone with the URL can reach it.`)
    } else {
      info(`${domain}: could not check (HTTP ${answer.code || 'no answer'})`)
    }
  }

  info('\nVerification complete')
}

/**
 * List active Cloudflare tunnels.
 */
export async function cmdListTunnels(ctx: PluginCommandContext) {
  const cf = getCloudflareConfig(ctx)
  if (!cf.apiToken) die('plugins.cloudflare.apiToken is not set')
  const accountId = await getAccountId(cf.apiToken, cf.tunnelToken)
  if (!accountId) die('This token cannot see any Cloudflare account')

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
  if (!name) die('Usage: airstack fleet plugin <machine> cf-tunnel create-tunnel <name>')
  const cf = getCloudflareConfig(ctx)
  if (!cf.apiToken) die('plugins.cloudflare.apiToken is not set')

  const accountId = await getAccountId(cf.apiToken, cf.tunnelToken)
  if (!accountId) die('This token cannot see any Cloudflare account')

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
    console.log(`\nTUNNEL_ID=${tunnelId}`)
    if (ctx.saveSecret) {
      const file = ctx.saveSecret('CLOUDFLARE_TUNNEL_TOKEN', token)
      info(`The tunnel token is saved as CLOUDFLARE_TUNNEL_TOKEN in ${file}.`)
      info('In the machine file, set: tunnelToken: ${CLOUDFLARE_TUNNEL_TOKEN}')
    } else {
      info('Cannot save the tunnel token here. Get it in the Cloudflare dashboard: Zero Trust > Networks > Tunnels.')
    }
  }
}

/**
 * Print usage help.
 */
export function cmdHelp() {
  console.log(`Usage: airstack fleet plugin <machine> cf-tunnel <command>

Commands:
  verify                      Validate the tunnel token; with an API token, list ingress routes
                              and check DNS + Cloudflare Access for every hostname
  verify-api-token            Check that the API token has the permissions it needs
  list-tunnels                List active tunnels
  create-tunnel <name>        Create a new tunnel and save its token`)
}
