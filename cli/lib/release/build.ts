/**
 * build.ts — build release tarballs from a source checkout (needs Bun; a compiled airstack cannot
 * build itself).
 *
 * Steps per target:
 *   1. `bun build --compile --target=bun-<target>` cli/index.ts → <dir>/bin/airstack
 *      (built-in plugins are bundled through cli/plugins/builtin.ts)
 *   2. copy the core files (CORE_FILES) into <dir>/
 *   3. tar + gzip, and record the sha256
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CORE_ROOT, COMPILED, VERSION } from '../core.js'
import { CORE_FILES, releaseName, tarballName, type Target } from './targets.js'

export interface BuiltRelease {
  target: Target
  tarball: string
  sha256: string
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Short id for a dev build: git commit, plus a hash of uncommitted source changes. */
export function sourceBuildId(root = CORE_ROOT): string {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf-8' })
  const head = git('rev-parse', '--short', 'HEAD').stdout.trim() || 'nogit'
  const dirty = git('status', '--porcelain', '--', 'cli', 'templates', 'stacks', 'deploy', 'package.json').stdout.trim()
  return dirty ? `${head}-${sourceHash(root).slice(0, 7)}` : head
}

/** Hash of every file that goes into a build (to reuse a cached build when nothing changed). */
export function sourceHash(root = CORE_ROOT): string {
  const h = createHash('sha256')
  const walk = (p: string) => {
    if (!existsSync(p)) return
    const st = statSync(p)
    if (st.isDirectory()) {
      for (const e of readdirSync(p).sort()) if (e !== 'node_modules') walk(join(p, e))
      return
    }
    h.update(relative(root, p)).update('\0').update(readFileSync(p)).update('\0')
  }
  for (const p of ['cli', ...CORE_FILES, 'package.json', 'bun.lock']) walk(join(root, p))
  return h.digest('hex')
}

export function buildRelease(target: Target, opts: { outDir: string; buildId: string; version?: string; log?: (s: string) => void }): BuiltRelease {
  if (COMPILED) throw new Error('a compiled airstack cannot build releases: run from a source checkout with Bun')
  const version = opts.version ?? VERSION
  const name = releaseName(version, target)
  const dir = join(opts.outDir, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'bin'), { recursive: true })

  opts.log?.(`build ${name} (${opts.buildId})`)
  const r = spawnSync(process.execPath, [
    'build', join(CORE_ROOT, 'cli', 'index.ts'),
    '--compile', `--target=bun-${target}`,
    '--define', `AIRSTACK_BUILD=${JSON.stringify(opts.buildId)}`,
    '--outfile', join(dir, 'bin', 'airstack'),
  ], { cwd: CORE_ROOT, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`bun build failed for ${target}: ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n')}`)

  for (const f of CORE_FILES) {
    const src = join(CORE_ROOT, f)
    if (existsSync(src)) cpSync(src, join(dir, f), { recursive: true })
  }

  const tarball = join(opts.outDir, tarballName(version, target))
  const t = spawnSync('tar', ['-czf', tarball, '-C', opts.outDir, name], { encoding: 'utf-8' })
  if (t.status !== 0) throw new Error(`tar failed: ${t.stderr.trim()}`)
  rmSync(dir, { recursive: true, force: true })
  return { target, tarball, sha256: sha256File(tarball) }
}
