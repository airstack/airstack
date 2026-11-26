// Shared types for the redaction library.

import type { RedactRule } from './rules.js'

/** Which layer found the secret. */
export type HitKind = 'secret' | 'rule' | 'key' | 'shape'

export interface RedactHit {
  /** 1-based line number in the input text. */
  line: number
  kind: HitKind
  /** Secret name (layer 1), key name (rule / key) or shape name. */
  label: string
}

export interface RedactOptions {
  /** Known secret values: name -> value (from the fleet's .airstack/secrets/*.jsonc). */
  secrets?: Record<string, string>
  /** Plugin rules. They apply only when `file` matches one of a rule's globs. */
  rules?: RedactRule[]
  /** Path of the file, relative to the unit install dir (for example `.cliproxyapi/config.yaml`). */
  file?: string
}

export interface RedactResult {
  text: string
  count: number
  hits: RedactHit[]
}
