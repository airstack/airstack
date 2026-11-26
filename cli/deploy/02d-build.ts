/**
 * Phase 02d: Build
 *
 * Core: no-op — exists for plugin hooks to build Docker images.
 * Plugins hook in here to build/rebuild images before start.
 */

import type { DeployContext } from '../types.js'

export async function build(ctx: DeployContext): Promise<void> {
  ctx.phaseStatus.push({ phase: 'build', success: true, message: 'Ready' })
}
