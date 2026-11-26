/**
 * core.ts — where this airstack runs from, and which version it is.
 *
 * Two ways to run:
 *   source    `bun cli/index.ts` in a checkout. The core root is the checkout.
 *   compiled  a release binary (`bun build --compile`). The binary lives at <root>/bin/airstack and
 *             the release ships the core files (built-in plugin dirs, templates, stacks, setup
 *             scripts) next to it, so the core root is the binary's parent dir.
 *
 * BUILD is set at build time (`--define AIRSTACK_BUILD=…`, devutils/release/build.ts). A source run
 * reports "source".
 */

import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }

declare const AIRSTACK_BUILD: string | undefined

export const VERSION: string = pkg.version
export const BUILD: string = typeof AIRSTACK_BUILD === 'string' ? AIRSTACK_BUILD : 'source'

/** True inside a `bun build --compile` binary (its modules live in an embedded file system). */
export const COMPILED = /\$bunfs|~BUN/.test(import.meta.dirname)

function compiledRoot(): string {
  let exe = process.execPath
  try { exe = realpathSync(exe) } catch { /* keep execPath */ }
  return resolve(dirname(exe), '..')
}

export const CORE_ROOT = COMPILED ? compiledRoot() : resolve(import.meta.dirname, '..', '..')
export const BUILTIN_PLUGINS_DIR = join(CORE_ROOT, 'cli', 'plugins')
export const BUILTIN_STACKS_DIR = join(CORE_ROOT, 'stacks')

/** "0.1.0" for a release build, "0.1.0 (build abc1234)" for a dev build, "0.1.0 (source)" for source. */
export function versionLabel(): string {
  if (BUILD === 'source') return `${VERSION} (source)`
  if (BUILD === 'release') return VERSION
  return `${VERSION} (build ${BUILD})`
}
