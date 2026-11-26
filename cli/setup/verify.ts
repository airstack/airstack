// Step `verify`: check that the machine is ready for deploy.

import { resolveScript, executeSetupScript } from '../lib/remote-script.js'
import { fail, getDistro, sysboxEnabled, type SetupContext } from './context.js'

// ── verify ──────────────────────────────────────────────────────────────────

export async function cmdVerify(ctx: SetupContext) {
  const { config, projectRoot, sharedPaths, ssh } = ctx
  const distro = await getDistro(ctx)
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'verify')

  const sudoUser = config.host.sudoUser
  const appUser = config.host.appUser

  console.log(`\n\x1b[1mVPS Verification\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Distro: ${distro}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: {
      SUDO_USER: sudoUser,
      APP_USER: appUser,
      DEV_USERS: config.host.devUsers.join(' '),
      SSH_PORT: String(config.host.sshPort),
      SSH_BOOTSTRAP_PORT: String(config.host.sshBootstrapPort ?? 22),
      INSTALL_DIR: config.stack.installDir,
      INSTALL_SYSBOX: sysboxEnabled(ctx) ? 'true' : 'false',
    },
  })

  if (result.exitCode !== 0) {
    fail('verify found problems (see the FAIL lines above)')
  }

  console.log(`\n\x1b[32mThe machine is ready to deploy.\x1b[0m`)
  console.log(`\nNext step: airstack deploy <machine>`)
}
