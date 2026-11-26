// cli/lib/git-safety.ts
//
// Helpers for detecting whether secret-bearing files are safely
// gitignored (and not accidentally tracked).  Uses execFileSync
// (NOT execSync) to prevent shell injection via file paths.

import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'

/**
 * Returns true if `filePath` is tracked (committed) in a git repo.
 */
export function isTrackedByGit(filePath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', filePath], {
      cwd: dirname(filePath),
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Returns true if `filePath` matches a .gitignore rule.
 */
export function isIgnoredByGit(filePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--quiet', filePath], {
      cwd: dirname(filePath),
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Throws if `filePath` is tracked by git or not gitignored.
 * Safe to call outside a git repo (returns silently).
 *
 * @param filePath  Absolute path to the file being checked
 * @param label     Human-readable label for error messages (e.g. ".env")
 * @param allowUnsafeGit  Skip all checks when true
 */
export function assertSafeForSecrets(
  filePath: string,
  label: string,
  allowUnsafeGit?: boolean,
): void {
  if (allowUnsafeGit) return

  // Check if we're inside a git repo at all.
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: dirname(filePath),
      stdio: 'pipe',
    })
  } catch {
    // Not a git repo — nothing to worry about.
    return
  }

  if (isTrackedByGit(filePath)) {
    throw new Error(
      `${label} is tracked by git — secrets may be exposed in history.\n` +
        `  Fix: git rm --cached ${label}\n` +
        `  Override: STACK_CLI_ALLOW_UNSAFE_GIT=1`,
    )
  }

  if (!isIgnoredByGit(filePath)) {
    throw new Error(
      `${label} is not gitignored — it could be committed accidentally.\n` +
        `  Fix: add ${label} to .gitignore\n` +
        `  Override: STACK_CLI_ALLOW_UNSAFE_GIT=1`,
    )
  }
}
