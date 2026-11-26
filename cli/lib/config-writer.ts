/**
 * config-writer.ts — Write config values back to stack.yml or .env.
 *
 * Provides updateConfig() which:
 *   1. Validates the value (no newlines, no YAML corruption)
 *   2. Persists to disk (stack.yml or .env depending on ${VAR} detection)
 *   3. Verifies the result parses as valid YAML with expected line count
 *   4. Mutates the in-memory Config object so all ctx holders see the change
 *
 * IMPORTANT: stack.yml edits are surgical (line-level) to preserve comments,
 * blank lines, and formatting. We never yaml.dump() the entire file.
 *
 * Safety: writes to a temp file first, validates, then replaces the original.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as yaml from 'js-yaml'
import type { Config } from '../types.js'
import { assertSafeForSecrets } from './git-safety.js'

/**
 * Set a value at a dot-path in a nested object.
 * Creates intermediate objects as needed.
 */
function setAtPath(obj: Record<string, unknown>, dotPath: string, value: unknown): boolean {
  const parts = dotPath.split('.')
  let current: Record<string, unknown> = obj

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (current[key] === undefined || current[key] === null) {
      current[key] = {}
    }
    if (typeof current[key] !== 'object' || Array.isArray(current[key])) {
      return false
    }
    current = current[key] as Record<string, unknown>
  }

  current[parts[parts.length - 1]] = value
  return true
}

/**
 * Get the raw (pre-resolution) value at a dot-path in a YAML-parsed object.
 */
function getAtPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.')
  let current: unknown = obj

  for (const key of parts) {
    if (current === undefined || current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }

  return current
}

/**
 * Check if a raw YAML value is a ${VAR} reference.
 * Returns the variable name if it is, undefined otherwise.
 */
function extractEnvRef(rawValue: unknown): string | undefined {
  if (typeof rawValue !== 'string') return undefined
  const match = rawValue.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/)
  return match ? match[1] : undefined
}

/**
 * Quote a YAML value if it contains characters that could break parsing.
 * Returns the value as-is if safe, or double-quoted if needed.
 */
function safeYamlValue(value: string): string {
  // These characters in a value require quoting
  if (
    value.includes(':') ||
    value.includes('#') ||
    value.includes('{') ||
    value.includes('}') ||
    value.includes('[') ||
    value.includes(']') ||
    value.includes(',') ||
    value.includes('&') ||
    value.includes('*') ||
    value.includes('!') ||
    value.includes('|') ||
    value.includes('>') ||
    value.includes("'") ||
    value.includes('"') ||
    value.includes('%') ||
    value.includes('@') ||
    value.includes('`') ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    value === '' ||
    value === 'true' ||
    value === 'false' ||
    value === 'null' ||
    value === 'yes' ||
    value === 'no'
  ) {
    // Double-quote and escape internal double quotes and backslashes
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return `"${escaped}"`
  }
  return value
}

/**
 * Validate that a value is safe for single-line YAML insertion.
 * Throws if the value would corrupt the file.
 */
function validateValue(value: string, dotPath: string): void {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`updateConfig: value for '${dotPath}' contains newlines — multi-line values are not supported`)
  }
}

/**
 * Surgically update or insert a key in a YAML file without disturbing
 * comments, blank lines, or other formatting.
 *
 * Safety protocol:
 *   1. Copy original to temp file
 *   2. Perform edit on temp file
 *   3. Verify temp file parses as valid YAML
 *   4. Verify line count matches expected (original + number of inserted lines)
 *   5. Only replace original if all checks pass
 */
function updateYamlFile(filePath: string, dotPath: string, value: string): void {
  const originalContent = readFileSync(filePath, 'utf-8')
  const originalLineCount = originalContent.split('\n').length
  const lines = originalContent.split('\n')
  const parts = dotPath.split('.')
  const safeValue = safeYamlValue(value)

  // Track how many lines we expect to insert
  let expectedInsertions = 0

  function findKey(key: string, expectedIndent: number, startLine: number): { lineIdx: number; indent: number } | null {
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue

      const match = line.match(/^(\s*)([^\s#:]+)\s*:/)
      if (!match) continue

      const lineIndent = match[1].length
      const lineKey = match[2]

      if (lineIndent < expectedIndent) return null
      if (lineIndent > expectedIndent) continue

      if (lineIndent === expectedIndent && lineKey === key) {
        return { lineIdx: i, indent: lineIndent }
      }
    }
    return null
  }

  let searchFrom = 0
  let currentIndent = 0

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    const found = findKey(key, currentIndent, searchFrom)

    if (found) {
      searchFrom = found.lineIdx + 1
      currentIndent = found.indent + 2
    } else {
      const insertLine = `${' '.repeat(currentIndent)}${key}:`
      const insertIdx = findInsertPoint(lines, currentIndent, searchFrom)
      lines.splice(insertIdx, 0, insertLine)
      expectedInsertions++
      searchFrom = insertIdx + 1
      currentIndent += 2
    }
  }

  const finalKey = parts[parts.length - 1]
  const found = findKey(finalKey, currentIndent, searchFrom)

  if (found) {
    // Replace existing value inline — no line count change
    const line = lines[found.lineIdx]
    const colonIdx = line.indexOf(':')
    lines[found.lineIdx] = line.slice(0, colonIdx + 1) + ' ' + safeValue
  } else {
    const newLine = `${' '.repeat(currentIndent)}${finalKey}: ${safeValue}`
    const insertIdx = findInsertPoint(lines, currentIndent, searchFrom)
    lines.splice(insertIdx, 0, newLine)
    expectedInsertions++
  }

  const newContent = lines.join('\n')
  const newLineCount = lines.length
  const expectedLineCount = originalLineCount + expectedInsertions

  // --- Safety checks ---

  // 1. Line count must match expected
  if (newLineCount !== expectedLineCount) {
    throw new Error(
      `updateConfig safety check failed for '${dotPath}': ` +
      `expected ${expectedLineCount} lines (${originalLineCount} + ${expectedInsertions} inserted), ` +
      `got ${newLineCount}. Aborting to prevent stack.yml corruption.`,
    )
  }

  // 2. Write to temp file (same dir as target for atomic rename) and verify valid YAML
  const tmpPath = join(dirname(filePath), `.stack-yml-update-${Date.now()}.yml`)
  try {
    writeFileSync(tmpPath, newContent)

    try {
      yaml.load(newContent)
    } catch (parseErr) {
      throw new Error(
        `updateConfig safety check failed for '${dotPath}': ` +
        `edited file is not valid YAML: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
        `Aborting to prevent stack.yml corruption.`,
      )
    }

    // 3. All checks passed — replace original with temp file
    renameSync(tmpPath, filePath)
  } finally {
    // Clean up temp file if it still exists (rename failed or error thrown before rename)
    try { unlinkSync(tmpPath) } catch { /* already renamed or doesn't exist */ }
  }
}

/**
 * Find the best line index to insert a new key at a given indent level.
 * Inserts after the last content line at or deeper than the given indent,
 * but BEFORE any trailing blank lines/comments that separate sections.
 */
function findInsertPoint(lines: string[], indent: number, startFrom: number): number {
  let insertAt = startFrom
  for (let i = startFrom; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue
    }
    const match = line.match(/^(\s*)/)
    const lineIndent = match ? match[1].length : 0
    if (lineIndent < indent) break
    insertAt = i + 1
  }
  return insertAt
}

/**
 * Update a config value. Persists to disk AND mutates the in-memory Config.
 *
 * - Validates value (no newlines, quotes special characters)
 * - If the key in raw stack.yml uses a ${VAR} reference → updates .env
 * - Otherwise → surgically edits stack.yml (preserves comments and formatting)
 * - Verifies the edit produces valid YAML before replacing the file
 * - In both cases, mutates the config object in place
 *
 * Throws if:
 * - Value contains newlines
 * - Edited file is not valid YAML
 * - Line count doesn't match expected
 */
export function updateConfig(projectRoot: string, config: Config, dotPath: string, value: string): void {
  // Validate early
  validateValue(value, dotPath)

  const stackPath = config.stackConfig.stackFile
  const envPath = config.stackConfig.envFile

  // 1. Read raw stack.yml to check for ${VAR} references
  const rawYaml = readFileSync(stackPath, 'utf-8')
  const rawParsed = yaml.load(rawYaml) as Record<string, unknown>
  const rawValue = getAtPath(rawParsed, dotPath)
  const envRef = extractEnvRef(rawValue)

  // Git safety: refuse to write secrets to tracked/non-ignored files
  const targetFile = envRef ? envPath : stackPath
  const targetLabel = envRef ? 'envFile' : 'stackFile'
  assertSafeForSecrets(targetFile, targetLabel, config.stackConfig.allowUnsafeGit)

  if (envRef) {
    // 2a. Key uses ${VAR} in stack.yml → update the var in .env
    validateValue(value, envRef) // also validate for .env (no newlines)
    const envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''
    const envLines = envContent.split('\n')

    const lineIdx = envLines.findIndex(l => l.startsWith(`${envRef}=`))
    if (lineIdx >= 0) {
      envLines[lineIdx] = `${envRef}=${value}`
    } else {
      const insertIdx = envLines.length > 0 && envLines[envLines.length - 1] === ''
        ? envLines.length - 1
        : envLines.length
      envLines.splice(insertIdx, 0, `${envRef}=${value}`)
    }

    writeFileSync(envPath, envLines.join('\n'))
  } else {
    // 2b. Surgically edit stack.yml with safety checks
    updateYamlFile(stackPath, dotPath, value)
  }

  // 3. Mutate the in-memory config object
  setAtPath(config as unknown as Record<string, unknown>, dotPath, value)
}
