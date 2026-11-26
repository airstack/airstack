/**
 * node-setup.ts — small root-owned files deploy keeps up to date on a node:
 *
 *   /etc/airstack/redact.json     secret values this machine uses (root:root 600). Node verbs use
 *                                 them to redact output. The same values are already in the
 *                                 rendered files on the machine; this file adds no new exposure.
 *   /etc/sudoers.d/airstack       %airstack-admin may run `/usr/local/bin/airstack machine *` as root
 *   group airstack-admin          members from host.users.admins
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RemoteExecutor } from '../types.js'
import type { Machine } from './fleet.js'
import { NODE_BIN } from './release/node-install.js'

export const REDACT_PATH = '/etc/airstack/redact.json'
export const SUDOERS_PATH = '/etc/sudoers.d/airstack'
export const ADMIN_GROUP = 'airstack-admin'

const USER_RE = /^[a-z_][a-z0-9_-]*$/

async function installFile(remote: RemoteExecutor, content: string, dest: string, mode: string): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'airstack-node-'))
  const local = join(dir, 'f')
  writeFileSync(local, content, { mode: 0o600 })
  const tmp = `/tmp/airstack-${process.pid}-${Date.now()}`
  try {
    if ((await remote.rsync(local, tmp)).exitCode !== 0) return false
    const r = await remote.run(`sudo install -o root -g root -m ${mode} ${tmp} ${dest}; rc=$?; sudo rm -f ${tmp}; exit $rc`)
    return r.exitCode === 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function writeRedactSecrets(remote: RemoteExecutor, m: Machine): Promise<boolean> {
  const secrets: Record<string, string> = {}
  for (const name of m.secretsUsed) {
    const v = m.secrets[name]
    if (v && v.length >= 6) secrets[name] = v
  }
  return installFile(remote, `${JSON.stringify({ secrets }, null, 2)}\n`, REDACT_PATH, '600')
}

export async function ensureAdminGroup(remote: RemoteExecutor, admins: string[]): Promise<{ ok: boolean; note: string }> {
  const bad = admins.filter((u) => !USER_RE.test(u))
  if (bad.length) return { ok: false, note: `bad user name(s) in host.users.admins: ${bad.join(', ')}` }
  const rule = `# Written by airstack deploy. Members of ${ADMIN_GROUP} may run node verbs as root.\n%${ADMIN_GROUP} ALL=(root) NOPASSWD: ${NODE_BIN} machine *\n`
  const g = await remote.run(`getent group ${ADMIN_GROUP} >/dev/null || sudo groupadd --system ${ADMIN_GROUP}`)
  if (g.exitCode !== 0) return { ok: false, note: `cannot create group ${ADMIN_GROUP}` }
  for (const u of admins) {
    const r = await remote.run(`id -u ${u} >/dev/null 2>&1 && sudo usermod -aG ${ADMIN_GROUP} ${u}`)
    if (r.exitCode !== 0) return { ok: false, note: `cannot add ${u} to ${ADMIN_GROUP} (does the user exist?)` }
  }
  // Check the rule with visudo before it goes live: a broken sudoers file locks out sudo.
  const tmp = `/tmp/airstack-sudoers-${process.pid}`
  const dir = mkdtempSync(join(tmpdir(), 'airstack-sudo-'))
  try {
    writeFileSync(join(dir, 's'), rule)
    if ((await remote.rsync(join(dir, 's'), tmp)).exitCode !== 0) return { ok: false, note: 'cannot upload the sudoers rule' }
    const r = await remote.run(`sudo visudo -cqf ${tmp} && sudo install -o root -g root -m 440 ${tmp} ${SUDOERS_PATH}; rc=$?; sudo rm -f ${tmp}; exit $rc`)
    if (r.exitCode !== 0) return { ok: false, note: 'the sudoers rule did not pass visudo; not installed' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return { ok: true, note: `${ADMIN_GROUP}: ${admins.length ? admins.join(', ') : 'no members'}` }
}
