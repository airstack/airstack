/**
 * setup — VPS provisioning steps, driven by `airstack deploy <machine> --install [--step <s>]`.
 *
 * Steps:
 *   base        packages, hostname, users (admin, stack owner, dev users)
 *   harden      UFW, SSH, swap, fail2ban, sysctl (opens host.ssh.port; --finalize closes the bootstrap port)
 *   reboot      reboot and wait for SSH
 *   docker      Docker CE + daemon hardening (sysbox via stack sysbox: true)
 *   rootless    rootless Docker for each dev user (host.users.dev)
 *   brew-shim   one Homebrew owner; read-only brew for other accounts
 *   tailscale   install Tailscale + join the tailnet (machine plugin airstack/tailscale)
 *   verify      check everything is ready for deploy
 *   lockdown    close external SSH, route via the Cloudflare tunnel
 *
 * Failures throw SetupFailed (no process.exit), so a multi-machine run can report and continue.
 */
import { createRemoteExecutor } from '../lib/ssh.js'
import { fail, type SetupContext, type SetupOptions } from './context.js'
import { cmdBase, cmdHarden } from './base-harden.js'
import { cmdReboot } from './reboot.js'
import { cmdDocker, cmdRootless } from './docker.js'
import { cmdBrewShim, cmdTailscale } from './misc.js'
import { cmdVerify } from './verify.js'
import { cmdLockdown } from './lockdown.js'

export { SetupFailed, type SetupFlags, type SetupOptions } from './context.js'

export const SETUP_STEPS = ['base', 'harden', 'reboot', 'docker', 'rootless', 'brew-shim', 'tailscale', 'verify', 'lockdown'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export async function runVpsSetup(step: SetupStep, opts: SetupOptions): Promise<void> {
  const config = opts.config
  const f = opts.flags ?? {}
  const flags = {
    finalize: !!f.finalize, sysbox: !!f.sysbox, undo: !!f.undo, force: !!f.force, noLockRoot: !!f.noLockRoot,
    quiet: !!f.quiet, distro: f.distro,
  }
  const ssh = { host: config.host.ip, port: config.host.sshPort, user: config.host.sshUser, keyPath: config.host.sshKey }
  if (!ssh.host) fail('No machine address: set host.ip in the machine file.')
  const ctx: SetupContext = {
    config, projectRoot: opts.projectRoot, sharedPaths: opts.sharedPaths, flags, ssh,
    remote: createRemoteExecutor(ssh), persistSecret: opts.persistSecret,
  }

  switch (step) {
    case 'base': return cmdBase(ctx)
    case 'harden': return cmdHarden(ctx)
    case 'reboot': return cmdReboot(ctx)
    case 'docker': return cmdDocker(ctx)
    case 'tailscale': return cmdTailscale(ctx)
    case 'rootless': return cmdRootless(ctx)
    case 'brew-shim': return cmdBrewShim(ctx)
    case 'verify': return cmdVerify(ctx)
    case 'lockdown': return cmdLockdown(ctx)
    default: fail(`Unknown setup step: ${step as string}`)
  }
}
