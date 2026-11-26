// Steps `docker` (Docker CE + daemon hardening) and `rootless` (one rootless daemon per dev user).

import { resolveScript, executeSetupScript } from '../lib/remote-script.js'
import { fail, getDistro, sysboxEnabled, type SetupContext } from './context.js'

// ── docker ──────────────────────────────────────────────────────────────────

export async function cmdDocker(ctx: SetupContext) {
  const { config, projectRoot, sharedPaths, ssh } = ctx
  const distro = await getDistro(ctx)
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'docker')

  const sudoUser = config.host.sudoUser
  const appUser = config.host.appUser
  const withSysbox = sysboxEnabled(ctx)

  console.log(`\n\x1b[1mDocker Setup${withSysbox ? ' + Sysbox' : ''}\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Distro: ${distro}`)
  console.log(`  Sysbox: ${withSysbox ? 'yes' : 'no'}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: {
      SUDO_USER: sudoUser,
      APP_USER: appUser,
      INSTALL_SYSBOX: withSysbox ? 'true' : 'false',
    },
  })

  if (result.exitCode !== 0) {
    fail('docker script failed (see its output above)')
  }

  console.log(`\n\x1b[32mDocker setup complete.\x1b[0m`)
  console.log(`\nNext step: airstack deploy <machine> --install --step verify`)
}

// ── rootless ────────────────────────────────────────────────────────────────
// Each dev user gets its own rootless Docker daemon (see docs/LAYOUT.md).

export async function cmdRootless(ctx: SetupContext) {
  const { config, projectRoot, sharedPaths, ssh } = ctx
  const devUsers = config.host.devUsers
  if (devUsers.length === 0) {
    fail('No dev users configured. Set host.users.dev in the machine file.')
  }
  const distro = await getDistro(ctx)
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'rootless')

  console.log(`\n\x1b[1mRootless Docker\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Dev users: ${devUsers.join(' ')}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: { DEV_USERS: devUsers.join(' ') },
  })
  if (result.exitCode !== 0) {
    fail('rootless script failed (see its output above)')
  }
  console.log(`\n\x1b[32mRootless Docker is ready.\x1b[0m Each dev user runs plain \`docker\`. It talks to that user's own Docker daemon.`)
}
