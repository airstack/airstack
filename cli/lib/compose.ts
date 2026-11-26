/**
 * compose.ts — the one place deploy builds `docker compose` commands for the VPS.
 *
 * - always passes `-p <projectName>` (one compose project per stack instance; the install dir's
 *   basename must not decide the project name)
 * - runs as the unit's run user via sudo
 * - dev-user units talk to that user's ROOTLESS daemon: DOCKER_HOST is built from `id -u` on the
 *   box (evaluated as the target user), never from a uid in config
 */

import type { DeployContext } from '../types.js'

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function composeCommand(ctx: Pick<DeployContext, 'config'>, args: string): string {
  const { installDir, projectName } = ctx.config.stack
  const user = ctx.config.host.appUser
  const rootless = (ctx.config.stack as Record<string, unknown>).runUserKind === 'dev'
  const env = rootless ? 'DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock ' : ''
  const inner = `${env}cd ${installDir} && docker compose -p ${projectName} ${args}`.replace(/\s+$/, '')
  // Outer single quotes: $(id -u) expands inside the target user's bash, not the admin's shell.
  return `sudo -u ${user} bash -c ${q(inner)}`
}
