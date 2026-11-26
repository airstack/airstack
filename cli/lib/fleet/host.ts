// Host config defaults: turn the raw `host:` mapping into a full HostConfig.

import type { Plain } from '../merge.js'
import type { HostConfig } from './types.js'

export function normalizeHost(h: Plain, machine: string): HostConfig {
  const ssh = (h.ssh ?? {}) as Plain
  const users = (h.users ?? {}) as Plain
  const sudo = String(users.sudo ?? 'adminuser')
  // ssh.port is the port of the finished machine (default 222); a fresh box answers on bootstrapPort.
  const port = Number(ssh.port ?? 222)
  return {
    hostname: String(h.hostname ?? machine),
    ip: String(h.ip ?? ''),
    timezone: String(h.timezone ?? ''),
    ssh: {
      user: String(ssh.user ?? sudo),
      port,
      key: String(ssh.key ?? ''),
      hardenedPort: port,
      bootstrapPort: Number(ssh.bootstrapPort ?? 22),
      bootstrapUser: String(ssh.bootstrapUser ?? 'root'),
      expose: String(ssh.expose ?? 'public') === 'tunnel' ? 'tunnel' : 'public',
      tunnelHostname: String(ssh.tunnelHostname ?? ''),
    },
    users: {
      sudo,
      stack: String(users.stack ?? 'stackroot'),
      dev: Array.isArray(users.dev) ? users.dev.map(String) : [],
      brewOwner: String(users.brewOwner ?? ''),
      admins: Array.isArray(users.admins) ? users.admins.map(String) : [],
    },
    dockerSubnet: String(h.dockerSubnet ?? '10.200.0.0/24'),
  }
}
