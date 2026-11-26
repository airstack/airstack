// Built-in Cloudflare plugin — Tunnel sidecar + tunnel checks.
//
// Registers the 'cf-tunnel' sub-command with:
//   verify            Validate the tunnel; with an API token, check routes, DNS and Access
//   verify-api-token  Check the API token's permissions
//   list-tunnels      List Cloudflare tunnels
//   create-tunnel     Create a new tunnel

import type { DeployContext, Plugin, PluginCommandContext } from '../../types.js'
import {
  cmdVerify, cmdVerifyApiToken, cmdListTunnels, cmdCreateTunnel, cmdHelp,
} from './cf-tunnel.js'

async function cfTunnelCommand(args: string[], ctx: PluginCommandContext): Promise<void> {
  const command = args[0] || ''
  switch (command) {
    case 'verify': await cmdVerify(ctx); break
    case 'verify-api-token': await cmdVerifyApiToken(ctx); break
    case 'list-tunnels': await cmdListTunnels(ctx); break
    case 'create-tunnel': await cmdCreateTunnel(ctx, args[1] || ''); break
    case '--help': case '-h': case '': cmdHelp(); break
    default:
      console.error(`Unknown cf-tunnel command: ${command}. Run: airstack cf-tunnel --help`)
      process.exit(1)
  }
}

// ── Cloudflare Access guard (plugins.airstack/cloudflare.access) ─────────────
//   access:
//     required: true        # every public tunnel hostname must be behind Cloudflare Access (default true)
//     exempt: [hooks.example.com, app.example.com/webhook]   # deliberately public (hostname or hostname/path)
//     onDeploy: refuse      # refuse | warn  (default refuse)
//     onScan: alert         # alert | stop   (default alert; stop = docker stop the cloudflared container)
// The settings reach the host scripts through the machine unit's manifest (CF_ACCESS_*).

export const CF_METRICS = '127.0.0.1:20241'

export interface AccessConfig {
  required: boolean
  exempt: string[]
  onDeploy: 'refuse' | 'warn'
  onScan: 'alert' | 'stop'
}

export function parseAccessConfig(raw: unknown): AccessConfig {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const known = new Set(['required', 'exempt', 'onDeploy', 'onScan'])
  for (const k of Object.keys(a)) if (!known.has(k)) throw new Error(`access.${k}: unknown key (known: ${[...known].join(', ')})`)
  const required = a.required === undefined ? true : a.required
  if (typeof required !== 'boolean') throw new Error('access.required must be true or false')
  const exempt = a.exempt === undefined ? [] : a.exempt
  if (!Array.isArray(exempt) || exempt.some((e) => typeof e !== 'string' || !/^[a-z0-9.-]+(\/[^\s]*)?$/i.test(e))) {
    throw new Error('access.exempt must be a list of hostnames or hostname/path entries')
  }
  const onDeploy = a.onDeploy ?? 'refuse'
  if (onDeploy !== 'refuse' && onDeploy !== 'warn') throw new Error('access.onDeploy must be refuse or warn')
  const onScan = a.onScan ?? 'alert'
  if (onScan !== 'alert' && onScan !== 'stop') throw new Error('access.onScan must be alert or stop')
  return { required, exempt: exempt as string[], onDeploy, onScan }
}

export function register(config: unknown): Plugin {
  // Validate early: a bad access block fails `airstack fleet check` and deploy before anything runs.
  const access = parseAccessConfig((config as { access?: unknown } | null)?.access)
  return {
    name: 'cloudflare',
    scope: 'machine',
    composeServices: [{
      name: 'cloudflared',
      template: 'templates/cloudflared.docker-compose.yml.hbs',
    }],
    hooks: {
      'pre-stage': async (ctx: DeployContext) => {
        const e = ctx.manifest.entries
        e.CF_CONTAINER = `${ctx.config.stack.projectName}-cloudflared`
        e.CF_METRICS = CF_METRICS
        e.CF_ACCESS_REQUIRED = String(access.required)
        e.CF_ACCESS_EXEMPT = access.exempt.join(' ')
        e.CF_ACCESS_ON_DEPLOY = access.onDeploy
        e.CF_ACCESS_ON_SCAN = access.onScan
      },
    },
    commands: {
      'cf-tunnel': {
        description: 'Cloudflare Tunnel checks',
        run: cfTunnelCommand,
      },
    },
  }
}
