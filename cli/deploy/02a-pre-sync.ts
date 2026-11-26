/**
 * Phase 02a: Pre-sync
 *
 * Core: verify VPS is reachable.
 * Core: clean up orphaned host files from previous deploy.
 * Core: check that staged scripts (.airstack/deploy/<machine>/<unit>/) have execute permission.
 * Plugins: change detection (config drift, image hash comparison, etc.)
 * Hooks: custom pre-flight checks.
 */

import { join } from 'node:path'
import type { DeployContext } from '../types.js'
import { DEFAULT_MANIFEST_DIR } from '../lib/paths.js'
import { findLocalScriptsMissingExecute, diffHostFiles, isValidHostFilePath } from '../lib/registered-files.js'

export async function preSync(ctx: DeployContext): Promise<void> {
  if (!ctx.remote) {
    ctx.errors.push({ phase: 'pre-sync', message: 'No SSH connection is set up for this deploy (no remote executor)', fatal: true })
    return
  }
  // Check VPS reachability
  const ping = await ctx.remote.run('echo ok')
  if (ping.exitCode !== 0) {
    ctx.errors.push({
      phase: 'pre-sync',
      message: `Cannot reach the machine over SSH: ${ping.stderr.trim() || 'connection failed'}`,
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
    const manifestDir = String((ctx.config.stack as any).manifestDir || DEFAULT_MANIFEST_DIR)
    for (const orphan of orphans) {
      if (!isValidHostFilePath(orphan, [manifestDir])) {
        ctx.log.warn(`[pre-sync] Not removing ${orphan}: the path is outside the folders deploy may clean`)
        continue
      }
      ctx.log.info(`[pre-sync] Removing ${orphan}: an earlier deploy wrote it; this deploy does not`)
      await ctx.remote.run(`sudo rm -f '${orphan}'`)
    }
  } catch {
    // First deploy or corrupt files.json — skip orphan check
  }

  // Check that staged scripts have execute permission
  const badScripts = findLocalScriptsMissingExecute(ctx.deployDir, ctx.registeredFiles.scripts)
  if (badScripts.length > 0) {
    ctx.errors.push({
      phase: 'pre-sync',
      message: `Staged scripts have no execute permission: ${badScripts.join(' ')}. Fix with: chmod +x ${badScripts.map(s => join(ctx.deployDir, s)).join(' ')}`,
      fatal: true,
    })
    return
  }

  ctx.phaseStatus.push({
    phase: 'pre-sync',
    success: true,
    message: 'Machine reachable over SSH',
  })
}
