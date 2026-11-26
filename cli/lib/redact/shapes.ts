// Layer 3b: well-known secret shapes, found anywhere in the text.

import { lineIndex, marker, MARKER_PREFIX } from './format.js'
import { keyWords } from './keys.js'
import type { RedactHit } from './types.js'

interface Shape { label: string; re: RegExp; group?: number }

// Order matters: a JWT starts with `eyJh` too, so it goes before the tunnel token.
const SHAPES: Shape[] = [
  { label: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { label: 'cloudflare-tunnel-token', re: /(?<![A-Za-z0-9+/=_-])eyJh[A-Za-z0-9+/_-]{50,}={0,2}(?![A-Za-z0-9+/=_.-])/g },
  { label: 'api-key', re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{17,}/g },
  { label: 'github-token', re: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { label: 'slack-token', re: /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { label: 'aws-access-key', re: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g },
  { label: 'telegram-bot-token', re: /(?<![0-9A-Za-z])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { label: 'tailscale-key', re: /(?<![A-Za-z0-9_-])tskey-[A-Za-z0-9-]{10,}/g },
  // Only the password part of `scheme://user:password@host`.
  { label: 'url-password', re: /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi, group: 1 },
]

const PEM = /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g

/** Replace the body of each PEM private key block. The line count stays the same. */
export function redactPem(text: string, hits: RedactHit[]): string {
  const lineOf = lineIndex(text)
  return text.replace(PEM, (all: string, begin: string, body: string, end: string, offset: number) => {
    if (body.includes(MARKER_PREFIX) || body.trim() === '') return all
    const m = marker('private-key', body.trim())
    hits.push({ line: lineOf(offset), kind: 'shape', label: 'private-key' })
    if (!body.includes('\n')) {
      // One-line form, for example a JSON string with `\n` escapes.
      const lead = /^(\\n|\s)*/.exec(body)?.[0] ?? ''
      const trail = /(\\n|\s)*$/.exec(body)?.[0] ?? ''
      return begin + lead + m + trail + end
    }
    const parts = body.split('\n')
    // parts[0] is the rest of the BEGIN line; the last part is the indent before END.
    let first = true
    for (let k = 1; k < parts.length - 1; k++) {
      const pad = /^\s*/.exec(parts[k])?.[0] ?? ''
      if (parts[k].trim() === '') continue
      parts[k] = first ? pad + m : pad
      first = false
    }
    return begin + parts.join('\n') + end
  })
}

/** Replace well-known shapes on one line. Skips text inside markers. */
function redactLineShapes(line: string, lineNo: number, hits: RedactHit[]): string {
  let text = line
  for (const shape of SHAPES) {
    shape.re.lastIndex = 0
    text = text.replace(shape.re, (...args: unknown[]) => {
      const match = args[0] as string
      const offset = args[args.length - 2] as number
      if (insideMarker(text, offset)) return match
      const secret = shape.group ? (args[shape.group] as string) : match
      if (secret.includes(MARKER_PREFIX) || secret.startsWith('${')) return match
      hits.push({ line: lineNo, kind: 'shape', label: shape.label })
      return match.replace(secret, marker(shape.label, secret))
    })
  }
  return text
}

function insideMarker(text: string, offset: number): boolean {
  const open = text.lastIndexOf(MARKER_PREFIX, offset)
  if (open < 0) return false
  const close = text.indexOf(']', open)
  return close >= offset
}

// Generic long strings count only on a line with a key, and never for digests or hashes.
const KEY_PREFIX = /^\s*(?:(?:#+|\/\/)\s*)?(?:-\s+)?(?:export\s+)?["']?([A-Za-z0-9_.-]+)["']?\s*[:=]/
const NOT_SECRET_WORDS = new Set([
  'sha', 'sha1', 'sha256', 'sha512', 'md5', 'digest', 'hash', 'checksum', 'commit', 'rev',
  'revision', 'fingerprint', 'integrity', 'etag', 'image', 'ref',
])
const HEX = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g
const B64 = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g

function redactGeneric(line: string, lineNo: number, hits: RedactHit[]): string {
  const k = KEY_PREFIX.exec(line)
  if (!k) return line
  if (keyWords(k[1]).some(w => NOT_SECRET_WORDS.has(w))) return line
  const start = k[0].length
  let rest = line.slice(start)
  const digest = (s: string, off: number) => /(sha\d*|md5):$|@$/i.test(s.slice(0, off))
  rest = rest.replace(HEX, (m: string, off: number, s: string) => {
    if (digest(s, off)) return m
    hits.push({ line: lineNo, kind: 'shape', label: 'hex-secret' })
    return marker('hex-secret', m)
  })
  rest = rest.replace(B64, (m: string, off: number, s: string) => {
    if (digest(s, off) || insideMarker(s, off)) return m
    if (!/[0-9]/.test(m) || !/[A-Z]/.test(m) || !/[a-z]/.test(m)) return m
    hits.push({ line: lineNo, kind: 'shape', label: 'base64-secret' })
    return marker('base64-secret', m)
  })
  return line.slice(0, start) + rest
}

/** Apply all line shapes. `handled` lines (already redacted by key) skip the generic check. */
export function redactShapes(lines: string[], handled: Set<number>, hits: RedactHit[]): string[] {
  return lines.map((line, i) => {
    let text = redactLineShapes(line, i + 1, hits)
    if (!handled.has(i) && !text.includes(MARKER_PREFIX)) text = redactGeneric(text, i + 1, hits)
    return text
  })
}
