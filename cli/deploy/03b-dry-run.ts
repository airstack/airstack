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
import { composeCommand } from '../lib/compose.js'

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

export async function dryRun(ctx: DeployContext): Promise<void> {
  const { remote } = ctx

  if (!remote) {
    ctx.errors.push({ phase: 'dry-run', message: 'No SSH connection is set up for this deploy (no remote executor)', fatal: true })
    return
  }
  if (ctx.compose.skip) {
    ctx.phaseStatus.push({ phase: 'dry-run', success: true, message: 'No compose services (skipped)' })
    return
  }
  const profileArgs = ctx.compose.profiles.map(p => `--profile ${q(p)}`).join(' ')

  // Build services that need it (before config validation)
  const buildServices = ctx.compose.services
    .filter(s => s.action === 'build')
    .map(s => s.service)

  if (buildServices.length > 0) {
    const buildArgs = ctx.compose.buildArgs.map(q).join(' ')
    const services = buildServices.map(q).join(' ')
    ctx.log.info(`Building ${buildServices.length} service(s): ${buildServices.join(' ')}`)
    const buildResult = await remote.run(composeCommand(ctx, `${profileArgs} build ${buildArgs} ${services}`))
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
  const result = await remote.run(`${composeCommand(ctx, `${profileArgs} config`)} 2>&1`)

  if (result.exitCode !== 0) {
    ctx.errors.push({
      phase: 'dry-run',
      message: `docker compose config found errors (compose file not valid):\n${result.stdout || result.stderr}`,
      fatal: true,
    })
    return
  }
  ctx.phaseStatus.push({ phase: 'dry-run', success: true, message: 'Compose config validated' })
}
