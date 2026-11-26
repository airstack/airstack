/**
 * Deploy pipeline runner.
 *
 * Orchestrates all deploy phases in order. Each phase:
 *   1. Runs core logic (built-in)
 *   2. Runs plugin hooks (in registration order)
 *   3. Runs the deploy hook from deploy.hooks in the unit config (if declared)
 *
 * Aborts on fatal errors. Non-fatal errors accumulate in ctx.errors.
 */

import type { DeployContext, DeployPhase } from '../types.js'
import { resolveFileOptional } from '../lib/resolve-file.js'

import { preStage } from './01a-pre-stage.js'
import { stage } from './01b-stage.js'
import { preSync } from './02a-pre-sync.js'
import { sync } from './02b-sync.js'
import { postSync } from './02c-post-sync.js'
import { build } from './02d-build.js'
import { preStart } from './03a-pre-start.js'
import { dryRun } from './03b-dry-run.js'
import { start } from './03c-start.js'
import { healthcheck } from './04-healthcheck.js'
import { postDeploy } from './05-post-deploy.js'
import { validate } from './06-validate.js'

type PhaseFn = (ctx: DeployContext) => Promise<void>

const PHASES: { name: DeployPhase; run: PhaseFn; logFile: string }[] = [
  { name: 'pre-stage',   run: preStage,   logFile: '01-pre-stage' },
  { name: 'stage',       run: stage,      logFile: '02-stage' },
  { name: 'pre-sync',    run: preSync,    logFile: '03-pre-sync' },
  { name: 'sync',        run: sync,       logFile: '04-sync' },
  { name: 'post-sync',   run: postSync,   logFile: '05-post-sync' },
  { name: 'build',       run: build,      logFile: '06-build' },
  { name: 'pre-start',   run: preStart,   logFile: '07-pre-start' },
  { name: 'dry-run',     run: dryRun,     logFile: '08-dry-run' },
  { name: 'start',       run: start,      logFile: '09-start' },
  { name: 'healthcheck', run: healthcheck, logFile: '10-healthcheck' },
  { name: 'post-deploy', run: postDeploy, logFile: '11-post-deploy' },
  { name: 'validate',    run: validate,   logFile: '12-validate' },
]

/**
 * Run a deploy hook declared in the unit config under deploy.hooks.
 * Silently skips if no hook is configured for this phase.
 */
async function runDeployHook(ctx: DeployContext, phase: DeployPhase): Promise<void> {
  const hookPath = ctx.config.deploy.hooks[phase]
  if (!hookPath) return

  const resolved = resolveFileOptional(ctx.projectRoot, ctx.sharedPaths, hookPath)
  if (!resolved) {
    ctx.log.warn(`Deploy hook not found: ${hookPath} (phase: ${phase})`)
    return
  }

  try {
    const mod = await import(resolved)
    if (typeof mod.runHook === 'function') {
      await mod.runHook(ctx)
    } else {
      ctx.log.warn(`Deploy hook ${hookPath} does not export runHook()`)
    }
  } catch (err) {
    ctx.errors.push({
      phase,
      message: `Deploy hook failed: ${err instanceof Error ? err.message : String(err)}`,
      fatal: false,
    })
  }
}

/**
 * Run all plugin hooks for a phase.
 */
async function runPluginHooks(ctx: DeployContext, phase: DeployPhase): Promise<void> {
  for (const plugin of ctx.plugins) {
    const hook = plugin.hooks?.[phase]
    if (hook) {
      try {
        await hook(ctx, ctx.config.plugins[plugin.name])
      } catch (err) {
        ctx.errors.push({
          phase,
          message: `Plugin ${plugin.name} hook failed: ${err instanceof Error ? err.message : String(err)}`,
          fatal: false,
        })
      }
    }
  }
}

function hasFatalError(ctx: DeployContext): boolean {
  return ctx.errors.some(e => e.fatal)
}

/**
 * Execute the full deploy pipeline.
 */
export async function runDeploy(ctx: DeployContext): Promise<void> {
  for (const { name, run, logFile } of PHASES) {
    if (hasFatalError(ctx)) break

    ctx.phase = name
    ctx.log.setPhase?.(logFile)
    ctx.log.info(`→ Phase: ${name}`)

    // 1. Core logic
    await run(ctx)
    if (hasFatalError(ctx)) break

    // 2. Plugin hooks
    await runPluginHooks(ctx, name)
    if (hasFatalError(ctx)) break

    // 3. Deploy hook (from deploy.hooks in the unit config)
    await runDeployHook(ctx, name)
    if (hasFatalError(ctx)) break

    // Update phase status if errors/warnings were added during hooks
    const phaseErrors = ctx.errors.filter(e => e.phase === name)
    if (phaseErrors.length > 0) {
      // Find and update the phase status entry (last one for this phase)
      let statusIdx = -1
      for (let i = ctx.phaseStatus.length - 1; i >= 0; i--) {
        if (ctx.phaseStatus[i].phase === name) { statusIdx = i; break }
      }
      if (statusIdx >= 0) {
        const fatalCount = phaseErrors.filter(e => e.fatal).length
        const warnCount = phaseErrors.filter(e => !e.fatal).length
        const parts: string[] = []
        if (fatalCount > 0) parts.push(`${fatalCount} error(s)`)
        if (warnCount > 0) parts.push(`${warnCount} warning(s)`)
        ctx.phaseStatus[statusIdx] = {
          phase: name,
          success: fatalCount === 0,
          message: `${ctx.phaseStatus[statusIdx].message} — ${parts.join(', ')}`,
          warnings: warnCount,
        }
      }
    }

    ctx.log.info(`✓ ${name}`)

    // Stop after this phase if requested (--stage stops after 'stage', --dry-run after 'dry-run')
    if (ctx.stopAfter === name) {
      ctx.log.info(`Stopping after ${name} (as requested)`)
      break
    }
  }

  // ctx.phase is left as the last phase that ran.
  // deploy.ts decides final status (done, stopped, failed).
}
