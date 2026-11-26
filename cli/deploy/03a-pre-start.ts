/**
 * Phase 03a: Pre-start
 *
 * Core: initialize compose state with defaults.
 * Plugins: detect which services need build/recreate/restart by examining
 *   ctx.changes and populating ctx.compose.services.
 * Hooks: custom service detection logic.
 *
 * After this phase, ctx.compose contains the full plan for what
 * dry-run and start will execute.
 */

import type { DeployContext } from '../types.js'

export async function preStart(ctx: DeployContext): Promise<void> {
  // --force always adds --force-recreate, regardless of services list
  if (ctx.force) {
    ctx.compose.upArgs.push('--force-recreate')
  }

  const actionCount = ctx.compose.services.filter(s => s.action !== 'none').length
  ctx.phaseStatus.push({
    phase: 'pre-start',
    success: true,
    message: ctx.force
      ? `Force recreate (${actionCount} service action(s) queued)`
      : actionCount > 0
        ? `${actionCount} service(s) need action`
        : 'No service changes detected',
  })
}
