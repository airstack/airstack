// Built-in Cloudflare plugin — Tunnel sidecar, tunnel checks and the Cloudflare Access guard.
//
// Registers the 'cf-tunnel' sub-command with:
//   verify            Validate the tunnel; with an API token, check routes, DNS and Access
//   verify-api-token  Check the API token's permissions
//   list-tunnels      List Cloudflare tunnels
//   create-tunnel     Create a new tunnel
//
// Access guard: see access.ts (config + classifier) and deploy-guard.ts (deploy check). The
// settings reach the host scripts through the machine unit's manifest (CF_ACCESS_*).

import type { DeployContext, Plugin, PluginCommandContext } from '../../types.js'
import {
  cmdVerify, cmdVerifyApiToken, cmdListTunnels, cmdCreateTunnel, cmdHelp,
} from './commands.js'
import { parseAccessConfig } from './access.js'
import { accessGuard, CF_METRICS } from './deploy-guard.js'

export { parseAccessConfig, type AccessConfig } from './access.js'
export { CF_METRICS } from './deploy-guard.js'

async function cfTunnelCommand(args: string[], ctx: PluginCommandContext): Promise<void> {
  const command = args[0] || ''
  switch (command) {
    case 'verify': await cmdVerify(ctx); break
    case 'verify-api-token': await cmdVerifyApiToken(ctx); break
    case 'list-tunnels': await cmdListTunnels(ctx); break
    case 'create-tunnel': await cmdCreateTunnel(ctx, args[1] || ''); break
    case '--help': case '-h': case '': cmdHelp(); break
    default:
      console.error(`Unknown cf-tunnel command: ${command}. Run: airstack fleet plugin <machine> cf-tunnel --help`)
      process.exit(1)
  }
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
      'post-deploy': async (ctx: DeployContext) => {
        await accessGuard(ctx, access)
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
