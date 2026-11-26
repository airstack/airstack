#!/usr/bin/env bun
/**
 * Build release tarballs + SHA256SUMS into dist/.
 *
 *   bun devutils/release/build.ts                     all targets, dev build id (git commit)
 *   bun devutils/release/build.ts --release           all targets, release build (version only)
 *   bun devutils/release/build.ts --target linux-arm64 [--target …] [--out dist]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { buildRelease, sourceBuildId } from '../../cli/lib/release/build.js'
import { CHECKSUMS_FILE, isTarget, TARGETS, type Target } from '../../cli/lib/release/targets.js'

const args = process.argv.slice(2)
const targets: Target[] = []
let outDir = resolve('dist')
let release = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--release') release = true
  else if (a === '--out') outDir = resolve(args[++i])
  else if (a === '--target') {
    const t = args[++i]
    if (!isTarget(t)) { console.error(`fail unknown target '${t}' (${TARGETS.join(', ')})`); process.exit(3) }
    targets.push(t)
  } else { console.error(`fail unknown option: ${a}`); process.exit(3) }
}

mkdirSync(outDir, { recursive: true })
const buildId = release ? 'release' : sourceBuildId()
const lines: string[] = []
for (const t of targets.length ? targets : TARGETS) {
  const r = buildRelease(t, { outDir, buildId, log: (s) => console.log(`->   ${s}`) })
  lines.push(`${r.sha256}  ${basename(r.tarball)}`)
  console.log(`ok   ${basename(r.tarball)}`)
}
writeFileSync(resolve(outDir, CHECKSUMS_FILE), `${lines.join('\n')}\n`)
console.log(`ok   ${CHECKSUMS_FILE} (${lines.length} file(s)) in ${outDir}`)
