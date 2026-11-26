/**
 * Phase 01a: Pre-stage
 *
 * Core: git safety checks — verify deploy output paths are gitignored.
 * Plugins/hooks: early validations, environment checks, abort before staging.
 */

import { resolve } from 'node:path'
import { assertSafeForSecrets } from '../lib/git-safety.js'
import type { DeployContext } from '../types.js'

export async function preStage(ctx: DeployContext): Promise<void> {
  const { projectRoot, config } = ctx
  const allowUnsafe = config.stackConfig.allowUnsafeGit

  // Verify deploy output paths are gitignored (they contain secrets). resolve(): fleet units pass
  // absolute paths under <fleet>/.airstack/.
  const checks = [
    { path: resolve(projectRoot, config.deploy.stagingDir), label: 'deploy.staging_dir' },
    { path: resolve(projectRoot, config.deploy.report.destination), label: 'deploy.report.destination' },
  ]
  if (config.deploy.deployLogs !== false) {
    checks.push({ path: resolve(projectRoot, config.deploy.deployLogs), label: 'deploy.deploy_logs' })
  }

  for (const { path, label } of checks) {
    try {
      assertSafeForSecrets(path, label, allowUnsafe)
    } catch (err) {
      ctx.errors.push({
        phase: 'pre-stage',
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      })
    }
  }

  // Enrich manifest with core entries
  const { installDir, projectName } = config.stack
  const configDir = `${installDir}/.stack-config`
  const stateDir = `${installDir}/.stack-state`

  const manifestDir = String((config.stack as any).manifestDir || '/etc/stacks')
  ctx.manifest.destination = `${manifestDir}/${projectName}.env`
  ctx.manifest.entries.PROJECT_NAME = projectName
  ctx.manifest.entries.INSTALL_DIR = installDir
  ctx.manifest.entries.CONFIG_DIR = configDir
  ctx.manifest.entries.STATE_DIR = stateDir

  if (!ctx.errors.some(e => e.phase === 'pre-stage' && e.fatal)) {
    ctx.phaseStatus.push({ phase: 'pre-stage', success: true, message: 'Ready' })
  }
}
