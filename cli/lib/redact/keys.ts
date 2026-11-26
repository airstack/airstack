// Decide which key names hold secrets and which values are not worth redacting.

import { MARKER_PREFIX } from './format.js'

const SECRET_WORDS = new Set([
  'secret', 'secrets', 'token', 'tokens', 'password', 'passwords', 'passwd', 'pass', 'passphrase',
  'credential', 'credentials', 'bearer', 'cookie', 'cookies', 'session', 'sessions',
  'apikey', 'apikeys',
])
const SECRET_PAIRS = /(^|-)(api-keys?|private-keys?|auth-keys?)(-|$)/

// A key that ends in one of these words names a setting about the secret, not the secret.
const SKIP_LAST = new Set([
  'url', 'uri', 'endpoint', 'file', 'path', 'dir', 'name', 'type', 'mode', 'header', 'enabled',
  'ttl', 'timeout', 'expiry', 'expires', 'length', 'size', 'interval', 'prefix', 'format',
])
// A key that holds one of these words is a number or a limit.
const SKIP_ANY = new Set(['max', 'min', 'count', 'limit'])

/** Split a key into lowercase words: `apiKey`, `API_KEY`, `api-key` all give [api, key]. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** True when the key name looks like it holds a secret. */
export function isSecretKey(key: string): boolean {
  const words = keyWords(key)
  if (words.length === 0) return false
  if (SKIP_LAST.has(words[words.length - 1])) return false
  if (words.some(w => SKIP_ANY.has(w))) return false
  if (words.some(w => SECRET_WORDS.has(w))) return true
  return SECRET_PAIRS.test(words.join('-'))
}

/** True for values that refer to a secret but do not hold one: empty, null, ${VAR}, <placeholder>. */
export function isReference(value: string): boolean {
  const v = value.trim()
  if (v === '' || v === '~' || /^null$/i.test(v)) return true
  if (v.includes('${') || v.includes('{{')) return true
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return true
  if (/^<[^<>]*>$/.test(v)) return true
  if (v.includes(MARKER_PREFIX)) return true
  return false
}

/** True for values that are clearly not secrets, even under a secret-ish key. */
export function isTrivialValue(value: string): boolean {
  if (isReference(value)) return true
  const v = value.trim()
  if (/^(true|false|yes|no|on|off)$/i.test(v)) return true
  if (/^-?\d{1,7}(\.\d+)?$/.test(v)) return true
  return false
}

/** True for a YAML block scalar indicator (`|`, `>-`, `|2` ...): the value is on the next lines. */
export function isBlockScalar(value: string): boolean {
  return /^[|>][-+0-9]*$/.test(value.trim())
}
