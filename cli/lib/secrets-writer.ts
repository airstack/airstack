/**
 * secrets-writer.ts — persist a generated secret into .airstack/secrets/<machine>.jsonc,
 * keeping comments and formatting (jsonc-parser edits). File mode 600.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyEdits, modify } from 'jsonc-parser'

export function secretsFile(fleetRoot: string, machine: string): string {
  return join(fleetRoot, '.airstack', 'secrets', `${machine}.jsonc`)
}

export function upsertSecret(fleetRoot: string, machine: string, key: string, value: string): void {
  const file = secretsFile(fleetRoot, machine)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '{\n}\n'
  const edits = modify(text, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
  writeFileSync(file, applyEdits(text, edits), { mode: 0o600 })
  chmodSync(file, 0o600)
}
