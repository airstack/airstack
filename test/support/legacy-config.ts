/**
 * legacy-config.ts — test support only. Builds a deploy Config from a stack-cli style project
 * (stack.yml + .env). The plugin and phase tests use it to make contexts; airstack itself builds
 * Configs from the fleet model (cli/lib/units.ts).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import * as dotenv from 'dotenv'
import { resolveDefaults } from '../../cli/lib/defaults.js'
import { resolveTz } from '../../cli/lib/schedule-time.js'
import type { Config, HostConfig, DeployConfig, TemplateEntry, StackConfig } from '../../cli/types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve ${VAR} and ${VAR:-default} references in a YAML text string.
 * Comment lines (trimmed lines starting with #) are left untouched.
 */
export function resolveEnvRefs(text: string, env: Record<string, string>): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('#')) return line
      return line.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
        const defaultMatch = expr.match(/^([^:]+):-(.*)$/)
        if (defaultMatch) {
          const key = defaultMatch[1]
          const defaultVal = defaultMatch[2]
          return env[key] !== undefined && env[key] !== '' ? env[key] : defaultVal
        }
        return env[expr] ?? ''
      })
    })
    .join('\n')
}

/**
 * Returns stack.yml with resolved ${VAR} values from .env
 * @param projectRoot
 * @returns
 */
export function resolvedStackYml(projectRoot: string, envFile?: string): string {
  const envPath = envFile || join(projectRoot, '.env')
  const stackRaw = readFileSync(join(projectRoot, 'stack.yml'), 'utf-8')
  const env = existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {}
  return resolveEnvRefs(stackRaw, env)
}

/**
 * Parse deploy.report.secrets from stack.yml.
 * Supports list of "Name: value" strings or list of {name, value} objects.
 */
function parseSecrets(raw: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      if (typeof entry === 'string') {
        // "Label: value" format
        const colonIdx = entry.indexOf(':')
        if (colonIdx > 0) {
          return { name: entry.slice(0, colonIdx).trim(), value: entry.slice(colonIdx + 1).trim() }
        }
        return { name: entry, value: '' }
      }
      if (typeof entry === 'object' && entry !== null) {
        // { name: "Label", value: "secret" } or { "Label": "secret" }
        const obj = entry as Record<string, unknown>
        if (obj.name && obj.value !== undefined) {
          return { name: String(obj.name), value: String(obj.value) }
        }
        // Single key-value: { "Label": "secret" }
        const keys = Object.keys(obj)
        if (keys.length === 1) {
          return { name: keys[0], value: String(obj[keys[0]] ?? '') }
        }
      }
      return null
    })
    .filter((s): s is { name: string; value: string } => s !== null)
}

// ── loadConfig ───────────────────────────────────────────────────────────────

/**
 * Load and normalize all config from .env and stack.yml.
 *
 * - .env is optional (missing is treated as empty)
 * - stack.yml is required (throws if missing)
 * - ${VAR} / ${VAR:-default} references resolved from .env
 * - <<+ keys resolved via resolveDefaults()
 * - Typed Config returned with all fields populated
 */
/** Accepts a YAML list or a space/comma-separated string (from .env). */
function parseList(v: unknown): string[] {
  const items = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\s,]+/)
  return items.map((s) => s.trim()).filter(Boolean)
}

export function loadConfig(projectRoot: string): Config {
  // 1. Load stack.yml (required) — needed for bootstrap pre-parse
  const stackPath = resolve(projectRoot, 'stack.yml')
  if (!existsSync(stackPath)) {
    throw new Error('stack.yml not found')
  }
  const stackRaw = readFileSync(stackPath, 'utf-8')

  // 2. Pre-parse stack.yml to get envFile (bootstrap — can't use ${VAR} here)
  const rawPreParse = yaml.load(stackRaw) as Record<string, unknown>
  const rawStackPre = (rawPreParse?.stack ?? {}) as Record<string, unknown>
  const envFileName = process.env.STACK_CLI_ENV_FILE || String(rawStackPre.envFile || '.env')
  const envPath = resolve(projectRoot, envFileName)

  // 3. Load .env (optional)
  const env: Record<string, string> = existsSync(envPath)
    ? (dotenv.parse(readFileSync(envPath)) as Record<string, string>)
    : {}

  // 4. Resolve ${VAR} and ${VAR:-default} references using .env values
  const stackResolved = resolveEnvRefs(stackRaw, env)

  // 5. Parse YAML
  const rawParsed = yaml.load(stackResolved) as Record<string, unknown>

  // 6. Resolve <<+ across the entire tree
  const raw = resolveDefaults(rawParsed)

  // 7. Extract raw sections
  const rawHost = (raw.host ?? {}) as Record<string, unknown>
  const rawStack = (raw.stack ?? {}) as Record<string, unknown>
  const rawTemplates = (raw.templates ?? {}) as Record<string, unknown>
  const rawPlugins = (raw.plugins ?? {}) as Record<string, unknown>
  const rawDeploy = (raw.deploy ?? {}) as Record<string, unknown>

  // 8. Validate required stack fields
  const installDir = String(rawStack.installDir ?? '')
  if (!installDir) {
    throw new Error('stack.yml missing required field: stack.installDir')
  }

  const projectName = String(rawStack.projectName ?? '')
  if (!projectName) {
    throw new Error('stack.yml missing required field: stack.projectName')
  }

  // 9. Build HostConfig — SSH values fall back to .env
  const host: HostConfig = {
    hostname: String(rawHost.hostname ?? ''),
    timezone: resolveTz(String(rawHost.timezone ?? '')),
    ip: String(rawHost.ip ?? env.SSH_IP ?? ''),
    sshUser: String(rawHost.sshUser ?? env.SSH_USER ?? 'root'),
    sshPort: rawHost.sshPort
      ? Number(rawHost.sshPort)
      : env.SSH_PORT
      ? parseInt(env.SSH_PORT, 10)
      : 22,
    sshKey: String(rawHost.sshKey ?? env.SSH_KEY ?? ''),
    sshHardenedPort: Number(rawHost.sshHardenedPort ?? env.SSH_HARDENED_PORT ?? 0),
    /* Users created by vps-setup during hardening */
    sudoUser: String(rawHost.sudoUser ?? env.SUDO_USER ?? 'adminuser'),
    sudoUserPassword: String(rawHost.sudoUserPassword ?? env.SUDO_USER_PASSWORD ?? ''),
    appUser: String(rawHost.appUser ?? env.APP_USER ?? 'appuser'),
    appUserPassword: String(rawHost.appUserPassword ?? env.APP_USER_PASSWORD ?? ''),
    devUsers: parseList(rawHost.devUsers ?? env.DEV_USERS),
    brewOwner: String(rawHost.brewOwner ?? env.BREW_OWNER ?? ''),
    /* SSH exposure mode — 'public' (default) or 'tunnel' (via cloudflared) */
    sshExpose:
      (String(rawHost.sshExpose ?? env.SSH_EXPOSE ?? 'public').toLowerCase() === 'tunnel'
        ? 'tunnel'
        : 'public'),
    sshTunnelHostname: String(rawHost.sshTunnelHostname ?? env.SSH_TUNNEL_HOSTNAME ?? ''),
  }

  // Set default for sshHardenedPort if not set
  if (!host.sshHardenedPort) {
    host.sshHardenedPort = host.sshPort !== 22 ? host.sshPort : 222
  }

  // 10. Parse templates section
  // Supports string form (dest: src) and object form (dest: { src: path })
  const templates: Record<string, TemplateEntry> = {}
  for (const [dest, value] of Object.entries(rawTemplates)) {
    if (typeof value === 'string') {
      templates[dest] = { src: value }
    } else if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      templates[dest] = { src: String(obj.src ?? '') }
    }
  }

  // 11. Parse plugins section
  const plugins: Record<string, unknown> = { ...rawPlugins }

  // 12. Parse deploy section
  const rawSync = (rawDeploy.sync ?? {}) as Record<string, unknown>
  const rawHooks = (rawDeploy.hooks ?? {}) as Record<string, string>

  const rawReport = (rawDeploy.report ?? {}) as Record<string, unknown>
  const deploy: DeployConfig = {
    sync: {
      default: (rawSync.default as 'delete' | 'preserve') ?? 'delete',
      preserve: Array.isArray(rawSync.preserve) ? (rawSync.preserve as string[]) : [],
      delete: Array.isArray(rawSync.delete) ? (rawSync.delete as string[]) : [],
    },
    hooks: typeof rawHooks === 'object' && rawHooks !== null ? rawHooks : {},
    report: {
      template: String(rawReport.template || 'templates/deploy-report.md.hbs'),
      destination: String(rawReport.destination || './deploy-report.md'),
      secrets: parseSecrets(rawReport.secrets),
    },
    stagingDir: String(rawDeploy.stagingDir || '.deploy'),
    deployLogs:
      rawDeploy.deployLogs === false ? false : String(rawDeploy.deployLogs || '.deploy-logs'),
  }

  // 13. Build stack record — all fields preserved, required fields typed
  const stack = {
    ...rawStack,
    installDir,
    projectName,
  } as Record<string, unknown> & { installDir: string; projectName: string }

  // 14. Build StackConfig
  const stackConfig: StackConfig = {
    stackFile: stackPath,
    envFile: envPath,
    allowUnsafeGit:
      process.env.STACK_CLI_ALLOW_UNSAFE_GIT === '1' ||
      process.env.STACK_CLI_ALLOW_UNSAFE_GIT === 'true' ||
      env.STACK_CLI_ALLOW_UNSAFE_GIT === '1' ||
      env.STACK_CLI_ALLOW_UNSAFE_GIT === 'true',
  }

  return { stackConfig, host, stack, templates, plugins, deploy }
}
