// cf-tunnel.ts — Cloudflare Tunnel helpers and command functions.
// The code lives in api.ts, output.ts and commands.ts. This file re-exports it so importers keep one path.

export {
  extractRootDomain, CF_API_BASE, cfApi, getAccountId, extractTunnelIdFromToken, checkSubdomainDepth,
} from './api.js'
export { die, info, pass, fail, header, promptForInput } from './output.js'
export { cmdVerifyApiToken, cmdVerify, cmdListTunnels, cmdCreateTunnel, cmdHelp } from './commands.js'
