/**
 * obtain.ts — get the release tarball for a target on this controller.
 *
 * Order:
 *   1. Source checkout whose version is the one asked for: build it (cached by a hash of the
 *      source, so an unchanged checkout builds once).
 *   2. The release cache: ~/.cache/airstack/releases/<version>/.
 *   3. Download from the GitHub release v<version> and check it against SHA256SUMS.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { COMPILED, VERSION } from '../core.js'
import { buildRelease, sha256File, sourceBuildId, sourceHash } from './build.js'
import { CHECKSUMS_FILE, RELEASE_REPO, tarballName, type Target } from './targets.js'

export interface ObtainedRelease {
  target: Target
  version: string
  /** 'release' for a published release, else the dev build id. */
  buildId: string
  tarball: string
  sha256: string
  source: 'build' | 'cache' | 'download'
}

export function cacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'airstack')
}

/** Dir name on a node for this build: "0.1.0" for a release, "0.1.0-<build>" for a dev build. */
export function installName(r: Pick<ObtainedRelease, 'version' | 'buildId'>): string {
  return r.buildId === 'release' ? r.version : `${r.version}-${r.buildId}`
}

export async function obtainRelease(target: Target, version: string, log: (s: string) => void = () => {}): Promise<ObtainedRelease> {
  if (!COMPILED && version === VERSION) return fromSource(target, version, log)

  const dir = join(cacheDir(), 'releases', version)
  const file = join(dir, tarballName(version, target))
  if (existsSync(file) && existsSync(file + '.sha256')) {
    const sha256 = sha256File(file)
    if (sha256 === readFileSync(file + '.sha256', 'utf-8').trim()) {
      return { target, version, buildId: 'release', tarball: file, sha256, source: 'cache' }
    }
  }
  return download(target, version, dir, log)
}

function fromSource(target: Target, version: string, log: (s: string) => void): ObtainedRelease {
  const key = sourceHash().slice(0, 16)
  const dir = join(cacheDir(), 'builds', key)
  const file = join(dir, tarballName(version, target))
  const idFile = join(dir, 'build-id')
  if (existsSync(file) && existsSync(idFile)) {
    return { target, version, buildId: readFileSync(idFile, 'utf-8').trim(), tarball: file, sha256: sha256File(file), source: 'cache' }
  }
  mkdirSync(dir, { recursive: true })
  const buildId = sourceBuildId()
  const r = buildRelease(target, { outDir: dir, buildId, version, log })
  writeFileSync(idFile, buildId)
  return { target, version, buildId, tarball: r.tarball, sha256: r.sha256, source: 'build' }
}

async function download(target: Target, version: string, dir: string, log: (s: string) => void): Promise<ObtainedRelease> {
  const base = `https://github.com/${RELEASE_REPO}/releases/download/v${version}`
  const name = tarballName(version, target)
  log(`download ${base}/${name}`)
  const sums = await fetchText(`${base}/${CHECKSUMS_FILE}`)
  const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, f]) => f === name)?.[0]
  if (!want) throw new Error(`${CHECKSUMS_FILE} of v${version} has no entry for ${name}`)

  const res = await fetch(`${base}/${name}`)
  if (!res.ok) throw new Error(`download of ${name} failed: HTTP ${res.status}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file + '.part', Buffer.from(await res.arrayBuffer()))
  const sha256 = sha256File(file + '.part')
  if (sha256 !== want) throw new Error(`checksum mismatch for ${name}: the download is not the published file`)
  renameSync(file + '.part', file)
  writeFileSync(file + '.sha256', sha256)
  return { target, version, buildId: 'release', tarball: file, sha256, source: 'download' }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`cannot read ${url}: HTTP ${res.status}`)
  return res.text()
}
