/**
 * Phase 06: Validate
 *
 * Core: nothing — fully delegated to plugins/hooks.
 * Plugins: system config verification, container status checks.
 * Hooks: custom validation (alerter reports, etc.)
 */

import type { DeployContext } from '../types.js'

export async function validate(ctx: DeployContext): Promise<void> {
  // All logic in plugins/hooks
  const warnCount = ctx.errors.filter(e => e.phase === 'validate' && !e.fatal).length
  ctx.phaseStatus.push({
    phase: 'validate',
    success: !ctx.errors.some(e => e.phase === 'validate' && e.fatal),
    message: warnCount > 0 ? `Validated — ${warnCount} warning(s)` : 'Validated',
    warnings: warnCount,
  })
}
