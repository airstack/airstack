// Step `lockdown`: close (or reopen with --undo) external SSH so SSH goes through the Cloudflare tunnel.

import { testSSHConnection } from '../lib/remote-script.js'
import { fail, type SetupContext } from './context.js'

// ── lockdown ──────────────────────────────────────────────────────────────────
// Close (or reopen with --undo) the external SSH port so SSH is reachable only
// through the Cloudflare tunnel. Connects directly (the port is still open at
// this moment) and reconfigures UFW. Requires host.sshExpose: tunnel.

export async function cmdLockdown(ctx: SetupContext) {
  const { config, flags, ssh, remote } = ctx
  const undo = flags.undo
  const port = config.host.sshHardenedPort || config.host.sshPort
  const dockerSubnet = String((config.stack as Record<string, unknown>).dockerSubnet || '10.200.0.0/24')

  console.log(`\n\x1b[1mSSH Lockdown${undo ? ' (UNDO — reopen)' : ''}\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)
  console.log(`  SSH port: ${port}`)

  if (undo) {
    console.log(`\nReopening external SSH port ${port}...`)
    await remote.run(`sudo ufw allow ${port}/tcp`)
    await remote.run(`sudo ufw delete allow from ${dockerSubnet} to any port ${port} proto tcp 2>/dev/null || true`)
    console.log(`\n\x1b[32mExternal SSH port ${port} reopened.\x1b[0m`)
    console.log(`To connect directly again, set host.ssh.expose: public in the machine file.`)
    return
  }

  if (config.host.sshExpose !== 'tunnel') {
    console.error(`\n\x1b[31mhost.ssh.expose is not 'tunnel'.\x1b[0m`)
    fail(`Set host.ssh.expose: tunnel in the machine file before lockdown. Then airstack connects through cloudflared.`)
  }
  if (!config.host.sshTunnelHostname) {
    console.error(`\n\x1b[31mhost.ssh.tunnelHostname is not set.\x1b[0m`)
    fail(`Set host.ssh.tunnelHostname to your Cloudflare Access SSH hostname (e.g. ssh.example.com).`)
  }

  // Preflight — confirm the tunnel SSH route works BEFORE closing the direct port.
  const tunnelSSH = {
    host: config.host.sshTunnelHostname,
    port,
    user: ssh.user,
    keyPath: ssh.keyPath,
    viaTunnel: true,
    tunnelHostname: config.host.sshTunnelHostname,
  }
  console.log(`\nCheck first: testing SSH through the tunnel (${config.host.sshTunnelHostname})...`)
  const reachable = await testSSHConnection(tunnelSSH, 20)
  if (!reachable) {
    console.error(`\n\x1b[31mSSH through the tunnel does NOT work yet.\x1b[0m`)
    console.error(`Set up the tunnel route first, then try again (--force skips this check):`)
    console.error(`  1. Deploy so cloudflared is running: airstack deploy <machine>`)
    console.error(`  2. Add a tunnel ingress rule: ssh://10.200.0.1:${port} for hostname ${config.host.sshTunnelHostname}`)
    console.error(`  3. Add a Cloudflare Access (self-hosted) app for that hostname`)
    console.error(`  4. Authenticate locally once: cloudflared access ssh-config --hostname ${config.host.sshTunnelHostname}`)
    if (!flags.force) fail('SSH through the tunnel does not work. Lockdown stopped; external SSH stays open (--force skips this check).')
    console.error(`\n\x1b[33m--force given: lockdown continues although the tunnel check failed.\x1b[0m`)
  } else {
    console.log(`  \x1b[32mSSH through the tunnel works.\x1b[0m`)
  }

  console.log(`\nAllowing the Docker subnet (${dockerSubnet}) to reach SSH port ${port}...`)
  await remote.run(`sudo ufw allow from ${dockerSubnet} to any port ${port} proto tcp`)

  console.log(`Closing external SSH port ${port}...`)
  await remote.run(`sudo ufw delete allow ${port}/tcp 2>/dev/null || true`)
  await remote.run(`sudo ufw delete allow 22/tcp 2>/dev/null || true`)

  console.log(`\n\x1b[32mLockdown complete. External SSH is closed.\x1b[0m`)
  console.log(`airstack now connects through the tunnel (host.ssh.expose: tunnel).`)
  console.log(`\n\x1b[33mRecovery:\x1b[0m if the tunnel stops working, open your VPS provider's web console and run: sudo ufw allow ${port}/tcp`)
}
