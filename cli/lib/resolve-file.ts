import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Resolve a file path by checking projectRoot first, then each sharedPath.
 * Throws if the file is not found in any location.
 */
export function resolveFile(
  projectRoot: string,
  sharedPaths: string[],
  relativePath: string,
): string {
  const local = join(projectRoot, relativePath)
  if (existsSync(local)) return local

  for (const shared of sharedPaths) {
    const candidate = join(shared, relativePath)
    if (existsSync(candidate)) return candidate
  }

  const searched = [projectRoot, ...sharedPaths].join(', ')
  throw new Error(`File not found: ${relativePath} (searched: ${searched})`)
}

/**
 * Resolve a directory path by checking projectRoot first, then each sharedPath.
 * Throws if the directory is not found in any location.
 */
export function resolveDir(
  projectRoot: string,
  sharedPaths: string[],
  relativePath: string,
): string {
  const local = join(projectRoot, relativePath)
  if (existsSync(local) && statSync(local).isDirectory()) return local

  for (const shared of sharedPaths) {
    const candidate = join(shared, relativePath)
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  }

  const searched = [projectRoot, ...sharedPaths].join(', ')
  throw new Error(`Directory not found: ${relativePath} (searched: ${searched})`)
}

/**
 * Resolve a file path by checking projectRoot first, then each sharedPath.
 * Returns the first found path, or undefined if not found anywhere.
 * Use this for optional assets that may not exist.
 */
export function resolveFileOptional(
  projectRoot: string,
  sharedPaths: string[],
  relativePath: string,
): string | undefined {
  const local = join(projectRoot, relativePath)
  if (existsSync(local)) return local

  for (const shared of sharedPaths) {
    const candidate = join(shared, relativePath)
    if (existsSync(candidate)) return candidate
  }

  return undefined
}

/**
 * Read sharedPaths from the STACK_CLI_SHARED_PATH environment variable.
 * Returns empty array when not set (default stack at repo root).
 */
export function getSharedPaths(): string[] {
  const val = process.env.STACK_CLI_SHARED_PATH
  if (!val) return []
  return [val]
}
