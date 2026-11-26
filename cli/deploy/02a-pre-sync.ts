/**
 * Phase 02a: Pre-sync
 *
 * Core: verify VPS is reachable.
 * Core: clean up orphaned host files from previous deploy.
 * Core: check local .deploy/ scripts have execute permission.
 * Plugins: change detection (config drift, image hash comparison, etc.)
 * Hooks: custom pre-flight checks.
 */

import type { DeployContext } from '../types.js'
import { findLocalScriptsMissingExecute, diffHostFiles, isValidHostFilePath } from '../lib/registered-files.js'

export async function preSync(ctx: DeployContext): Promise<void> {
  if (!ctx.remote) {
    ctx.errors.push({ phase: 'pre-sync', message: 'No remote executor configured', fatal: true })
    return
  }
  // Check VPS reachability
  const ping = await ctx.remote.run('echo ok')
  if (ping.exitCode !== 0) {
    ctx.errors.push({
      phase: 'pre-sync',
      message: `VPS unreachable: ${ping.stderr.trim() || 'connection failed'}`,
      fatal: true,
    })
    return
  }

  // Clean up orphaned host files from previous deploy
  const configDir = `${ctx.config.stack.installDir}/.stack-config`
  const remoteJson = await ctx.remote.run(`sudo cat ${configDir}/files.json 2>/dev/null || echo '{}'`)
  try {
    const remoteManifest = JSON.parse(remoteJson.stdout.trim())
    const remoteHostFiles: string[] = remoteManifest.hostFiles || []
    const orphans = diffHostFiles(remoteHostFiles, ctx.registeredFiles.hostFiles)
    const manifestDir = String((ctx.config.stack as any).manifestDir || '/etc/stacks')
    for (const orphan of orphans) {
      if (!isValidHostFilePath(orphan, [manifestDir])) {
        ctx.log.warn(`[pre-sync] Skipping suspicious orphan path: ${orphan}`)
        continue
      }
      ctx.log.info(`[pre-sync] Removing orphaned host file: ${orphan}`)
      await ctx.remote.run(`sudo rm -f '${orphan}'`)
    }
  } catch {
    // First deploy or corrupt files.json — skip orphan check
  }

  // Check local .deploy/ scripts have execute permission
  const badScripts = findLocalScriptsMissingExecute(ctx.deployDir, ctx.registeredFiles.scripts)
  if (badScripts.length > 0) {
    ctx.errors.push({
      phase: 'pre-sync',
      message: `Scripts missing execute permission in .deploy/:\n  ${badScripts.join('\n  ')}\nFix with: chmod +x ${badScripts.map(s => `.deploy/${s}`).join(' ')}`,
      fatal: true,
    })
    return
  }

  ctx.phaseStatus.push({
    phase: 'pre-sync',
    success: true,
    message: 'VPS reachable',
  })
}
