// Redact a unified diff. Header lines (`diff`, `index`, `---`, `+++`, `@@`) stay as they are.

import { redact } from './redact.js'
import type { RedactHit, RedactOptions, RedactResult } from './types.js'

const HEADER = /^(diff |index |--- |\+\+\+ |@@|new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|Binary files)/

function pathFromHeader(line: string): string | undefined {
  const p = line.slice(4).split('\t')[0].trim()
  if (p === '/dev/null') return undefined
  return p.replace(/^[ab]\//, '')
}

/**
 * Redact the `+`, `-` and context lines of a unified diff.
 * Rules use `opts.file` when set, else the path from each `+++` (or `---`) header.
 */
export function redactDiff(diff: string, opts: RedactOptions = {}): RedactResult {
  const lines = diff.split('\n')
  const hits: RedactHit[] = []
  let file = opts.file
  let oldPath: string | undefined

  // Collect runs of body lines and redact each run as one text, so YAML context carries over.
  let run: number[] = []
  const flush = () => {
    if (!run.length) return
    const body = run.map(i => lines[i].slice(1)).join('\n')
    const r = redact(body, { ...opts, file })
    const redacted = r.text.split('\n')
    run.forEach((idx, k) => { lines[idx] = lines[idx][0] + redacted[k] })
    for (const h of r.hits) hits.push({ ...h, line: run[h.line - 1] + 1 })
    run = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (HEADER.test(line)) {
      flush()
      if (line.startsWith('--- ')) oldPath = pathFromHeader(line)
      if (line.startsWith('+++ ') && !opts.file) file = pathFromHeader(line) ?? oldPath
      continue
    }
    if (line.startsWith('\\')) continue
    if (line[0] === '+' || line[0] === '-' || line[0] === ' ') run.push(i)
    else flush()
  }
  flush()
  return { text: lines.join('\n'), count: hits.length, hits }
}
