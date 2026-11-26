// Shared setup types, the per-run context, and small helpers used by every step.

import type { Config } from '../types.js'
import type { createRemoteExecutor } from '../lib/ssh.js'
import { detectDistro } from '../lib/remote-script.js'

export class SetupFailed extends Error {}

export interface SetupFlags {
  finalize?: boolean
  sysbox?: boolean
  undo?: boolean
  force?: boolean
  noLockRoot?: boolean
  distro?: string
  /** Part of a full --install run: skip the "next steps" hints (--install does those steps). */
  quiet?: boolean
}

export interface SetupOptions {
  config: Config
  /** Where setup scripts are looked up (deploy/setup/<distro>/<step>.sh). */
  projectRoot: string
  sharedPaths: string[]
  flags?: SetupFlags
  /** Persist a generated secret (e.g. SUDO_USER_PASSWORD) to the machine's secrets file. */
  persistSecret: (key: string, value: string) => void
}

/** Everything a step needs for one run. runVpsSetup builds it; one step runs at a time. */
export interface SetupContext {
  config: Config
  projectRoot: string
  sharedPaths: string[]
  flags: Required<Omit<SetupFlags, 'distro'>> & { distro?: string }
  ssh: { host: string; port: number; user: string; keyPath: string }
  remote: ReturnType<typeof createRemoteExecutor>
  persistSecret: (key: string, value: string) => void
}

export const fail = (msg: string): never => {
  throw new SetupFailed(msg)
}

export async function getDistro(ctx: SetupContext): Promise<string> {
  if (ctx.flags.distro) return ctx.flags.distro
  return detectDistro(ctx.remote)
}

/** Sysbox is opt-in: `sysbox` flag or `sysbox: true` on the unit. */
export function sysboxEnabled(ctx: SetupContext): boolean {
  return ctx.flags.sysbox || String((ctx.config.stack as Record<string, unknown>).sysbox) === 'true'
}
