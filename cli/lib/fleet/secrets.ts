// Secrets loading: merge .airstack/secrets/_fleet.jsonc and <machine>.jsonc.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser'
import { isPlainObject } from '../merge.js'
import type { Issue } from './types.js'
import { rel } from './util.js'

export function loadSecrets(root: string, machine: string, issues: Issue[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['_fleet', machine]) {
    const file = join(root, '.airstack', 'secrets', `${name}.jsonc`)
    if (!existsSync(file)) continue
    const errors: ParseError[] = []
    const data = parseJsonc(readFileSync(file, 'utf8'), errors, { allowTrailingComma: true })
    if (errors.length) {
      issues.push({ level: 'fail', file: rel(root, file), message: `JSONC error: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}` })
      continue
    }
    if (!isPlainObject(data)) {
      issues.push({ level: 'fail', file: rel(root, file), message: 'must be an object of NAME: value' })
      continue
    }
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
      else issues.push({ level: 'fail', file: rel(root, file), key: k, message: 'value must be a string, number or boolean' })
    }
  }
  return out
}
