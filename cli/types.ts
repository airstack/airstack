// cli/types.ts

import type { RedactRule } from './lib/redact/rules.js'

// ── Config Types ────────────────────────────────────────────────────────────

export interface HostConfig {
  hostname: string
  timezone: string
  ip: string
  sshUser: string
  sshPort: number
  sshKey: string
  /* User with passwordless sudo - same user as sshUser after hardening is complete */
  sudoUser: string
  sudoUserPassword: string
  /* Stack owner (we suggest "stackroot"): runs the root Docker stack and owns deployed files.
   * Root-equivalent (docker group): no login shell, no SSH, no sudo; only the admin switches to it. */
  appUser: string
  /* Legacy: only set for an app user that needs password login. Unset = locked. */
  appUserPassword: string
  /* Dev accounts (agents, developers): own rootless Docker, never in the docker group. */
  devUsers: string[]
  /* Account that owns Homebrew; other accounts get read-only use via a shim. */
  brewOwner: string
  /* SSH port after hardening is complete */
  sshHardenedPort: number
  /* Port a fresh box answers on before harden (airstack: host.ssh.bootstrapPort; default 22) */
  sshBootstrapPort?: number
  /* How SSH is reached after lockdown:
   *   'public' — SSH port stays open to the internet (direct connections)
   *   'tunnel' — external SSH port is closed; connections route through a
   *              Cloudflare tunnel via `cloudflared access ssh` */
  sshExpose: 'public' | 'tunnel'
  /* Cloudflare Access hostname for SSH when sshExpose === 'tunnel'
   * (e.g. ssh.example.com). Required for tunnel routing. */
  sshTunnelHostname: string
}

export interface TemplateEntry {
  src: string
}

export interface SyncConfig {
  default: 'delete' | 'preserve'
  preserve: string[]
  delete: string[]
}

export interface ReportConfig {
  template: string // path to report template (default: templates/deploy-report.md.hbs)
  destination: string // output path (default: ./deploy-report.md)
  secrets: Array<{ name: string; value: string }> // name-value pairs to show in secrets section
}

export interface DeployConfig {
  sync: SyncConfig
  hooks: Record<string, string>
  report: ReportConfig
  /** Staging directory relative to projectRoot (default: '.deploy') */
  stagingDir: string
  /** Deploy logs directory relative to projectRoot, or false to disable (default: '.deploy-logs') */
  deployLogs: string | false
}

export interface StackConfig {
  /** Absolute path to stack.yml (or override) */
  stackFile: string
  /** Absolute path to env file (default: .env) */
  envFile: string
  /** Whether to skip git safety checks */
  allowUnsafeGit: boolean
}

export interface Config {
  stackConfig: StackConfig
  host: HostConfig
  stack: Record<string, unknown> & { installDir: string; projectName: string }
  templates: Record<string, TemplateEntry>
  plugins: Record<string, unknown>
  deploy: DeployConfig
}

// ── SSH ──────────────────────────────────────────────────────────────────────

export interface SSHConfig {
  host: string
  port: number
  user: string
  keyPath: string
  /* When true, connect through a Cloudflare tunnel using cloudflared
   * instead of a direct TCP connection to host:port. */
  viaTunnel?: boolean
  /* Cloudflare Access hostname to route through when viaTunnel is true. */
  tunnelHostname?: string
}

// ── Remote Executor ─────────────────────────────────────────────────────────

export interface RunOptions {
  /** Called for each line of stdout as it arrives. Output is still buffered in the return value. */
  onStdout?: (line: string) => void
  /** Called for each line of stderr as it arrives. Output is still buffered in the return value. */
  onStderr?: (line: string) => void
  /** Text sent to the remote command's stdin. */
  stdin?: string
}

export interface RemoteExecutor {
  run(command: string, opts?: RunOptions): Promise<{ stdout: string; stderr: string; exitCode: number }>
  rsync(src: string, dest: string, opts?: string[]): Promise<{ exitCode: number }>
  /** rsync from the machine to this controller (remote path → local path). */
  download?(src: string, dest: string, opts?: string[]): Promise<{ exitCode: number }>
}

// ── Logger ──────────────────────────────────────────────────────────────────

export interface DeployLogger {
  error(msg: string): void
  warn(msg: string): void
  info(msg: string): void
  debug(msg: string): void
  setPhase?(phase: string): void
}

// ── Service State Tracking ──────────────────────────────────────────────────
// Accumulates across phases. Hooks read and write this to coordinate
// what gets built, started, and health-checked.

export interface ServiceAction {
  /** Docker Compose service name */
  service: string
  /** What needs to happen */
  action: 'build' | 'recreate' | 'restart' | 'none'
  /** Why — for logging and debugging */
  reason: string
  /** Docker Compose profiles this service belongs to (if any) */
  profiles?: string[]
}

export interface ComposeState {
  /** Services that need action during start phase */
  services: ServiceAction[]
  /** Extra args for `docker compose build` (e.g. --no-cache) */
  buildArgs: string[]
  /** Extra args for `docker compose up` (e.g. --force-recreate) */
  upArgs: string[]
  /** Docker Compose profiles to activate */
  profiles: string[]
  /** No compose file for this unit (e.g. a machine with no sidecar services): skip validate/start. */
  skip?: boolean
}

// ── Deploy Phases ───────────────────────────────────────────────────────────

export type DeployPhase =
  | 'pre-stage'
  | 'stage'
  | 'pre-sync'
  | 'sync'
  | 'post-sync'
  | 'build'
  | 'pre-start'
  | 'dry-run'
  | 'start'
  | 'healthcheck'
  | 'post-deploy'
  | 'validate'

// HookPhase = DeployPhase (hooks can run at any phase)
export type HookPhase = DeployPhase

export interface DeployError {
  phase: string
  message: string
  fatal: boolean
}

export interface StackChange {
  type: string
  name: string
  details: string
}

export interface PhaseStatus {
  phase: string
  message: string
  success: boolean
  warnings?: number
}

export interface PluginCommandContext {
  config: Config
  ssh: SSHConfig
  remote?: RemoteExecutor
  log: DeployLogger
  projectRoot: string
  sharedPaths: string[]
  /** Write a config value to stack.yml (or .env if the key uses a ${VAR} reference). */
  updateConfig: (dotPath: string, value: string) => void
}

export interface PluginCommand {
  description: string
  run: (args: string[], ctx: PluginCommandContext) => Promise<void>
}

export interface ComposeService {
  /** Service name — used for logging and composeServices override matching */
  name: string
  /** HBS template path, relative to plugin sourceDir */
  template: string
}

/** Where a plugin may be configured: machine file plugins, stack plugins, or both. */
export type PluginScope = 'machine' | 'stack' | 'any'

export interface Plugin {
  name: string
  /** Where the plugin may be configured (plans/phase-1.md 4.6). Fleet plugins without it get 'any' + a warning. */
  scope?: PluginScope
  /** Path to the directory containing this plugin's index.ts. Set by plugin loader. */
  sourceDir?: string
  /** Override for deploy source dir. Defaults to {sourceDir}/deploy/ */
  deploySourceDir?: string
  /** Persistent data directory on VPS for runtime data (git repos, instances, build artifacts).
   *  Survives deploys. Distinct from plugins/{name}/ (rsync'd) and STATE_DIR (state files).
   *  Core ensures this directory exists on VPS during post-sync. */
  dataDir?: string
  /** Templates registered by this plugin — merged into stage processing after stack templates */
  templates?: Record<string, TemplateEntry>
  /** Docker Compose service templates contributed by this plugin.
   *  Rendered during stage after all enrichment, injected into docker-compose.yml.hbs.
   *  Users can override via composeServices.template in the plugin's stack.yml config. */
  composeServices?: ComposeService[]
  /** Report section — rendered into the deploy report after all phases */
  report?: ReportSection
  /** CLI sub-commands registered by this plugin */
  commands?: Record<string, PluginCommand>
  hooks?: Partial<Record<HookPhase, (ctx: DeployContext, config: unknown) => Promise<void>>>
  /** Keys that hold secrets in this plugin's files. `airstack machine config read` and diffs redact them. */
  redact?: RedactRule[]
  /**
   * Box-owned config files (relative to the unit install dir). Deploy never writes them, but
   * config history tracks them (pull, machine config read/diff/history, machine rollback).
   */
  tracked?: string[]
}

// ── Registered Files ────────────────────────────────────────────────────────

export interface RegisteredFiles {
  /** Scripts that must have +x. Dirs are scanned for *.sh files. */
  scripts: {
    dirs: string[]       // relative to installDir, e.g. 'plugins', 'crons'
    exclude: string[]    // relative to installDir, e.g. 'plugins/cron/lib/stacks.sh'
  }
  /** Host files deployed outside installDir (logrotate, cron.d, stacks manifest).
   *  Stored as concrete paths (no globs) for deterministic diffing. */
  hostFiles: string[]
  /** Paths (relative to installDir) whose ownership deploy must NOT reset to the stack owner,
   *  e.g. a bind-mounted data dir written by a container that runs as another uid. */
  keepOwner?: string[]
}

// ── Deploy Context ──────────────────────────────────────────────────────────

export interface DeployContext {
  phase: DeployPhase | 'init' | 'done'
  projectRoot: string
  sharedPaths: string[]
  deployDir: string
  config: Config
  ssh: SSHConfig
  plugins: Plugin[]
  log: DeployLogger
  remote?: RemoteExecutor

  /** Accumulated errors across all phases */
  errors: DeployError[]
  /** Detected changes (config drift, image rebuilds, etc.) */
  changes: StackChange[]
  /** Per-phase status messages */
  phaseStatus: PhaseStatus[]
  /** Docker Compose service state — accumulated by hooks, consumed by start */
  compose: ComposeState
  /** Deploy report — accumulated during deploy, rendered at end */
  report: ReportState
  /** Stack manifest — written to {stack.manifestDir}/{project}.env on VPS (default /etc/airstack/stacks/).
   *  Core populates destination + base entries in pre-stage.
   *  Plugins add entries during pre-stage. Stage writes the file. */
  manifest: {
    destination: string
    entries: Record<string, string>
  }

  /** Registry of deployed files — plugins populate during pre-stage.
   *  Core uses for permission checks (pre-sync, post-sync) and orphan cleanup. */
  registeredFiles: RegisteredFiles

  /** Stop pipeline after this phase completes (e.g. 'stage' for --stage, 'dry-run' for --dry-run) */
  stopAfter?: DeployPhase
  force: boolean

  /**
   * Write a config value to stack.yml (or .env if the key uses a ${VAR} reference).
   * Mutates ctx.config in place — no assignment needed.
   *
   * Usage: ctx.updateConfig('stack.myService.apiToken', token)
   *
   * Plugins should use this instead of mutating ctx.config directly.
   */
  updateConfig: (dotPath: string, value: string) => void
}

// ── Report ──────────────────────────────────────────────────────────────────

export interface ReportSection {
  title: string
  template: string // raw Handlebars template
  order?: number // sort hint (default 50, lower = earlier in report)
}

export interface ReportState {
  /** Shared data context — plugins enrich (namespaced by plugin name), templates consume */
  data: Record<string, unknown>
}
