/**
 * vars.ts — `${VAR}` / `${VAR:-default}` references in fleet YAML, resolved AFTER parsing.
 *
 * stack-cli substituted secrets into the YAML text before parsing, so a value containing
 * `:`, `#`, quotes or a newline could change the config's structure. Here:
 *   1. each `${…}` in the text becomes an inert token (`AIRSTACKVAR<n>Z`, plain alphanumerics,
 *      valid anywhere a YAML scalar is, including flow maps like `{ a: ${X} }`)
 *   2. the YAML is parsed (duplicate keys are an error)
 *   3. tokens inside string values are replaced: with the secret (resolve mode) or with the
 *      original `${…}` text (display mode, used by `fleet config` so secrets never print)
 *
 * Results are always strings (a whole-value `${PORT}` gives "222", not 222); consumers coerce.
 * A reference with no value and no default is collected and reported, never silently ''.
 * Tokens in YAML comments vanish with the comment, so commented-out refs are not required.
 */

import * as yaml from 'js-yaml'
import { isPlainObject } from './merge.js'

const TOKEN_RE = /AIRSTACKVAR(\d+)Z/g

export interface VarRef {
  name: string
  /** undefined = no default given */
  fallback?: string
  raw: string
}

export interface TokenizedYaml {
  data: unknown
  refs: VarRef[]
}

/** Parse YAML text with `${…}` references turned into tokens. Throws on YAML errors. */
export function parseYamlWithRefs(text: string, filename: string): TokenizedYaml {
  const refs: VarRef[] = []
  const tokenized = text.replace(/\$\{([^}]*)\}/g, (raw, expr: string) => {
    const m = expr.match(/^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/s)
    if (!m) throw new Error(`${filename}: invalid reference ${raw} (expected \${NAME} or \${NAME:-default})`)
    refs.push({ name: m[1], fallback: m[2], raw })
    return `AIRSTACKVAR${refs.length - 1}Z`
  })
  // js-yaml rejects duplicate mapping keys by default (json: false); keep it that way.
  const data = yaml.load(tokenized, { filename })
  return { data, refs }
}

export interface ResolveResult {
  value: unknown
  /** Names referenced in parsed values with no value and no default. */
  missing: string[]
  /** Names actually used (for redaction lists later). */
  used: string[]
}

/**
 * Replace tokens in every string value (and key) of a parsed tree.
 * mode 'resolve' → secret values; mode 'display' → the original `${…}` text.
 */
export function resolveRefs(
  tree: unknown,
  refs: VarRef[],
  secrets: Record<string, string>,
  mode: 'resolve' | 'display' = 'resolve',
): ResolveResult {
  const missing = new Set<string>()
  const used = new Set<string>()

  const sub = (s: string): string =>
    s.replace(TOKEN_RE, (_t, idx: string) => {
      const ref = refs[Number(idx)]
      if (!ref) return _t
      if (mode === 'display') return ref.raw
      const v = secrets[ref.name]
      if (v !== undefined && v !== '') { used.add(ref.name); return v }
      if (ref.fallback !== undefined) return ref.fallback
      missing.add(ref.name)
      return ''
    })

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return sub(node)
    if (Array.isArray(node)) return node.map(walk)
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node)) out[sub(k)] = walk(v)
      return out
    }
    return node
  }

  return { value: walk(tree), missing: [...missing].sort(), used: [...used].sort() }
}
