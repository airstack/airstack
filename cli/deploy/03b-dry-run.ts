/**
 * Phase 03b: Dry-run
 *
 * Core: validate docker compose config on VPS.
 * Runs AFTER pre-start so compose state is finalized but BEFORE start
 * to catch config errors before containers are affected.
 *
 * Also runs docker compose build for services flagged as needing build.
 * Building before dry-run ensures images exist for config validation.
 */

import type { DeployContext } from '../types.js'

export async function dryRun(ctx: DeployContext): Promise<void> {
  const { config, remote } = ctx
  const { installDir } = config.stack
  const { appUser } = config.host

  if (!remote) {
    ctx.errors.push({ phase: 'dry-run', message: 'No remote executor configured', fatal: true })
    return
  }
  // Build services that need it (before config validation)
  const buildServices = ctx.compose.services
    .filter(s => s.action === 'build')
    .map(s => s.service)

  if (buildServices.length > 0) {
    const buildArgs = ctx.compose.buildArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const services = buildServices.map(s => `'${s.replace(/'/g, "'\\''")}'`).join(' ')
    const profileArgs = ctx.compose.profiles.map(p => `--profile '${p.replace(/'/g, "'\\''")}'`).join(' ')
    ctx.log.info(`Building ${buildServices.length} service(s): ${buildServices.join(' ')}`)
    const buildResult = await remote.run(
      `sudo -u ${appUser} bash -c 'cd ${installDir} && docker compose ${profileArgs} build ${buildArgs} ${services}'`,
    )
    if (buildResult.exitCode !== 0) {
      ctx.errors.push({
        phase: 'dry-run',
        message: `Docker build failed:\n${buildResult.stderr || buildResult.stdout}`.trim(),
        fatal: true,
      })
      return
    }
  }
  // Validate compose config
  const profileArgs = ctx.compose.profiles.map(p => `--profile '${p.replace(/'/g, "'\\''")}'`).join(' ')
  const result = await remote.run(
    `sudo -u ${appUser} bash -c 'cd ${installDir} && docker compose ${profileArgs} config' 2>&1`,
  )

  if (result.exitCode !== 0) {
    ctx.errors.push({
      phase: 'dry-run',
      message: `Docker compose config validation failed:\n${result.stdout || result.stderr}`,
      fatal: true,
    })
    return
  }
  ctx.phaseStatus.push({ phase: 'dry-run', success: true, message: 'Compose config validated' })
}
