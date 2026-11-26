/**
 * local-install.ts — airstack on a controller (a laptop). User-local only, never global:
 *
 *   ~/.local/lib/airstack/versions/<version>/   one dir per installed release
 *   ~/.local/bin/airstack                        symlink to the active release's bin/airstack
 *
 * install.sh uses the same layout. Nodes never use this: deploy puts airstack on nodes.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { obtainRelease } from './obtain.js'
import { targetFor } from './targets.js'

export function localPaths() {
  const home = homedir()
  const lib = join(home, '.local', 'lib', 'airstack')
  return { lib, versions: join(lib, 'versions'), bin: join(home, '.local', 'bin', 'airstack') }
}

export interface LocalVersions {
  active?: string
  installed: string[]
}

export function localVersions(): LocalVersions {
  const p = localPaths()
  const installed = existsSync(p.versions) ? readdirSync(p.versions).filter((v) => !v.endsWith('.new') && existsSync(join(p.versions, v, 'bin', 'airstack'))).sort() : []
  let active: string | undefined
  try {
    active = readlinkSync(p.bin).match(/\/versions\/([^/]+)\/bin\/airstack$/)?.[1]
  } catch { /* no symlink */ }
  return { active, installed }
}

/** Download (or reuse the cache), unpack into versions/<v>, switch the symlink. */
export async function installLocal(version: string, log: (s: string) => void = () => {}): Promise<{ dir: string; switched: boolean }> {
  const target = targetFor(process.platform, process.arch)
  if (!target) throw new Error(`no airstack release for ${process.platform}/${process.arch}`)
  const rel = await obtainRelease(target, version, log, { source: false })
  const p = localPaths()
  const dir = join(p.versions, version)
  if (!existsSync(join(dir, 'bin', 'airstack'))) {
    const tmp = `${dir}.new`
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const t = spawnSync('tar', ['-xzf', rel.tarball, '-C', tmp, '--strip-components=1'], { encoding: 'utf-8' })
    if (t.status !== 0) throw new Error(`cannot unpack ${rel.tarball}: ${t.stderr.trim()}`)
    rmSync(dir, { recursive: true, force: true })
    renameSync(tmp, dir)
  }
  return { dir, switched: activateLocal(version) }
}

export function activateLocal(version: string): boolean {
  const p = localPaths()
  const exe = join(p.versions, version, 'bin', 'airstack')
  if (!existsSync(exe) || !statSync(exe).isFile()) throw new Error(`${version} is not installed in ${p.versions}`)
  const before = localVersions().active
  mkdirSync(join(p.bin, '..'), { recursive: true })
  const tmp = `${p.bin}.new`
  rmSync(tmp, { force: true })
  symlinkSync(exe, tmp)
  renameSync(tmp, p.bin)
  return before !== version
}
