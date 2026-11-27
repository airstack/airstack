// Built-in cron plugin — generates cron entries and deploys cron scripts.
//
// Config schema (under plugins.cron in machines/<m>.yaml or airstack.yaml):
//   default_timezone: America/Los_Angeles
//   crons:
//     backup: "3:00 AM"
//     host_alerter: { schedule: "*/15 * * * *", ... }
//
// Secrets: a cron's `env:` values are NEVER written to /etc/cron.d (that dir is
// world-readable). They go to {installDir}/crons/env.d/<cron>.env (mode 600, owned
// by the cron's user) and the cron line sources that file before running the script.
//
// Hooks:
//   stage    — generate cron entries to <staging>/etc/cron.d/, copy scripts to <staging>/crons/,
//              write per-cron env files to <staging>/crons/env.d/
//              (<staging> = .airstack/deploy/<machine>/<unit>/)
//   post-sync — lock down crons/env.d on the VPS (owner + mode)

import type { Plugin, DeployContext } from '../../types.js'
import { DEFAULT_MANIFEST_DIR } from '../../lib/paths.js'
import { parseScheduleTime as _parseScheduleTime } from '../../lib/schedule-time.js'
import { mkdirSync, writeFileSync, chmodSync, readFileSync, cpSync, readdirSync, existsSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import Handlebars from 'handlebars'
import { resolveFileOptional } from '../../lib/resolve-file.js'
import { BUILTIN_PLUGINS_DIR } from '../../lib/core.js'

// From the core root, not import.meta: a compiled binary ships these files next to it.
const CORE_CRONS_DIR = join(BUILTIN_PLUGINS_DIR, 'cron', 'crons')

// ── Config parsing ──────────────────────────────────────────────────────────

interface CronEntry {
  schedule: string
  script: string
  timezone: string
  user: string
  vars: Record<string, string>
}

interface CronPluginConfig {
  defaultTimezone: string
  crons: Record<string, CronEntry>
}

function isCronExpr(s: string): boolean {
  return /^[*\d/,\-]+(\s+[*\d/,\-]+){4}$/.test(s.trim())
}

/**
 * Parse a schedule string. If it looks like a cron expression, use as-is.
 * Otherwise, try to parse as human-readable time (daily schedule).
 * Returns { cronExpr, timezone }.
 */
function parseSchedule(schedule: string, key: string): { cronExpr: string; timezone: string } {
  if (isCronExpr(schedule)) {
    return { cronExpr: schedule, timezone: '' }
  }
  // Defer to the schedule-time parser — imported at top level
  const parsed = _parseScheduleTime(schedule, `crons.${key}.schedule`)
  return { cronExpr: parsed.cronExpr, timezone: parsed.ianaTz }
}

function parseCronEntry(key: string, value: string | Record<string, unknown>, defaultTimezone: string): CronEntry {
  // For prefixed keys (myplugin/some_job), default script is the part after /
  const scriptBase = key.includes('/') ? key.split('/').slice(1).join('_') : key
  const defaultScript = `${scriptBase}.sh`

  if (typeof value === 'string') {
    const parsed = parseSchedule(value, key)
    return {
      schedule: parsed.cronExpr,
      script: defaultScript,
      user: 'root',
      timezone: parsed.timezone || defaultTimezone,
      vars: {},
    }
  }

  const rawSchedule = typeof value.schedule === 'string' ? value.schedule : ''
  const parsed = parseSchedule(rawSchedule, key)
  const script = typeof value.script === 'string' ? value.script : defaultScript
  const user = typeof value.user === 'string' ? value.user : 'root'
  const entryTz = typeof value.timezone === 'string' ? value.timezone : ''
  const timezone = parsed.timezone || entryTz || defaultTimezone

  const vars: Record<string, string> = {}
  const rawEnv = value.env as Record<string, unknown> | undefined
  if (rawEnv && typeof rawEnv === 'object') {
    for (const [k, v] of Object.entries(rawEnv)) {
      vars[k] = String(v ?? '')
    }
  }

  return { schedule: parsed.cronExpr, script, user, timezone, vars }
}

export { parseConfig as parseConfigForTest }

function parseConfig(raw: unknown): CronPluginConfig {
  const obj = (raw || {}) as Record<string, unknown>
  const defaultTimezone = String(obj.defaultTimezone || '')
  const rawCrons = (obj.crons || {}) as Record<string, unknown>

  const crons: Record<string, CronEntry> = {}
  for (const [key, value] of Object.entries(rawCrons)) {
    if (typeof value === 'string' || (typeof value === 'object' && value !== null)) {
      crons[key] = parseCronEntry(key, value as string | Record<string, unknown>, defaultTimezone)
    }
  }

  // reportTitle: the first line of host reports and alerts (e.g. "📊 VPS web-1"). It goes to the
  // env of every host_ cron, unless that cron sets REPORT_TITLE itself.
  if (obj.reportTitle !== undefined) {
    const title = String(obj.reportTitle)
    if (!title.trim() || /[\r\n]/.test(title) || title.length > 80) {
      throw new Error('cron reportTitle must be one line of 1-80 characters')
    }
    for (const [key, entry] of Object.entries(crons)) {
      if (key.startsWith('host_') && entry.vars.REPORT_TITLE === undefined) entry.vars.REPORT_TITLE = title
    }
  }

  return { defaultTimezone, crons }
}

// ── Cron file generation ────────────────────────────────────────────────────

/** Shell-safe single-quoted value for the sourced env file. */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

export function envFileName(cronFilename: string): string {
  return `${cronFilename}.env`
}

/** Contents of a cron's secret env file (sourced by /bin/sh; exported via set -a). */
export function generateEnvFile(vars: Record<string, string>): string {
  const lines = ['# Generated by airstack — DO NOT EDIT. Secrets: keep mode 600.']
  for (const [k, v] of Object.entries(vars)) lines.push(`${k}=${shellQuote(v)}`)
  lines.push('')
  return lines.join('\n')
}

function generateCronFile(entry: CronEntry, installDir: string, projectName: string, cronFilename: string): string {
  const [scriptPart, ...argParts] = entry.script.split(' ')
  const args = argParts.length > 0 ? ' ' + argParts.join(' ') : ''

  const resolvedScript = scriptPart.startsWith('/')
    ? scriptPart
    : `${installDir}/crons/${scriptPart}`

  const logName = basename(scriptPart).replace(/\.sh$/, '')
  const logPath = `${installDir}/logs/${logName}.log`

  const lines: string[] = ['# Generated by airstack — DO NOT EDIT']
  if (entry.timezone) lines.push(`CRON_TZ=${entry.timezone}`)
  // Env values are secrets: load them from a private file, never inline in /etc/cron.d.
  const envPrefix = Object.keys(entry.vars).length > 0
    ? `set -a; . ${installDir}/crons/env.d/${envFileName(cronFilename)}; set +a; `
    : ''
  lines.push(`${entry.schedule} ${entry.user} ${envPrefix}${resolvedScript}${args} >> ${logPath} 2>&1`)
  lines.push('')

  return lines.join('\n')
}

// ── Hook implementations ────────────────────────────────────────────────────

async function preStageHook(ctx: DeployContext, raw: unknown): Promise<void> {
  const config = parseConfig(raw)
  const { projectName } = ctx.config.stack

  // Register sourced library (not directly executed)
  ctx.registeredFiles.scripts.exclude.push('plugins/cron/lib/stacks.sh', 'plugins/cron/lib/report.sh')
  // Per-stack security checks (project deploy/security.d/*.sh, run by host_security.sh) must be executable
  if (!ctx.registeredFiles.scripts.dirs.includes('security.d')) ctx.registeredFiles.scripts.dirs.push('security.d')

  // Register host files: /etc/cron.d/{projectName}_{deployName} for each cron
  for (const key of Object.keys(config.crons)) {
    const deployName = key.includes('/') ? key.replace(/\//g, '_') : key
    ctx.registeredFiles.hostFiles.push(`/etc/cron.d/${projectName}_${deployName}`)
  }

  // Register stack manifest and logrotate config
  const manifestDir = String((ctx.config.stack as any).manifestDir || DEFAULT_MANIFEST_DIR)
  ctx.registeredFiles.hostFiles.push(`${manifestDir}/${projectName}.env`)
  ctx.registeredFiles.hostFiles.push(`/etc/logrotate.d/${projectName}`)

  const cronCount = Object.keys(config.crons).length
  const hostFileCount = ctx.registeredFiles.hostFiles.length
  ctx.log.info(`[cron] Registered ${cronCount} cron(s), ${hostFileCount} host file(s)`)
}

function stageLogrotate(deployDir: string, installDir: string, projectName: string): void {
  const logrotateDir = join(deployDir, 'etc', 'logrotate.d')
  mkdirSync(logrotateDir, { recursive: true })

  const content = `# Generated by airstack — DO NOT EDIT
# Log rotation for stack: ${projectName}

${installDir}/logs/*.log
{
    su root root
    daily
    rotate 7
    maxsize 50M
    missingok
    notifempty
    copytruncate
    delaycompress
    compress
}
`
  writeFileSync(join(logrotateDir, projectName), content)
}

async function stageHook(ctx: DeployContext, raw: unknown): Promise<void> {
  const config = parseConfig(raw)
  const { deployDir, projectRoot, sharedPaths } = ctx
  const { installDir, projectName } = ctx.config.stack

  // Generate logrotate config (always, even with no crons)
  stageLogrotate(deployDir, installDir, projectName)

  if (Object.keys(config.crons).length === 0) return

  // Generate cron entries → <staging>/etc/cron.d/
  const cronDir = join(deployDir, 'etc', 'cron.d')
  mkdirSync(cronDir, { recursive: true })

  // Resolve and copy cron scripts → <staging>/crons/
  const cronsDeployDir = join(deployDir, 'crons')
  mkdirSync(cronsDeployDir, { recursive: true })

  for (const [key, entry] of Object.entries(config.crons)) {
    const isPrefixed = key.includes('/')
    const deployName = isPrefixed ? key.replace(/\//g, '_') : key
    const scriptFile = entry.script.split(/\s+/)[0]
    const scriptArgs = entry.script.split(/\s+/).slice(1).join(' ')

    // The deployed script name (what goes in <staging>/crons/)
    const deployScriptName = isPrefixed ? `${deployName}.sh` : scriptFile

    // Generate cron entry file
    const cronFilename = `${projectName}_${deployName}`
    // Build cron entry with the deployed script name
    const cronEntry: CronEntry = {
      ...entry,
      script: scriptArgs ? `${deployScriptName} ${scriptArgs}` : deployScriptName,
    }
    writeFileSync(join(cronDir, cronFilename), generateCronFile(cronEntry, installDir, projectName, cronFilename))

    // Secret env values → private env file (mode 600), not the world-readable cron.d entry
    if (Object.keys(entry.vars).length > 0) {
      const envDir = join(cronsDeployDir, 'env.d')
      mkdirSync(envDir, { recursive: true })
      const envPath = join(envDir, envFileName(cronFilename))
      writeFileSync(envPath, generateEnvFile(entry.vars), { mode: 0o600 })
      chmodSync(envPath, 0o600)
    }

    // Resolve the script source file
    let resolvedPath: string | undefined
    let isHbs = false

    if (isPrefixed) {
      // Prefixed: plugins/{prefix}/crons/{script}.sh
      const [prefix, ...rest] = key.split('/')
      const prefixedScript = `${rest.join('_')}.sh`

      const hbsPath = resolveFileOptional(projectRoot, sharedPaths, `plugins/${prefix}/crons/${prefixedScript}.hbs`)
      if (hbsPath) { resolvedPath = hbsPath; isHbs = true }
      else { resolvedPath = resolveFileOptional(projectRoot, sharedPaths, `plugins/${prefix}/crons/${prefixedScript}`) }
    } else {
      // Non-prefixed fallback chain:
      // 1. Local project crons/
      const localHbs = join(projectRoot, 'crons', `${scriptFile}.hbs`)
      const localPlain = join(projectRoot, 'crons', scriptFile)
      if (existsSync(localHbs)) { resolvedPath = localHbs; isHbs = true }
      else if (existsSync(localPlain)) { resolvedPath = localPlain }

      // 2. Core cron shims (cli/plugins/cron/crons/)
      if (!resolvedPath) {
        const coreHbs = join(CORE_CRONS_DIR, `${scriptFile}.hbs`)
        const corePlain = join(CORE_CRONS_DIR, scriptFile)
        if (existsSync(coreHbs)) { resolvedPath = coreHbs; isHbs = true }
        else if (existsSync(corePlain)) { resolvedPath = corePlain }
      }

      // 3. Shared paths fallback
      if (!resolvedPath) {
        for (const shared of sharedPaths) {
          const sharedHbs = join(shared, 'crons', `${scriptFile}.hbs`)
          const sharedPlain = join(shared, 'crons', scriptFile)
          if (existsSync(sharedHbs)) { resolvedPath = sharedHbs; isHbs = true; break }
          if (existsSync(sharedPlain)) { resolvedPath = sharedPlain; break }
        }
      }
    }

    // Copy/render the resolved script
    if (resolvedPath && isHbs) {
      const tmplSrc = readFileSync(resolvedPath, 'utf-8')
      const tmpl = Handlebars.compile(tmplSrc, { noEscape: true })
      writeFileSync(join(cronsDeployDir, deployScriptName), tmpl({ ...entry.vars, stack: ctx.config.stack, host: ctx.config.host }))
    } else if (resolvedPath) {
      cpSync(resolvedPath, join(cronsDeployDir, deployScriptName))
    } else {
      const searchHint = isPrefixed
        ? `plugins/${key.split('/')[0]}/crons/${scriptFile}`
        : `crons/${scriptFile}`
      ctx.errors.push({
        phase: 'stage',
        message: `Cron script not found for '${key}': ${searchHint}`,
        fatal: true,
      })
    }
  }

  // Plugin .env.hbs is registered as a template (processed by stage phase)

  // Populate report data (namespaced under cron)
  ctx.report.data.cron = {
    entries: Object.entries(config.crons).map(([key, entry]) => {
      const deployName = key.includes('/') ? key.replace(/\//g, '_') : key
      const scriptFile = entry.script.split(/\s+/)[0]
      return {
        name: deployName,
        schedule: entry.schedule,
        user: entry.user,
        timezone: entry.timezone,
        script: key.includes('/') ? `${deployName}.sh` : scriptFile,
      }
    }),
  }

  ctx.log.info(`[cron] Staged ${Object.keys(config.crons).length} cron(s)`)
}

// post-sync: sync's `chown -R appUser` and rsync leave env files owned by the app
// user. Hand them to the cron's user (root by default) and close the group/world bits.
async function postSyncHook(ctx: DeployContext, raw: unknown): Promise<void> {
  if (!ctx.remote) return
  const config = parseConfig(raw)
  const { installDir, projectName } = ctx.config.stack
  const envDir = `${installDir}/crons/env.d`
  const secretCrons = Object.entries(config.crons).filter(([, e]) => Object.keys(e.vars).length > 0)
  if (secretCrons.length === 0) return // stale env files from removed crons go away with sync --delete
  const cmds = [`sudo chown root:root ${envDir}`, `sudo chmod 711 ${envDir}`]
  for (const [key, entry] of secretCrons) {
    const deployName = key.includes('/') ? key.replace(/\//g, '_') : key
    const file = `${envDir}/${envFileName(`${projectName}_${deployName}`)}`
    if (!/^[a-z_][a-z0-9_-]*$/i.test(entry.user)) {
      ctx.errors.push({ phase: 'post-sync', message: `[cron] will not give the env file to user '${entry.user}': the user name is not safe`, fatal: false })
      continue
    }
    cmds.push(`sudo chown ${entry.user}:root ${file}`, `sudo chmod 600 ${file}`)
  }
  const r = await ctx.remote.run(cmds.join(' && '))
  if (r.exitCode !== 0) {
    ctx.errors.push({ phase: 'post-sync', message: `[cron] could not set owner-only permissions on ${envDir}: ${r.stderr.trim()}`, fatal: true })
  }
}

// ── Plugin registration ─────────────────────────────────────────────────────
// Note: /etc/ file promotion (cron.d, stacks, logrotate.d) is handled by
// core post-sync phase, not this plugin. The cron plugin only stages files.

/** Host scripts (host-status/) ship only to a unit that runs a host_ cron (the machine unit). */
function usesHostScripts(config: unknown): boolean {
  const crons = (config as { crons?: Record<string, unknown> } | null)?.crons ?? {}
  return Object.keys(crons).some((name) => name.startsWith('host_'))
}

export function register(config: unknown): Plugin {
  return {
    name: 'cron',
    scope: 'any',
    ...(usesHostScripts(config) ? {} : { deployExclude: ['host-status'] }),
    templates: {
      'crons/.env': { src: 'templates/.env.hbs' },
    },
    report: {
      title: 'Cron Jobs',
      order: 30,
      template: `{{#if cron.entries}}| Name | Schedule | User | Timezone |
|---|---|---|---|
{{#each cron.entries}}| {{this.name}} | \`{{this.schedule}}\` | {{this.user}} | {{this.timezone}} |
{{/each}}{{else}}No cron jobs configured.{{/if}}`,
    },
    hooks: {
      'pre-stage': preStageHook,
      stage: stageHook,
      'post-sync': postSyncHook,
    },
  }
}
