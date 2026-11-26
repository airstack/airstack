// Steps `brew-shim` (one Homebrew owner) and `tailscale` (install and join the tailnet).

import { resolveScript, executeSetupScript } from '../lib/remote-script.js'
import { fail, getDistro, type SetupContext } from './context.js'

// ── brew-shim ───────────────────────────────────────────────────────────────
// One account owns Homebrew; everyone else gets read-only use (see docs/LAYOUT.md).

export async function cmdBrewShim(ctx: SetupContext) {
  const { config, projectRoot, sharedPaths, ssh } = ctx
  const owner = config.host.brewOwner || config.host.devUsers[0] || ''
  if (!owner) {
    fail('No Homebrew owner. Set host.users.brewOwner in the machine file, or list a dev user.')
  }
  const distro = await getDistro(ctx)
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'brew-shim')

  console.log(`\n\x1b[1mHomebrew shim\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Homebrew owner: ${owner}`)
  console.log(`  Stack owner (brew not on its PATH): ${config.host.appUser}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: { BREW_OWNER: owner, APP_USER: config.host.appUser },
  })
  if (result.exitCode !== 0) {
    fail('brew-shim script failed (see its output above)')
  }
  console.log(`\n\x1b[32mDone.\x1b[0m Other accounts can run tools that brew installed. Only ${owner} can run 'brew install'.`)
}

// ── tailscale ───────────────────────────────────────────────────────────────
// Installs Tailscale and joins the tailnet. Which ports the tailnet may reach
// is applied on deploy by the tailscale plugin (plugins.tailscale.ports).

export async function cmdTailscale(ctx: SetupContext) {
  const { config, projectRoot, sharedPaths, ssh } = ctx
  const distro = await getDistro(ctx)
  const scriptPath = resolveScript(projectRoot, sharedPaths, distro, 'tailscale')

  const tsConfig = (config.plugins.tailscale ?? {}) as Record<string, unknown>
  const authKey = String(tsConfig.authKey ?? '')
  const hostname = String(tsConfig.hostname || config.host.hostname || '')

  console.log(`\n\x1b[1mTailscale Setup\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  Distro: ${distro}`)
  console.log(`  Tailnet name: ${hostname || '(current hostname)'}`)
  console.log(`  Login: ${authKey ? 'auth key' : 'interactive URL'}\n`)

  const result = await executeSetupScript({
    ssh,
    scriptPath,
    envVars: {
      VPS_HOSTNAME: hostname,
      TAILSCALE_AUTHKEY: authKey,
    },
  })

  if (result.exitCode !== 0) {
    fail('tailscale script failed (see its output above)')
  }

  console.log(`\n\x1b[32mTailscale setup complete.\x1b[0m`)
  console.log(`\nNext step: list the ports the tailnet may reach under plugins.tailscale.ports. Then run: airstack deploy <machine>`)
}
