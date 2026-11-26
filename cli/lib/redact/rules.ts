// Plugin redaction rules: which keys in which files hold secrets.

/**
 * A plugin rule. It tells the redactor which keys hold secrets in which files.
 *
 * - `files`: globs relative to the unit install dir. `*` matches inside one path
 *   segment. `**` matches any number of segments.
 * - `keys`: key names (`api-keys`) or dotted paths (`remote-management.secret-key`).
 *   A key matches its own value and every value nested below it (list items too).
 */
export interface RedactRule {
  files: string[]
  keys: string[]
}

/** Convert a simple glob (`*`, `**`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` may match zero segments.
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') {
      re += '[^/]*'
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '')
}

/** Return the key paths (split into segments) of every rule that applies to `file`. */
export function keysForFile(rules: RedactRule[] | undefined, file: string | undefined): string[][] {
  if (!rules?.length || !file) return []
  const f = normalizePath(file)
  const out: string[][] = []
  for (const rule of rules) {
    if (!rule.files.some(g => globToRegExp(normalizePath(g)).test(f))) continue
    for (const k of rule.keys) out.push(k.split('.').filter(Boolean))
  }
  return out
}

/** True when one rule key path appears as a contiguous run inside `path`. */
export function pathMatchesRule(path: string[], ruleKeys: string[][]): boolean {
  for (const r of ruleKeys) {
    if (r.length === 0 || r.length > path.length) continue
    for (let start = 0; start + r.length <= path.length; start++) {
      if (r.every((seg, j) => path[start + j] === seg)) return true
    }
  }
  return false
}
