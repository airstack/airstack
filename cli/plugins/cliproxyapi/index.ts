// Built-in CLIProxyAPI plugin — runs router-for-me/CLIProxyAPI as a container.
//
// Config + OAuth tokens are VPS-only state in {installDir}/.cliproxyapi/
// (config.yaml, auths/, logs/). Deploy never syncs or deletes that directory;
// copy config.yaml there once by hand (see docs/CLIPROXYAPI.md).
//
// Config schema (under plugins.cliproxyapi in stack.yml):
//   image: eceasy/cli-proxy-api:v8.0.80  # optional; default is pinned (bump deliberately)
//   memory: 1G                           # optional container memory limit
//   usageServer:                         # optional: simple10/usage-server sidecar + proxy plugin mounts
//     uid: 1002                          # required: UID/GID that can read transcriptsDir
//     gid: 1002
//     transcriptsDir: /home/deployuser/.claude/projects   # required: Claude Code transcripts (mounted read-only)
//     version: 0.1.0                     # optional; default is the pin in usage-server-pin.ts
//                                        #   (bun run bump-usage-server). Built ON the VPS from tag v<version>.
//     repo: https://github.com/simple10/usage-server.git   # optional
//     port: 18090                        # optional; loopback only
//   See docs/CLIPROXYAPI.md ("usage-server") for what deploy does and does not do.

import type { Plugin, DeployContext } from '../../types.js'
import { resolveUsageServer, usageServerBuild, usageServerKeepOwner, usageServerPostSync } from './usage-server.js'

async function postSyncHook(ctx: DeployContext): Promise<void> {
  if (!ctx.remote) return
  const dir = `${ctx.config.stack.installDir}/.cliproxyapi`

  // Without config.yaml, Docker would bind-mount an empty *directory* in its place.
  const cfg = await ctx.remote.run(`sudo test -f ${dir}/config.yaml && echo ok`)
  if (cfg.stdout.trim() !== 'ok') {
    ctx.errors.push({
      phase: 'post-sync',
      message: `[cliproxyapi] ${dir}/config.yaml missing — copy it to the VPS first (docs/CLIPROXYAPI.md)`,
      fatal: true,
    })
    return
  }

  await ctx.remote.run(`sudo mkdir -p ${dir}/auths ${dir}/logs && sudo chmod 700 ${dir} ${dir}/auths`)
  // OAuth tokens: files owner-only too, so they stay private if a parent dir mode ever loosens.
  await ctx.remote.run(`sudo find ${dir}/auths -type f -exec chmod 600 {} +`)

  // allow-remote: true would expose the management API to every tailnet peer.
  const remote = await ctx.remote.run(`sudo grep -E '^\\s*allow-remote:\\s*true' ${dir}/config.yaml`)
  if (remote.exitCode === 0) {
    ctx.log.warn('[cliproxyapi] management.allow-remote is true — tailnet peers can reach the management API')
  }
}

export function register(config: unknown): Plugin {
  // Fills defaults (version pin, repo, port) into the config object the templates read.
  const us = resolveUsageServer((config as { usageServer?: unknown } | null)?.usageServer)
  const composeServices = [{
    name: 'cli-proxy-api',
    template: 'templates/cliproxyapi.docker-compose.yml.hbs',
  }]
  if (us) {
    composeServices.push({
      name: 'usage-server',
      template: 'templates/usage-server.docker-compose.yml.hbs',
    })
  }
  return {
    name: 'cliproxyapi',
    scope: 'stack',
    composeServices,
    hooks: {
      ...(us ? { 'pre-stage': async (ctx: DeployContext) => usageServerKeepOwner(ctx) } : {}),
      'post-sync': async (ctx: DeployContext) => {
        await postSyncHook(ctx)
        // postSyncHook returns early (with a fatal error) when config.yaml is missing.
        if (us && !ctx.errors.some(e => e.fatal)) await usageServerPostSync(ctx, us)
      },
      ...(us ? { build: async (ctx: DeployContext) => usageServerBuild(ctx, us) } : {}),
    },
  }
}
