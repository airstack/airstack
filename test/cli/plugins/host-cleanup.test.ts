import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../helpers'

// host_cleanup.sh needs GNU find/df/flock: these tests run on Linux (CI, the VPS), not macOS.
const SCRIPT = join(import.meta.dirname, '../../../cli/plugins/cron/deploy/host-status/host_cleanup.sh')

// Fake df: 1000 inodes in SIM_DIR, plenty of space. Lets the guard see inode pressure on a plain dir.
const FAKE_DF = `#!/bin/bash
cols="\${1#--output=}"
used=$(find "$SIM_DIR" | wc -l)
declare -A v=( [size]=1000000 [avail]=900000 [iused]=$used [iavail]=$((1000 - used)) )
hdr=""; line=""
IFS=, read -ra c <<< "$cols"
for k in "\${c[@]}"; do hdr+="$k "; line+="\${v[$k]:-0} "; done
echo "$hdr"; echo "$line"
`

const DAY = 86400
function touch(path: string, ageSeconds: number): void {
  writeFileSync(path, '')
  const t = Date.now() / 1000 - ageSeconds
  utimesSync(path, t, t)
}

describe.skipIf(process.platform !== 'linux')('host_cleanup.sh /tmp guard', () => {
  let root = ''
  let tmp = ''
  const run = (env: Record<string, string> = {}, args: string[] = ['--tmp-only']): string => {
    try {
      return execFileSync('bash', [SCRIPT, ...args], {
        env: {
          PATH: process.env.PATH ?? '',
          SIM_DIR: tmp, DF_CMD: join(root, 'df'), TMP_DIRS: tmp, TMP_PRUNE: 'true',
          CLEANUP_LOCK: join(root, 'lock'), ...env,
        },
        encoding: 'utf-8',
      })
    } catch (e: any) {
      return `EXIT ${e.status}\n${e.stdout ?? ''}${e.stderr ?? ''}`
    }
  }
  const count = (prefix: string) => readdirSync(tmp).filter(n => n.startsWith(prefix)).length

  beforeEach(() => {
    root = makeTmpDir('hc')
    tmp = join(root, 'tmp')
    mkdirSync(tmp)
    writeFileSync(join(root, 'df'), FAKE_DF)
    chmodSync(join(root, 'df'), 0o755)
    for (let i = 0; i < 300; i++) {
      touch(join(tmp, `old${i}`), 30 * DAY)
      touch(join(tmp, `mid${i}`), 3 * DAY)
      touch(join(tmp, `rec${i}`), 2 * 3600)
    }
    for (let i = 0; i < 20; i++) touch(join(tmp, `fresh${i}`), 0)
    mkdirSync(join(tmp, 'systemd-private-x'))
    touch(join(tmp, 'systemd-private-x', 'f'), 30 * DAY)
    touch(join(tmp, 'a.sock'), 30 * DAY)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('does nothing while inodes and space are above the trigger', () => {
    for (let i = 0; i < 300; i++) rmSync(join(tmp, `rec${i}`))
    for (let i = 0; i < 300; i++) rmSync(join(tmp, `mid${i}`))
    const out = run()
    expect(out).toContain('ok (space free')
    expect(count('old')).toBe(300)
  })

  it('dry run deletes nothing', () => {
    const out = run({}, ['--tmp-only', '--dry-run'])
    expect(out).toContain('DRY RUN: would delete 300 file(s)')
    expect(count('old')).toBe(300)
  })

  it('deletes old files first, then oldest-first to the target, and spares young + excluded', () => {
    const out = run({ TMP_BATCH: '50' })
    expect(out).toContain('TRIGGERED')
    expect(count('old')).toBe(0)
    expect(count('mid')).toBeLessThan(300) // phase 2 went into the 3-day-old files
    expect(count('rec')).toBeGreaterThan(0) // ...and stopped at the target
    expect(count('fresh')).toBe(20) // never newer than TMP_MIN_AGE_MINUTES
    expect(existsSync(join(tmp, 'systemd-private-x', 'f'))).toBe(true)
    expect(existsSync(join(tmp, 'a.sock'))).toBe(true)
    expect(run()).toContain('ok (space free') // settled: a second run does nothing
  })

  it('stays off unless TMP_PRUNE=true', () => {
    expect(run({ TMP_PRUNE: 'false' })).toContain('guard is off')
    expect(count('old')).toBe(300)
  })

  it('rejects a target below the triggers and non-numeric knobs', () => {
    expect(run({ TMP_TARGET_FREE_PCT: '10' })).toMatch(/EXIT 2[\s\S]*must be >=/)
    expect(run({ TMP_MAX_AGE_DAYS: 'week' })).toMatch(/EXIT 2[\s\S]*whole number/)
    expect(count('old')).toBe(300)
  })

  it('refuses to prune /', () => {
    expect(run({ TMP_DIRS: '/' })).toContain("refusing to prune '/'")
  })
})
