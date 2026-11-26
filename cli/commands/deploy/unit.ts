/**
 * unit.ts — deploy one unit (the machine unit or a stack instance) through the deploy pipeline,
 * and prune an instance that left the machine file.
 */

import { join } from 'node:path'
import type { Fleet } from '../../lib/fleet.js'
import { loadPluginRef } from '../../lib/fleet-check.js'
import type { DeployUnit } from '../../lib/units.js'
import { runDeploy } from '../../deploy/runner.js'
import { createLoggingExecutor, sshConfigFromHost } from '../../lib/ssh.js'
import { renderReport } from '../../lib/report.js'
import { Logger } from '../../lib/logger.js'
import { composeCommand } from '../../lib/compose.js'
import { historyPlugin } from '../../lib/history-hooks.js'
import type { MarkerStack } from '../../lib/marker.js'
import type { DeployContext, DeployPhase, Plugin, RemoteExecutor } from '../../types.js'
import type { Flags } from './flags.js'

export interface UnitResult {
  ok: boolean
  note: string
  logDir: string
}

export async function deployUnit(fleet: Fleet, unit: DeployUnit, f: Flags, fleetCommit: string, remote?: RemoteExecutor): Promise<UnitResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5)
  const logDir = join(unit.logRoot, stamp)
  const log = new Logger(f.verbose ? 'info' : 'error', logDir)

  const plugins: Plugin[] = []
  for (const { ref, config } of unit.pluginRefs) {
    try {
      plugins.push((await loadPluginRef(fleet.root, ref, config)).plugin)
    } catch (e) {
      return { ok: false, note: `plugin ${ref}: ${e instanceof Error ? e.message : String(e)}`, logDir }
    }
  }
  const hasServices = unit.hasComposeTemplate || plugins.some((p) => p.composeServices?.length)
  if (!hasServices) delete unit.config.templates['docker-compose.yml']
  // Last, so its stage hook sees every file the other plugins staged.
  plugins.push(historyPlugin({
    nodeUnit: unit.kind === 'machine' ? 'machine' : unit.name,
    machineDeployDir: join(unit.deployDir, '..'),
    fleetCommit,
    force: f.force,
  }))

  const ctx: DeployContext = {
    phase: 'init',
    projectRoot: unit.projectRoot,
    sharedPaths: unit.sharedPaths,
    deployDir: unit.deployDir,
    config: unit.config,
    ssh: sshConfigFromHost(unit.config.host),
    plugins,
    log,
    remote: remote ? createLoggingExecutor(remote, log) : undefined,
    errors: [],
    changes: [],
    phaseStatus: [],
    compose: { services: [], buildArgs: [], upArgs: f.force ? ['--force-recreate'] : [], profiles: [], skip: !hasServices },
    report: { data: {} },
    manifest: { destination: '', entries: {} },
    registeredFiles: { scripts: { dirs: ['plugins', 'crons'], exclude: [] }, hostFiles: [] },
    stopAfter: (f.stage ? 'stage' : f.dryRun ? 'dry-run' : undefined) as DeployPhase | undefined,
    force: f.force,
    updateConfig(dotPath: string) {
      throw new Error(`updateConfig(${dotPath}) is not supported for fleet deploys yet: put the value in .airstack/secrets/${unit.machine}.jsonc`)
    },
  }

  await runDeploy(ctx)
  try { renderReport(ctx, logDir) } catch { /* report is best effort */ }

  const fatal = ctx.errors.filter((e) => e.fatal)
  const warns = ctx.errors.filter((e) => !e.fatal)
  for (const w of warns) log.warn(`[${w.phase}] ${w.message}`)
  if (fatal.length) return { ok: false, note: `${fatal[0].phase}: ${fatal[0].message.split('\n')[0]}`, logDir }
  const what = f.stage ? 'staged' : f.dryRun ? 'synced + validated' : hasServices ? 'deployed' : 'deployed (no compose services)'
  return { ok: true, note: `${what}${warns.length ? `, ${warns.length} warning(s): ${warns[0].message.split('\n')[0]}` : ''}`, logDir }
}

export async function pruneInstance(remote: RemoteExecutor, s: MarkerStack): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(s.composeProject) || !/^\/[\w./-]+$/.test(s.installDir) || !/^[a-z_][a-z0-9_-]*$/.test(s.user)) return false
  const ctx = { config: { host: { appUser: s.user }, stack: { installDir: s.installDir, projectName: s.composeProject, runUserKind: s.userKind } } } as unknown as DeployContext
  const down = await remote.run(`${composeCommand(ctx, 'down')} 2>&1`)
  await remote.run(`sudo rm -f /etc/cron.d/${s.composeProject}_* /etc/logrotate.d/${s.composeProject} /etc/airstack/stacks/${s.composeProject}.env /etc/stacks/${s.composeProject}.env`)
  return down.exitCode === 0
}
