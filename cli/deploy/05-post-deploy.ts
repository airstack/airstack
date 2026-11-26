/**
 * Phase 05: Post-deploy
 *
 * Core: nothing — fully delegated to plugins/hooks.
 * Plugins: sandbox builds, cron registration, etc.
 * Hooks: custom cleanup, notifications.
 */

import type { DeployContext } from '../types.js'

export async function postDeploy(ctx: DeployContext): Promise<void> {
  // All logic in plugins/hooks
  ctx.phaseStatus.push({ phase: 'post-deploy', success: true, message: 'Post-deploy complete' })
}
