/**
 * adopt.ts — `airstack deploy <machine> --adopt`: take over a machine that is already set up
 * (hardened, Docker installed), without running the setup scripts again.
 *
 * Steps:
 *   1. Read-only checks over SSH (host.ssh.user / host.ssh.port): sudo works without a password,
 *      the users of the machine file exist, Docker answers, rootless Docker sockets of dev users,
 *      UFW is active. A failed check stops here; nothing on the machine changed.
 *   2. Write /etc/airstack/machine.yaml, then the normal node preparation: machine root, the
 *      airstack build, redaction data, the airstack-admin group.
 * It never starts, stops or changes containers. The next `airstack deploy` deploys the units.
 */

import type { Fleet, Machine } from '../../lib/fleet.js'
import { markerYaml, readMarker, writeMarker } from '../../lib/marker.js'
import type { Output } from '../../lib/output.js'
import type { RemoteExecutor } from '../../types.js'
import type { Flags } from './flags.js'
import { prepareNode } from './node-prep.js'

interface Check {
  label: string
  cmd: string
  level: 'fail' | 'warn'
  hint: string
}

function checks(m: Machine): Check[] {
  const users = [m.host.users.sudo, m.host.users.stack, ...m.host.users.dev]
  const list: Check[] = [
    { label: 'sudo without a password', cmd: 'sudo -n true', level: 'fail', hint: `give ${m.host.ssh.user} passwordless sudo` },
    ...users.map((u): Check => ({ label: `user ${u} exists`, cmd: `id -u ${u}`, level: 'fail', hint: 'create the user, or fix host.users in the machine file' })),
    { label: 'docker answers', cmd: 'sudo docker info --format "{{.ServerVersion}}"', level: 'fail', hint: 'install Docker (airstack deploy <machine> --install --step docker)' },
    { label: 'docker compose plugin', cmd: 'sudo docker compose version', level: 'fail', hint: 'install the docker compose plugin' },
    { label: 'ufw is active', cmd: 'sudo ufw status | grep -q "Status: active"', level: 'warn', hint: 'turn on the firewall (airstack deploy <machine> --install --step harden)' },
    { label: 'rsync and git installed', cmd: 'command -v rsync && command -v git', level: 'fail', hint: 'sudo apt-get install -y rsync git' },
  ]
  for (const u of m.host.users.dev) {
    list.push({
      label: `rootless docker for ${u}`,
      cmd: `test -S /run/user/$(id -u ${u})/docker.sock`,
      level: 'warn',
      hint: `only needed for stacks that run as ${u} (airstack deploy <machine> --install --step rootless)`,
    })
  }
  return list
}

export async function adoptMachine(remote: RemoteExecutor, fleet: Fleet, m: Machine, f: Flags, version: string, out: Output): Promise<{ ok: boolean; note: string }> {
  const name = m.name
  const marker = await readMarker(remote)
  if (marker.exists) {
    out.ok(`${name}: already an airstack node (/etc/airstack/machine.yaml exists)`)
    out.next(`airstack deploy ${name}`)
    return { ok: true, note: 'already adopted' }
  }

  let failed = 0
  for (const c of checks(m)) {
    const r = await remote.run(`${c.cmd} >/dev/null 2>&1`)
    if (r.exitCode === 0) { out.ok(`${name}: ${c.label}`); continue }
    if (r.exitCode === 255) {
      out.fail(`${name}: cannot connect over SSH as ${m.host.ssh.user} on port ${m.host.ssh.port}`)
      return { ok: false, note: 'no SSH' }
    }
    if (c.level === 'fail') failed++
    ;(c.level === 'fail' ? out.fail : out.warn).call(out, `${name}: ${c.label}: no. ${c.hint}`)
  }
  if (failed) return { ok: false, note: `${failed} check(s) failed; nothing changed` }

  if (!(await writeMarker(remote, markerYaml(fleet, m, version)))) {
    out.fail(`${name}: could not write /etc/airstack/machine.yaml`)
    return { ok: false, note: 'marker write failed' }
  }
  out.ok(`${name}: wrote /etc/airstack/machine.yaml`)
  const prep = await prepareNode(remote, fleet, m, f, version, out)
  if (!prep.ok) return prep
  out.next(`airstack deploy ${name}   (deploys the units)`)
  return { ok: true, note: 'adopted (no containers changed)' }
}
