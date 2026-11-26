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
import { composeCommand } from '../lib/compose.js'

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

export async function start(ctx: DeployContext): Promise<void> {
  const { remote } = ctx

  if (!remote) {
    ctx.errors.push({ phase: 'start', message: 'No SSH connection is set up for this deploy (no remote executor)', fatal: true })
    return
  }
  if (ctx.compose.skip) {
    ctx.phaseStatus.push({ phase: 'start', success: true, message: 'No compose services (skipped)' })
    return
  }
  const profileArgs = ctx.compose.profiles.map(p => `--profile ${q(p)}`).join(' ')
  const upArgs = ctx.compose.upArgs.map(q).join(' ')

  // Services that need recreate or restart
  const actionServices = ctx.compose.services.filter(s => s.action === 'recreate' || s.action === 'restart')

  if (actionServices.length > 0) {
    // Start specific services — apply upArgs (includes --force-recreate if --force)
    const services = actionServices.map(s => q(s.service)).join(' ')
    ctx.log.info(`Starting ${actionServices.length} service(s): ${services}`)
    const result = await remote.run(composeCommand(ctx, `${profileArgs} up -d ${upArgs} --force-recreate ${services}`))
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
    const result = await remote.run(composeCommand(ctx, `${profileArgs} up -d ${upArgs}`))
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
