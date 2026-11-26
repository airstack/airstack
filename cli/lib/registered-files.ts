// cli/lib/registered-files.ts
//
// Shared helpers for the registered-files system.
// - findLocalScriptsMissingExecute: scan dirs for .sh files missing +x
// - diffHostFiles: detect orphaned host files between deploys

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { RegisteredFiles } from '../types'

/**
 * Recursively find .sh files under `dir`, returning paths relative to `baseDir`.
 */
function walkShFiles(baseDir: string, dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkShFiles(baseDir, fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.sh')) {
      results.push(relative(baseDir, fullPath))
    }
  }
  return results
}

/**
 * Find .sh files under the given script dirs that are missing any execute bit.
 *
 * @param baseDir   Absolute path to the deploy root (installDir or staging dir)
 * @param scripts   The `scripts` portion of RegisteredFiles
 * @returns Sorted array of relative paths (to baseDir) missing execute permission
 */
export function findLocalScriptsMissingExecute(
  baseDir: string,
  scripts: RegisteredFiles['scripts'],
): string[] {
  const excludeSet = new Set(scripts.exclude)
  const missing: string[] = []

  for (const dir of scripts.dirs) {
    const absDir = join(baseDir, dir)
    const shFiles = walkShFiles(baseDir, absDir)
    for (const relPath of shFiles) {
      if (excludeSet.has(relPath)) continue
      const st = statSync(join(baseDir, relPath))
      if ((st.mode & 0o111) === 0) {
        missing.push(relPath)
      }
    }
  }

  return missing.sort()
}

/**
 * Return files present in `remoteFiles` but absent from `localFiles` (orphans).
 */
export function diffHostFiles(
  remoteFiles: string[],
  localFiles: string[],
): string[] {
  const localSet = new Set(localFiles)
  return remoteFiles.filter(f => !localSet.has(f))
}

// ── Shell safety helpers ────────────────────────────────────────────────────

/** Default allowlist pattern for host file paths managed by the deploy pipeline. */
const HOST_FILE_PATTERN = /^\/etc\/(cron\.d|logrotate\.d|stacks|airstack\/stacks)\/[a-zA-Z0-9_.\-]+$/

/**
 * Validate a host file path is safe for use in shell commands.
 * Allows paths under /etc/cron.d/, /etc/logrotate.d/, /etc/airstack/stacks/, legacy /etc/stacks/ (kept so cleanup
 * can remove files left by stack-cli, airstack's predecessor),
 * plus any custom manifest directory.
 */
export function isValidHostFilePath(path: string, extraDirs: string[] = []): boolean {
  if (HOST_FILE_PATTERN.test(path)) return true
  for (const dir of extraDirs) {
    if (path.startsWith(dir + '/') && /^[a-zA-Z0-9_.\-]+$/.test(path.slice(dir.length + 1))) {
      return true
    }
  }
  return false
}

/**
 * Shell-quote a single argument using single quotes.
 * Handles embedded single quotes with the '\'' escape pattern.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`
}

/**
 * Shell-quote multiple arguments for safe interpolation into a command string.
 */
export function shellQuoteArgs(args: string[]): string {
  return args.map(shellQuote).join(' ')
}
