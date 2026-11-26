// Core redact pass: runs the three layers in order.

import { redactByKeys } from './keyvalue.js'
import { keysForFile } from './rules.js'
import { redactPem, redactShapes } from './shapes.js'
import { redactKnownValues } from './values.js'
import type { RedactHit, RedactOptions, RedactResult } from './types.js'

export function redact(text: string, opts: RedactOptions = {}): RedactResult {
  const hits: RedactHit[] = []
  let out = redactKnownValues(text, opts.secrets, hits)
  const keyPass = redactByKeys(out.split('\n'), keysForFile(opts.rules, opts.file), hits)
  out = redactPem(keyPass.lines.join('\n'), hits)
  out = redactShapes(out.split('\n'), keyPass.handled, hits).join('\n')
  hits.sort((a, b) => a.line - b.line)
  return { text: out, count: hits.length, hits }
}

/** True when `redact` finds nothing to remove. */
export function isRedactionClean(text: string, opts: RedactOptions = {}): boolean {
  return redact(text, opts).count === 0
}
