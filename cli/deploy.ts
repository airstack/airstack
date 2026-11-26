#!/usr/bin/env bun
/**
 * CLI deploy entry point.
 *
 * Usage: bun cli/deploy.ts [options]
 *   --stage        Render locally only (.deploy/); touches nothing remote
 *   --dry-run      NOT side-effect free: runs sync + post-sync (rsync --delete to
 *                  the VPS, chown, timezone), then validates compose; skips start
 *   --force        Force recreate all services
 *   -v, --verbose  Debug output
 *   -q, --quiet    Errors only
 */

import { parseArgs } from 'node:util'
import { resolve, join } from 'node:path'
import { loadConfig } from './lib/config.js'
import { loadPlugins } from './lib/plugin-loader.js'
import { getSharedPaths } from './lib/resolve-file.js'
import { runDeploy } from './deploy/runner.js'
import { createRemoteExecutor, createLoggingExecutor, sshConfigFromHost } from './lib/ssh.js'
import { renderReport } from './lib/report.js'
import { updateConfig as _updateConfig } from './lib/config-writer.js'
import { Logger, type LogLevel } from './lib/logger.js'
import type { DeployContext, DeployPhase, SSHConfig, ComposeState } from './types.js'

const VALID_PHASES = [
  'pre-stage', 'stage', 'pre-sync', 'sync', 'post-sync',
  'build', 'pre-start', 'dry-run', 'start', 'healthcheck',
  'post-deploy', 'validate',
] as const

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: 'boolean', default: false, short: 'h' },
    'stop-after': { type: 'string' },
    stage: { type: 'boolean', default: false },
    build: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
  },
  strict: true,
})

// Validate --stop-after phase name
if (values['stop-after'] && !VALID_PHASES.includes(values['stop-after'] as any)) {
  console.error(`Invalid phase: ${values['stop-after']}\nValid phases: ${VALID_PHASES.join(', ')}`)
  process.exit(1)
}

if (values.help) {
  console.log(`Usage: stack-cli deploy [options]

Options:
  --stop-after <phase>  Run deploy up to and including <phase>, then stop
  --stage               Shorthand for --stop-after stage
  --build               Shorthand for --stop-after build
  --dry-run             Shorthand for --stop-after dry-run. WARNING: this still
                        syncs files to the VPS (incl. docker-compose.yml) and
                        runs post-sync hooks; it only skips the container start.
                        For a purely local render use --stage.
  --force               Force recreate all services
  -v, --verbose         Debug output
  -q, --quiet           Errors only

Phases: ${VALID_PHASES.join(', ')}`)
  process.exit(0)
}

// ── Init ────────────────────────────────────────────────────────────────────

const projectRoot = resolve(process.cwd())
const sharedPaths = getSharedPaths()
const config = loadConfig(projectRoot)
const deployDir = join(projectRoot, config.deploy.stagingDir)

// Build SSH config from host (direct or via cloudflared tunnel per host.sshExpose)
const ssh: SSHConfig = sshConfigFromHost(config.host)

// Logger
const consoleLevel: LogLevel = values.verbose ? 'debug' : values.quiet ? 'error' : 'info'
const logTimestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5)
const logDir = config.deploy.deployLogs !== false
  ? join(projectRoot, config.deploy.deployLogs, logTimestamp)
  : undefined
const log = new Logger(consoleLevel, logDir)

// Load plugins in declaration order
const plugins = await loadPlugins(config.plugins, projectRoot, sharedPaths)

// Build initial compose state
const compose: ComposeState = {
  services: [],
  buildArgs: [],
  upArgs: [],
  profiles: [],
}

// Build deploy context
const ctx: DeployContext = {
  phase: 'init',
  projectRoot,
  sharedPaths,
  deployDir,
  config,
  ssh,
  plugins,
  log,
  // remote: created later if SSH is configured
  errors: [],
  changes: [],
  phaseStatus: [],
  compose,
  report: { data: {} },
  manifest: { destination: '', entries: {} as Record<string, string> },
  registeredFiles: {
    scripts: { dirs: ['plugins', 'crons'], exclude: [] },
    hostFiles: [],
  },
  stopAfter: (values['stop-after'] as DeployPhase | undefined)
    ?? (values.stage ? 'stage' : undefined)
    ?? (values.build ? 'build' : undefined)
    ?? (values['dry-run'] ? 'dry-run' : undefined),
  force: values.force ?? false,
  updateConfig(dotPath: string, value: string) {
    _updateConfig(projectRoot, ctx.config, dotPath, value)
  },
}

// Create remote executor if SSH is configured
if (ssh.host) {
  const rawExecutor = createRemoteExecutor(ssh)
  ctx.remote = createLoggingExecutor(rawExecutor, log)
}

// ── Deploy ──────────────────────────────────────────────────────────────────

log.info('\x1b[1mStack CLI v2 — Deploy\x1b[0m')
log.info(`  Project:   ${projectRoot}`)
log.info(`  Stack:     ${config.stack.projectName}`)
log.info(`  Install:   ${config.stack.installDir}`)
log.info(`  Mode:      ${ctx.stopAfter ? `stop after ${ctx.stopAfter}` : 'full deploy'}`)
log.info(`  Plugins:   ${plugins.map((p) => p.name).join(', ') || 'none'}`)
log.info(`  Logs:      ${logDir ?? 'disabled'}`)
log.info('')

await runDeploy(ctx)

// ── Determine final status ──────────────────────────────────────────────────

const hasFatal = ctx.errors.some(e => e.fatal)
const lastPhase = ctx.phase
const stoppedEarly = ctx.stopAfter === lastPhase

if (hasFatal) {
  ctx.phase = lastPhase // keep the phase where it failed
} else if (stoppedEarly) {
  ctx.phase = lastPhase // keep the phase where it stopped
} else {
  ctx.phase = 'done'
}

// ── Output errors/warnings ──────────────────────────────────────────────────

if (ctx.errors.length > 0) {
  for (const err of ctx.errors) {
    if (err.fatal) {
      log.error(`[${err.phase}] FATAL: ${err.message}`)
    } else {
      log.warn(`[${err.phase}] WARN: ${err.message}`)
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

try {
  const reportPath = renderReport(ctx, logDir)
  log.info(`Report: ${reportPath}`)
} catch (err) {
  log.warn(`Report generation failed: ${err instanceof Error ? err.message : String(err)}`)
}

if (hasFatal) {
  log.error(`\nDeploy failed at ${lastPhase}`)
} else if (stoppedEarly) {
  log.info(`\nDeploy completed (stopped after ${lastPhase})`)
} else {
  log.info('\nDeploy completed')
}

process.exit(hasFatal ? 1 : 0)
