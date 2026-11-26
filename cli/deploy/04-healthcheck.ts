/**
 * Phase 04: Healthcheck
 *
 * Core: nothing — fully delegated to plugins/hooks.
 * Plugins: poll container health status for stack-specific services.
 * Hooks: custom health verification.
 */

import type { DeployContext } from '../types.js'

export async function healthcheck(ctx: DeployContext): Promise<void> {
  // All logic in plugins/hooks
  ctx.phaseStatus.push({ phase: 'healthcheck', success: true, message: 'Healthcheck complete' })
}
