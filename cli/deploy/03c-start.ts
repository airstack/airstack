/**
 * Phase 03c: Start
 *
 * Core: run docker compose up -d with the accumulated compose state.
 * Reads ctx.compose to determine which services to start/recreate.
 *
 * Strategy:
 * - If no specific services flagged → `docker compose up -d` (all services)
 * - If specific services flagged → start only those with appropriate flags
 * - upArgs (e.g. --force-recreate) applied to the compose command
 */

import type { DeployContext } from '../types.js'

export async function start(ctx: DeployContext): Promise<void> {
  const { config, remote } = ctx
  const { installDir } = config.stack
  const { appUser } = config.host

  if (!remote) {
    ctx.errors.push({ phase: 'start', message: 'No remote executor configured', fatal: true })
    return
  }
  const profileArgs = ctx.compose.profiles.map(p => `--profile '${p.replace(/'/g, "'\\''")}'`).join(' ')
  const upArgs = ctx.compose.upArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')

  // Services that need recreate or restart
  const actionServices = ctx.compose.services.filter(s => s.action === 'recreate' || s.action === 'restart')

  if (actionServices.length > 0) {
    // Start specific services — apply upArgs (includes --force-recreate if --force)
    const services = actionServices.map(s => `'${s.service.replace(/'/g, "'\\''")}'`).join(' ')
    ctx.log.info(`Starting ${actionServices.length} service(s): ${services}`)
    const result = await remote.run(
      `sudo -u ${appUser} bash -c 'cd ${installDir} && docker compose ${profileArgs} up -d ${upArgs} --force-recreate ${services}'`,
    )
    if (result.exitCode !== 0) {
      ctx.errors.push({
        phase: 'start',
        message: `docker compose up failed:\n${result.stderr || result.stdout}`.trim(),
        fatal: true,
      })
      return
    }
  } else {
    // No specific services flagged — bring up the full stack
    ctx.log.info('Starting stack...')
    const result = await remote.run(
      `sudo -u ${appUser} bash -c 'cd ${installDir} && docker compose ${profileArgs} up -d ${upArgs}'`,
    )
    if (result.exitCode !== 0) {
      ctx.errors.push({
        phase: 'start',
        message: `docker compose up failed:\n${result.stderr || result.stdout}`.trim(),
        fatal: true,
      })
      return
    }
  }
  ctx.phaseStatus.push({
    phase: 'start',
    success: true,
    message: actionServices.length > 0
      ? `Started ${actionServices.length} service(s)`
      : 'Stack started',
  })
}
