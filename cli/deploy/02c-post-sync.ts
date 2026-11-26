/**
 * Phase 02c: Post-sync
 *
 * Core: lock down installDir (750), move /etc/ files from installDir to /etc/, set VPS timezone,
 * verify critical files. installDir is closed to other users, so every read of it below runs
 * under sudo (the SSH admin user is not in the app user's group).
 * Plugins: fix special permissions, additional file moves.
 * Hooks: custom post-sync tasks.
 */

import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DeployContext } from '../types.js'

export async function postSync(ctx: DeployContext): Promise<void> {
  const { config, remote } = ctx
  const { installDir } = config.stack

  if (!remote) {
    ctx.errors.push({ phase: 'post-sync', message: 'No remote executor configured', fatal: true })
    return
  }

  // 0. installDir holds the stack's scripts, state and (via plugins) secrets: owner + group only.
  await remote.run(`sudo chmod 750 ${installDir}`)

  // 1. Promote /etc/ subdirs from installDir to /etc/ on VPS (core — not plugin-specific)
  // The stage phase writes etc/cron.d/, etc/logrotate.d/ into .deploy/
  // which gets synced to installDir/etc/. Now we promote them to the real /etc/.
  for (const subdir of ['cron.d', 'logrotate.d']) {
    const srcDir = `${installDir}/etc/${subdir}`
    const check = await remote.run(`sudo test -d ${srcDir} && echo yes || echo no`)
    if (check.stdout.trim() !== 'yes') continue

    await remote.run(`sudo mkdir -p /etc/${subdir}`)
    // Glob inside sudo: installDir is closed to the SSH admin user, so its shell cannot expand it.
    await remote.run(`sudo sh -c 'cp ${srcDir}/* /etc/${subdir}/' 2>/dev/null || true`)
    await remote.run(
      `sudo chown root:root /etc/${subdir}/* 2>/dev/null; ` +
      `sudo chmod 644 /etc/${subdir}/* 2>/dev/null || true`,
    )
  }

  // 1b. Promote stack manifest to its destination (default /etc/stacks/, configurable via stack.manifestDir)
  const manifestSrc = `${installDir}/etc/stacks`
  const manifestDest = ctx.manifest.destination
  if (manifestDest) {
    const manifestDestDir = manifestDest.slice(0, manifestDest.lastIndexOf('/'))
    const check = await remote.run(`sudo test -d ${manifestSrc} && echo yes || echo no`)
    if (check.stdout.trim() === 'yes') {
      await remote.run(`sudo mkdir -p ${manifestDestDir}`)
      await remote.run(`sudo sh -c 'cp ${manifestSrc}/* ${manifestDestDir}/' 2>/dev/null || true`)
      await remote.run(
        `sudo chown root:root ${manifestDestDir}/* 2>/dev/null; ` +
        `sudo chmod 644 ${manifestDestDir}/* 2>/dev/null || true`,
      )
    }
  }

  // 2. Set VPS timezone if configured
  const hostTz = config.host.timezone
  if (hostTz) {
    const currentTz = await remote.run('timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || true')
    if (currentTz.stdout.trim() !== hostTz) {
      ctx.log.info(`Setting VPS timezone: ${currentTz.stdout.trim() || '(unknown)'} → ${hostTz}`)
      await remote.run(`sudo timedatectl set-timezone '${hostTz.replace(/'/g, '')}'`)
    }
  }

  // 3. Verify critical files exist
  const verify = await remote.run(
    `sudo test -f ${installDir}/docker-compose.yml && echo ok`,
  )
  if (!verify.stdout.includes('ok')) {
    ctx.errors.push({ phase: 'post-sync', message: 'docker-compose.yml missing on VPS after sync', fatal: true })
    return
  }

  // 3b. docker-compose.yml carries secrets (tunnel token): owner-only.
  await remote.run(`sudo chmod 600 ${installDir}/docker-compose.yml`)

  // 4. Ensure plugin data directories exist on VPS
  for (const plugin of ctx.plugins) {
    if (plugin.dataDir) {
      await remote.run(`sudo mkdir -p ${plugin.dataDir}`)
      await remote.run(`sudo chown ${config.host.appUser}:${config.host.appUser} ${plugin.dataDir}`)
    }
  }

  // 5. Verify remote script permissions
  for (const dir of ctx.registeredFiles.scripts.dirs) {
    const excludeArgs = ctx.registeredFiles.scripts.exclude
      .map(e => `! -path '${`${installDir}/${e}`.replace(/'/g, "'\\''")}'`)
      .join(' ')
    const findCmd = `sudo find ${installDir}/${dir} -name '*.sh' ${excludeArgs} ! -perm /111 2>/dev/null || true`
    const check = await remote.run(findCmd)
    const badRemote = check.stdout.trim().split('\n').filter(Boolean)
    if (badRemote.length > 0) {
      ctx.errors.push({
        phase: 'post-sync',
        message: `Scripts missing execute permission on VPS:\n  ${badRemote.join('\n  ')}`,
        fatal: false,
      })
    }
  }

  // 6. Write files.json manifest for future orphan detection (via rsync to avoid heredoc injection)
  const stackConfigDir = `${installDir}/.stack-config`
  await remote.run(`sudo -u ${config.host.appUser} mkdir -p ${stackConfigDir}`)
  const filesJson = JSON.stringify({
    scripts: ctx.registeredFiles.scripts,
    hostFiles: ctx.registeredFiles.hostFiles,
  }, null, 2)
  const tmpFile = join(tmpdir(), `stack-files-${Date.now()}.json`)
  writeFileSync(tmpFile, filesJson, { mode: 0o600 })
  await remote.rsync(tmpFile, `${stackConfigDir}/files.json`)
  try { unlinkSync(tmpFile) } catch { /* already cleaned */ }
  await remote.run(`sudo chown ${config.host.appUser}:${config.host.appUser} ${stackConfigDir}/files.json`)

  ctx.phaseStatus.push({ phase: 'post-sync', success: true, message: 'Post-sync verified' })
}
