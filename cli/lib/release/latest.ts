/** latest.ts — the newest published airstack release (GitHub releases of airstack/airstack). */

import { RELEASE_REPO } from './targets.js'

export async function latestVersion(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'airstack-cli' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`cannot read the latest release: HTTP ${res.status}`)
  const tag = String(((await res.json()) as { tag_name?: string }).tag_name ?? '')
  const v = tag.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+([-.+][\w.]+)?$/.test(v)) throw new Error(`unexpected release tag '${tag}'`)
  return v
}

/** -1, 0, 1 for semver-ish "1.2.3" strings (pre-release suffixes sort before the release). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre] = v.split(/-(.*)/)
    return { nums: main.split('.').map((n) => Number(n) || 0), pre: pre ?? '' }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}
