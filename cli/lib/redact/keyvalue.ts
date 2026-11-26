// Layers 2 and 3a: redact values by key name, line by line.
// Layer 2 uses plugin rules (key paths). Layer 3a uses secret-ish key names.
// An indent stack tracks the YAML key path, so a rule can name a dotted path
// and a list item belongs to the key above it.

import { isBlockScalar, isReference, isSecretKey, isTrivialValue } from './keys.js'
import { marker } from './format.js'
import { parseLine, type Span } from './parse.js'
import { pathMatchesRule } from './rules.js'
import type { HitKind, RedactHit } from './types.js'

interface Level { column: number; key: string; open: boolean }

interface Target { key: string; path: string[]; value: string; spans: Span[] }

function popForKey(stack: Level[], column: number): void {
  while (stack.length && stack[stack.length - 1].column >= column) stack.pop()
}

function popForDash(stack: Level[], dash: number): void {
  while (stack.length) {
    const top = stack[stack.length - 1]
    if (top.column > dash || (top.column === dash && !top.open)) stack.pop()
    else break
  }
}

function classify(t: Target, ruleKeys: string[][]): HitKind | null {
  if (pathMatchesRule(t.path, ruleKeys)) return isReference(t.value) ? null : 'rule'
  if (isSecretKey(t.key)) return isTrivialValue(t.value) ? null : 'key'
  return null
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

export interface KeyPassResult {
  lines: string[]
  /** 0-based indexes of lines this pass changed. */
  handled: Set<number>
}

export function redactByKeys(lines: string[], ruleKeys: string[][], hits: RedactHit[]): KeyPassResult {
  const out = lines.slice()
  const handled = new Set<number>()
  const stack: Level[] = []
  let cstack: Level[] = []
  let inComment = false

  for (let i = 0; i < out.length; i++) {
    const line = out[i]
    if (line.trim() === '') continue
    const parsed = parseLine(line)
    if (parsed.comment && !inComment) cstack = stack.map(l => ({ ...l }))
    inComment = parsed.comment
    const st = parsed.comment ? cstack : stack

    const targets: Target[] = []
    if (parsed.dash >= 0) popForDash(st, parsed.dash)
    if (parsed.scalar) {
      const parent = st[st.length - 1]
      if (parent) targets.push({ key: parent.key, path: st.map(l => l.key), value: parsed.scalar.value, spans: [parsed.scalar] })
    }
    const single = parsed.pairs.length === 1
    const base = st.slice()
    if (single) popForKey(base, parsed.pairs[0].column)
    for (const pair of parsed.pairs) {
      targets.push({ key: pair.key, path: [...base.map(l => l.key), pair.key], value: pair.value, spans: pair.spans })
    }
    if (single) {
      popForKey(st, parsed.pairs[0].column)
      const pv = parsed.pairs[0].value
      st.push({ column: parsed.pairs[0].column, key: parsed.pairs[0].key, open: pv === '' || isBlockScalar(pv) })
    }

    let text = line
    let blockEnd = -1
    for (const t of targets) {
      const kind = classify(t, ruleKeys)
      if (!kind) continue
      if (isBlockScalar(t.value)) {
        const col = parsed.pairs[0]?.column ?? indentOf(line)
        blockEnd = redactBlock(out, i, col, t.key, kind, hits)
        for (let j = i + 1; j <= blockEnd; j++) handled.add(j)
        break
      }
      // Replace right to left so earlier offsets stay valid.
      const spans = t.spans.filter(s => !isReference(s.value)).sort((a, b) => b.start - a.start)
      for (const s of spans) {
        text = text.slice(0, s.start) + marker(t.key, s.value) + text.slice(s.end)
        hits.push({ line: i + 1, kind, label: t.key })
        handled.add(i)
      }
    }
    if (blockEnd >= 0) { i = blockEnd; continue }
    if (handled.has(i)) out[i] = text
  }
  return { lines: out, handled }
}

/** Redact a YAML block scalar body below line `at`. Returns the index of its last line. */
function redactBlock(lines: string[], at: number, column: number, label: string, kind: HitKind, hits: RedactHit[]): number {
  let end = at
  for (let j = at + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue
    if (indentOf(lines[j]) <= column) break
    end = j
  }
  if (end === at) return at
  const body = lines.slice(at + 1, end + 1).map(l => l.trim()).join('\n')
  let first = true
  for (let j = at + 1; j <= end; j++) {
    if (lines[j].trim() === '') continue
    const pad = lines[j].slice(0, indentOf(lines[j]))
    lines[j] = first ? pad + marker(label, body) : pad
    if (first) hits.push({ line: j + 1, kind, label })
    first = false
  }
  return end
}
