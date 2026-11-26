// Parse one line of YAML, JSON or env text into keys and value spans.
// This is not a full parser. It finds `key: value`, `"key": "value"`, `KEY=value`
// and `- item` forms, also inside `#` or `//` comments.

/** A value position in the line: [start, end) of the text to replace (inside quotes). */
export interface Span {
  start: number
  end: number
  value: string
}

export interface Pair {
  key: string
  /** Column of the key in the raw line. */
  column: number
  /** Raw value text (trimmed, unquoted). Empty when the value is on the next lines. */
  value: string
  /** Value spans to redact. A flow list (`[a, b]`) gives one span per item. */
  spans: Span[]
}

export interface ParsedLine {
  comment: boolean
  /** Column of the `-` when the line is a list item, else -1. */
  dash: number
  /** Key/value pairs. Inline JSON objects can hold several. */
  pairs: Pair[]
  /** A list item that is a plain value (`- value`). */
  scalar?: Span
}

const YAML_KEY = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_][\w.\-/@]*))\s*:(?=\s|$)/
const ENV_KEY = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/
const JSON_PAIR = /"([^"\\]+)"\s*:\s*/g

/** Read a value that starts at or after `pos`. `json` stops plain values at `,` `}` `]`. */
export function readValue(line: string, pos: number, json = false): Span | null {
  let i = pos
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  if (i >= line.length) return null
  const q = line[i]
  if (q === '"' || q === "'") {
    let j = i + 1
    while (j < line.length) {
      if (q === '"' && line[j] === '\\') { j += 2; continue }
      if (line[j] === q) {
        if (q === "'" && line[j + 1] === "'") { j += 2; continue }
        break
      }
      j++
    }
    const end = Math.min(j, line.length)
    return { start: i + 1, end, value: line.slice(i + 1, end) }
  }
  let end = line.length
  const stop = json ? /[,}\]]|\s#/ : /\s#/
  const m = stop.exec(line.slice(i))
  if (m) end = i + m.index
  while (end > i && /\s/.test(line[end - 1])) end--
  if (end <= i) return null
  return { start: i, end, value: line.slice(i, end) }
}

/** Split a YAML flow list `[a, "b"]` that starts at `open` into item spans. */
function flowItems(line: string, open: number): Span[] {
  const close = line.indexOf(']', open)
  if (close < 0) return []
  const spans: Span[] = []
  let pos = open + 1
  while (pos < close) {
    const s = readValue(line.slice(0, close), pos, true)
    if (!s) break
    if (s.end > s.start) spans.push(s)
    const comma = line.indexOf(',', s.end)
    if (comma < 0 || comma > close) break
    pos = comma + 1
  }
  return spans
}

function pairAt(line: string, key: string, column: number, valuePos: number, json: boolean): Pair {
  const s = readValue(line, valuePos, json)
  if (!s) return { key, column, value: '', spans: [] }
  const raw = line[s.start - 1]
  const quoted = raw === '"' || raw === "'"
  if (!quoted && (s.value === '{' || s.value.startsWith('{'))) return { key, column, value: '', spans: [] }
  if (!quoted && s.value.startsWith('[')) {
    if (!s.value.includes(']')) return { key, column, value: '', spans: [] }
    return { key, column, value: s.value, spans: flowItems(line, s.start) }
  }
  return { key, column, value: s.value, spans: [s] }
}

export function parseLine(line: string): ParsedLine {
  const out: ParsedLine = { comment: false, dash: -1, pairs: [] }
  let p = 0
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) p++
  const c = /^(#+|\/\/)/.exec(line.slice(p))
  if (c) {
    out.comment = true
    p += c[0].length
    while (p < line.length && line[p] === ' ') p++
  }
  if (p >= line.length) return out

  // JSON (or quoted YAML) pairs; there can be several on one line.
  if (line[p] === '"' || line[p] === '{') {
    JSON_PAIR.lastIndex = p
    let m: RegExpExecArray | null
    while ((m = JSON_PAIR.exec(line)) !== null) {
      out.pairs.push(pairAt(line, m[1], m.index, m.index + m[0].length, true))
    }
    if (out.pairs.length) return out
  }

  if (line[p] === '-' && (p + 1 >= line.length || line[p + 1] === ' ')) {
    out.dash = p
    p++
    while (p < line.length && line[p] === ' ') p++
    if (p >= line.length) return out
  }

  const rest = line.slice(p)
  const y = YAML_KEY.exec(rest)
  if (y) {
    const key = y[1] ?? y[2] ?? y[3]
    out.pairs.push(pairAt(line, key, p, p + y[0].length, false))
    return out
  }
  if (out.dash < 0) {
    const e = ENV_KEY.exec(rest)
    if (e) {
      const keyCol = p + rest.indexOf(e[1])
      out.pairs.push(pairAt(line, e[1], keyCol, p + e[0].length, false))
      return out
    }
  }
  if (out.dash >= 0) {
    const s = readValue(line, p)
    if (s && s.end > s.start) out.scalar = s
  }
  return out
}
