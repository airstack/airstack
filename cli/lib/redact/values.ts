// Layer 1: replace every exact occurrence of a known secret value.

import { lineIndex, marker } from './format.js'
import type { RedactHit } from './types.js'

/** True when a secret value is long and specific enough to search for. */
export function isSearchableSecret(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 6) return false
  if (/^(true|false)$/i.test(value)) return false
  if (/^\d{1,7}$/.test(value)) return false
  return true
}

/** Replace known secret values. The longest values go first, so a value that holds another wins. */
export function redactKnownValues(
  text: string,
  secrets: Record<string, string> | undefined,
  hits: RedactHit[],
): string {
  if (!secrets) return text
  const byValue = new Map<string, string>()
  for (const [name, value] of Object.entries(secrets)) {
    if (isSearchableSecret(value) && !byValue.has(value)) byValue.set(value, name)
  }
  if (byValue.size === 0) return text

  const values = [...byValue.keys()].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(values.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  const lineOf = lineIndex(text)
  return text.replace(pattern, (match: string, offset: number) => {
    const name = byValue.get(match) ?? 'secret'
    hits.push({ line: lineOf(offset), kind: 'secret', label: name })
    // Keep the line count when a value spans lines, so line numbers stay true.
    const newlines = match.split('\n').length - 1
    return marker(name, match) + '\n'.repeat(newlines)
  })
}
