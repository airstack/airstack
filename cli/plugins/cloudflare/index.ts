// Built-in Cloudflare plugin — Tunnel sidecar + tunnel checks.
//
// Registers the 'cf-tunnel' sub-command with:
//   verify            Validate the tunnel; with an API token, check routes, DNS and Access
//   verify-api-token  Check the API token's permissions
//   list-tunnels      List Cloudflare tunnels
//   create-tunnel     Create a new tunnel

import type { Plugin, PluginCommandContext } from '../../types.js'
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

export function register(_config: unknown): Plugin {
  return {
    name: 'cloudflare',
    scope: 'machine',
    composeServices: [{
      name: 'cloudflared',
      template: 'templates/cloudflared.docker-compose.yml.hbs',
    }],
    commands: {
      'cf-tunnel': {
        description: 'Cloudflare Tunnel checks',
        run: cfTunnelCommand,
      },
    },
  }
}
