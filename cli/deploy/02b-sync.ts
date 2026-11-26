/**
 * Phase 02b: Sync
 *
 * Core: rsync .deploy/ → installDir on VPS.
 * Sync behavior controlled by deploy.sync config:
 *   - default: 'delete' | 'preserve' (default --delete behavior)
 *   - preserve: [] (dirs that never get --delete)
 *   - delete: [] (dirs that always get --delete)
 */

import type { DeployContext } from '../types.js'
import { readdirSync, statSync } from 'node:fs'
import { ownershipCommand } from '../lib/ownership.js'
import { join } from 'node:path'

export async function sync(ctx: DeployContext): Promise<void> {
  const { deployDir, config, remote } = ctx
  const { installDir } = config.stack
  const { appUser } = config.host
  const syncConfig = config.deploy.sync

  if (!remote) {
    ctx.errors.push({ phase: 'sync', message: 'No remote executor configured', fatal: true })
    return
  }

  // Create install dir
  await remote.run(`sudo mkdir -p ${installDir}/logs`)

  // Sync each entry in .deploy/ to installDir
  let syncErrors = 0
  for (const entry of readdirSync(deployDir)) {
    const src = join(deployDir, entry)
    const stat = statSync(src)

    if (stat.isDirectory()) {
      const useDelete = shouldDelete(entry, syncConfig)
      const mkdirResult = await remote.run(`sudo mkdir -p ${installDir}/${entry}`)
      if (mkdirResult.exitCode !== 0) {
        ctx.errors.push({ phase: 'sync', message: `Failed to create ${installDir}/${entry}: ${mkdirResult.stderr}`.trim(), fatal: false })
        syncErrors++
        continue
      }
      const rsyncResult = await remote.rsync(`${src}/`, `${installDir}/${entry}/`, useDelete ? ['--delete'] : [])
      if (rsyncResult.exitCode !== 0) {
        ctx.errors.push({ phase: 'sync', message: `Failed to rsync ${entry}/ (exit ${rsyncResult.exitCode})`, fatal: false })
        syncErrors++
      }
    } else if (stat.isFile()) {
      const rsyncResult = await remote.rsync(src, `${installDir}/${entry}`)
      if (rsyncResult.exitCode !== 0) {
        ctx.errors.push({ phase: 'sync', message: `Failed to rsync ${entry} (exit ${rsyncResult.exitCode})`, fatal: false })
        syncErrors++
      }
    }
  }

  if (syncErrors > 0) {
    ctx.log.warn(`[sync] ${syncErrors} file(s) failed to sync`)
  }

  // Fix ownership (except paths a plugin registered as keepOwner)
  await remote.run(ownershipCommand(installDir, appUser, ctx.registeredFiles.keepOwner ?? []))

  // TODO: VPS git tracking — disabled pending .gitignore generation for new layout

  ctx.phaseStatus.push({ phase: 'sync', success: true, message: 'Synced to VPS' })
}

/**
 * Determine whether a directory should be synced with --delete.
 * Priority: explicit delete[] > explicit preserve[] > default
 */
function shouldDelete(dir: string, syncConfig: DeployContext['config']['deploy']['sync']): boolean {
  const dirName = dir.replace(/\/$/, '')
  if (syncConfig.delete.some(d => d.replace(/\/$/, '') === dirName)) return true
  if (syncConfig.preserve.some(d => d.replace(/\/$/, '') === dirName)) return false
  return syncConfig.default === 'delete'
}
