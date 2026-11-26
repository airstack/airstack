// Redaction library: remove secrets from text before an agent or a human sees it.
//
// Three layers, in this order:
//   1. Known secret values (opts.secrets).
//   2. Plugin rules: key paths for a file (opts.rules + opts.file).
//   3. Generic: secret-ish key names, then well-known value shapes.
// Each secret becomes `[redacted:<label>:<hash>]`. Quotes and YAML structure stay.

export { redact, isRedactionClean } from './redact.js'
export { redactDiff } from './diff.js'
export { marker, shortHash, withLineNumbers } from './format.js'
export type { RedactRule } from './rules.js'
export type { HitKind, RedactHit, RedactOptions, RedactResult } from './types.js'
