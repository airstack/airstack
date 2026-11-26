// Shared types for the fleet loader: fleet, machine, host, stack instance, issue, plugin ref.

import type { Plain } from '../merge.js'

export interface Issue {
  level: 'fail' | 'warn'
  /** Path relative to the fleet root when possible. */
  file: string
  /** Config key path inside the file, if any. */
  key?: string
  message: string
}

export interface Fleet {
  root: string
  name: string
  versionPin?: string
  machines: MachineRef[]
  issues: Issue[]
}

export interface MachineRef {
  name: string
  file: string
  /** Set for the dir form (machines/<m>/). */
  dir?: string
}

export interface HostConfig {
  hostname: string
  ip: string
  timezone: string
  /** port/user = the FINISHED machine; bootstrap* = a fresh box before setup (used only by --install). */
  ssh: { user: string; port: number; key: string; hardenedPort: number; bootstrapPort: number; bootstrapUser: string; expose: 'public' | 'tunnel'; tunnelHostname: string }
  /** admins: members of the airstack-admin group (may run `airstack machine …` without full sudo). */
  users: { sudo: string; stack: string; dev: string[]; brewOwner: string; admins: string[] }
  dockerSubnet: string
}

export interface StackInstance {
  name: string
  ref: string
  source: 'fleet' | 'builtin'
  stackDir: string
  stackFile: string
  user: string
  userKind: 'stack' | 'dev'
  installDir: string
  composeProject: string
  /** Merged config (secrets resolved). */
  config: Plain
  /** Same tree with `${NAME}` left in place, safe to print. */
  display: Plain
  origins: Map<string, string>
}

export interface Machine {
  name: string
  file: string
  dir?: string
  host: HostConfig
  root: string
  /** host + root with `${NAME}` left in place, safe to print. */
  displayHost: Plain
  /** Machine-scope plugin refs → config (secrets resolved). */
  plugins: Record<string, unknown>
  displayPlugins: Record<string, unknown>
  instances: StackInstance[]
  /** Secret names referenced anywhere for this machine (redaction list later). */
  secretsUsed: string[]
  /** Secret values (for redaction). Never print. */
  secretValues: string[]
  /** All secrets for this machine (_fleet + machine file). Never print. */
  secrets: Record<string, string>
  issues: Issue[]
}

export type PluginRef =
  | { ok: true; ref: string; name: string; source: 'fleet' | 'builtin'; path: string }
  | { ok: false; ref: string; message: string }
