// Markers and line helpers.

import { createHash } from 'node:crypto'

/** First 6 hex chars of sha256(value). The same value always gives the same hash. */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6)
}

/** The text that replaces a secret: `[redacted:<label>:<hash>]`. */
export function marker(label: string, value: string): string {
  return `[redacted:${label}:${shortHash(value)}]`
}

export const MARKER_PREFIX = '[redacted:'

/** Prefix each line with a right-aligned line number and a tab, like `cat -n`. */
export function withLineNumbers(text: string): string {
  if (text === '') return ''
  const endsWithNewline = text.endsWith('\n')
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n')
  const width = Math.max(6, String(lines.length).length)
  const out = lines.map((l, i) => `${String(i + 1).padStart(width)}\t${l}`).join('\n')
  return endsWithNewline ? out + '\n' : out
}

/** Map a character offset in `text` to a 1-based line number. */
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return (offset: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1
    }
    return lo + 1
  }
}
