// Step `reboot`: reboot the machine and wait until SSH answers from a new boot.

import { testSSHConnection } from '../lib/remote-script.js'
import { fail, type SetupContext } from './context.js'

// ── reboot ──────────────────────────────────────────────────────────────────

export async function cmdReboot(ctx: SetupContext) {
  const { ssh, remote } = ctx
  console.log(`\n\x1b[1mVPS Reboot\x1b[0m`)
  console.log(`  Target: ${ssh.user}@${ssh.host}:${ssh.port}`)

  // "Back" must mean a NEW boot: compare the kernel boot id, or a box that has not gone down yet
  // looks like it came back instantly.
  const bootId = async () => (await remote.run('cat /proc/sys/kernel/random/boot_id 2>/dev/null')).stdout.trim()
  const before = await bootId()
  if (!before) fail('could not read the boot ID (/proc/sys/kernel/random/boot_id), so reboot was not started')

  await remote.run('sudo systemd-run --on-active=2 --timer-property=AccuracySec=100ms /bin/systemctl reboot >/dev/null 2>&1 || (sleep 1; sudo reboot) >/dev/null 2>&1 &')
  console.log('\x1b[33mReboot scheduled. Waiting for the machine to come back...\x1b[0m')

  const maxWait = 300
  for (let elapsed = 0; elapsed < maxWait; elapsed += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    if (!(await testSSHConnection(ssh, 5))) {
      process.stdout.write(`  waiting... (${elapsed + 5}s/${maxWait}s)\r`)
      continue
    }
    const now = await bootId()
    if (now && now !== before) {
      console.log(`\n\x1b[32mMachine is back online after about ${elapsed + 5}s (new boot).\x1b[0m`)
      return
    }
  }
  fail(`machine did not come back on SSH port ${ssh.port} within ${maxWait}s after reboot`)
}
