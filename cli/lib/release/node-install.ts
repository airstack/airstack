/**
 * node-install.ts — put an airstack release on a node. Only the controller does this (deploy,
 * `fleet update`, `fleet install`); a node never downloads its own root-capable binary.
 *
 * Layout on the node (root:root, 755):
 *   /usr/local/lib/airstack/versions/<name>/   one dir per installed build (bin/airstack + core files)
 *   /usr/local/bin/airstack                    symlink to the active build's bin/airstack
 * <name> is "0.1.0" for a release and "0.1.0-<build>" for a dev build. A build is installed once:
 * its dir keeps a .sha256 of the tarball, and the same tarball is never sent twice.
 */

import type { RemoteExecutor } from '../../types.js'
import { installName, type ObtainedRelease } from './obtain.js'
import { targetFor, type Target } from './targets.js'

export const NODE_LIB = '/usr/local/lib/airstack'
export const NODE_BIN = '/usr/local/bin/airstack'
const KEEP = 3

const NAME_RE = /^[0-9A-Za-z.+-]+$/

export async function remoteTarget(remote: RemoteExecutor): Promise<Target | undefined> {
  const r = await remote.run('uname -sm')
  const [os, arch] = r.stdout.trim().split(/\s+/)
  return r.exitCode === 0 ? targetFor(os ?? '', arch ?? '') : undefined
}

export interface NodeVersions {
  active?: string
  installed: string[]
}

export async function nodeVersions(remote: RemoteExecutor): Promise<NodeVersions> {
  const r = await remote.run(`ls -1 ${NODE_LIB}/versions 2>/dev/null; echo "@@"; readlink ${NODE_BIN} 2>/dev/null || true`)
  const [list, link] = r.stdout.split('@@')
  const installed = list.split('\n').map((s) => s.trim()).filter((s) => s && NAME_RE.test(s) && !s.endsWith('.new'))
  const m = (link ?? '').trim().match(/\/versions\/([^/]+)\/bin\/airstack$/)
  return { active: m?.[1], installed }
}

export interface PushResult {
  name: string
  /** True when the tarball was sent (a new build); false when the node already had it. */
  sent: boolean
  /** True when the active symlink changed. */
  switched: boolean
}

export async function pushRelease(remote: RemoteExecutor, rel: ObtainedRelease): Promise<PushResult> {
  const name = installName(rel)
  if (!NAME_RE.test(name) || !/^[0-9a-f]{64}$/.test(rel.sha256)) throw new Error(`bad release name or checksum: ${name}`)
  const dir = `${NODE_LIB}/versions/${name}`
  const before = await nodeVersions(remote)

  const have = await remote.run(`cat ${dir}/.sha256 2>/dev/null || true`)
  let sent = false
  if (have.stdout.trim() !== rel.sha256) {
    const tmp = `/tmp/airstack-${name}-${process.pid}.tar.gz`
    const up = await remote.rsync(rel.tarball, tmp)
    if (up.exitCode !== 0) throw new Error('upload of the airstack release failed')
    const script = [
      'set -e',
      `trap 'sudo rm -f ${tmp}' EXIT`,
      `echo '${rel.sha256}  ${tmp}' | sha256sum -c --quiet`,
      `sudo rm -rf ${dir}.new`,
      `sudo install -d -o root -g root -m 755 ${NODE_LIB} ${NODE_LIB}/versions ${dir}.new`,
      `sudo tar -xzf ${tmp} -C ${dir}.new --strip-components=1 --no-same-owner`,
      `sudo chown -R root:root ${dir}.new`,
      `sudo chmod -R go-w ${dir}.new`,
      `echo '${rel.sha256}' | sudo tee ${dir}.new/.sha256 >/dev/null`,
      `sudo rm -rf ${dir}`,
      `sudo mv ${dir}.new ${dir}`,
    ].join('\n')
    const r = await remote.run(script)
    if (r.exitCode !== 0) throw new Error(`install of ${name} failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`)
    sent = true
  }

  const switched = before.active !== name
  if (switched || sent) {
    const r = await remote.run(`sudo ln -sfn ${dir}/bin/airstack ${NODE_BIN}.new && sudo mv -Tf ${NODE_BIN}.new ${NODE_BIN}`)
    if (r.exitCode !== 0) throw new Error(`cannot switch ${NODE_BIN} to ${name}: ${r.stderr.trim()}`)
  }
  await prune(remote, name)
  return { name, sent, switched }
}

/** Make an installed build the active one (rollback to an older build). */
export async function activate(remote: RemoteExecutor, name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`bad version name: ${name}`)
  const dir = `${NODE_LIB}/versions/${name}`
  const r = await remote.run(`test -x ${dir}/bin/airstack && sudo ln -sfn ${dir}/bin/airstack ${NODE_BIN}.new && sudo mv -Tf ${NODE_BIN}.new ${NODE_BIN}`)
  if (r.exitCode !== 0) throw new Error(`${name} is not installed on this machine`)
}

/** Keep the active build and the newest others, KEEP in total. */
async function prune(remote: RemoteExecutor, active: string): Promise<void> {
  await remote.run(
    `cd ${NODE_LIB}/versions 2>/dev/null && ls -1t | grep -vxF '${active}' | grep -v '\\.new$' | tail -n +${KEEP} | while read -r v; do sudo rm -rf -- "$v"; done; true`,
  )
}

/** `airstack version` on the node, through the active symlink. */
export async function nodeVersionLabel(remote: RemoteExecutor): Promise<string | undefined> {
  const r = await remote.run(`${NODE_BIN} version 2>/dev/null`)
  return r.exitCode === 0 ? r.stdout.trim().replace(/^airstack /, '') : undefined
}
