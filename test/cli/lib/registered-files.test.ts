import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../helpers'
import {
  findLocalScriptsMissingExecute,
  diffHostFiles,
} from '../../../cli/lib/registered-files'

describe('findLocalScriptsMissingExecute', () => {
  const cleanups: string[] = []

  afterEach(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
    cleanups.length = 0
  })

  it('returns scripts without +x permission', () => {
    const base = makeTmpDir('reg-files')
    cleanups.push(base)
    mkdirSync(join(base, 'plugins'), { recursive: true })
    writeFileSync(join(base, 'plugins', 'run.sh'), '#!/bin/bash\n')
    chmodSync(join(base, 'plugins', 'run.sh'), 0o644)

    const result = findLocalScriptsMissingExecute(base, {
      dirs: ['plugins'],
      exclude: [],
    })
    expect(result).toEqual(['plugins/run.sh'])
  })

  it('skips scripts that already have +x', () => {
    const base = makeTmpDir('reg-files')
    cleanups.push(base)
    mkdirSync(join(base, 'plugins'), { recursive: true })
    writeFileSync(join(base, 'plugins', 'ok.sh'), '#!/bin/bash\n')
    chmodSync(join(base, 'plugins', 'ok.sh'), 0o755)

    const result = findLocalScriptsMissingExecute(base, {
      dirs: ['plugins'],
      exclude: [],
    })
    expect(result).toEqual([])
  })

  it('respects exclude list', () => {
    const base = makeTmpDir('reg-files')
    cleanups.push(base)
    mkdirSync(join(base, 'plugins', 'cron', 'lib'), { recursive: true })
    writeFileSync(join(base, 'plugins', 'cron', 'lib', 'stacks.sh'), '#!/bin/bash\n')
    chmodSync(join(base, 'plugins', 'cron', 'lib', 'stacks.sh'), 0o644)
    writeFileSync(join(base, 'plugins', 'cron', 'run.sh'), '#!/bin/bash\n')
    chmodSync(join(base, 'plugins', 'cron', 'run.sh'), 0o644)

    const result = findLocalScriptsMissingExecute(base, {
      dirs: ['plugins'],
      exclude: ['plugins/cron/lib/stacks.sh'],
    })
    expect(result).toEqual(['plugins/cron/run.sh'])
  })

  it('scans multiple dirs', () => {
    const base = makeTmpDir('reg-files')
    cleanups.push(base)
    mkdirSync(join(base, 'plugins'), { recursive: true })
    mkdirSync(join(base, 'crons'), { recursive: true })
    writeFileSync(join(base, 'plugins', 'a.sh'), '#!/bin/bash\n')
    chmodSync(join(base, 'plugins', 'a.sh'), 0o644)
    writeFileSync(join(base, 'crons', 'b.sh'), '#!/bin/bash\n')
    chmodSync(join(base, 'crons', 'b.sh'), 0o644)

    const result = findLocalScriptsMissingExecute(base, {
      dirs: ['plugins', 'crons'],
      exclude: [],
    })
    expect(result).toEqual(['crons/b.sh', 'plugins/a.sh'])
  })

  it('ignores non-.sh files', () => {
    const base = makeTmpDir('reg-files')
    cleanups.push(base)
    mkdirSync(join(base, 'plugins'), { recursive: true })
    writeFileSync(join(base, 'plugins', 'readme.md'), '# readme\n')
    chmodSync(join(base, 'plugins', 'readme.md'), 0o644)
    writeFileSync(join(base, 'plugins', 'config.yml'), 'key: val\n')
    chmodSync(join(base, 'plugins', 'config.yml'), 0o644)

    const result = findLocalScriptsMissingExecute(base, {
      dirs: ['plugins'],
      exclude: [],
    })
    expect(result).toEqual([])
  })

  it('handles missing dirs gracefully', () => {
    const base = makeTmpDir('reg-files')
    cleanups.push(base)

    const result = findLocalScriptsMissingExecute(base, {
      dirs: ['nonexistent'],
      exclude: [],
    })
    expect(result).toEqual([])
  })
})

describe('diffHostFiles', () => {
  it('returns files present in remote but not in local', () => {
    const remote = ['/etc/logrotate.d/mystack', '/etc/cron.d/mystack']
    const local = ['/etc/logrotate.d/mystack']

    expect(diffHostFiles(remote, local)).toEqual(['/etc/cron.d/mystack'])
  })

  it('returns empty when no orphans', () => {
    const files = ['/etc/logrotate.d/mystack', '/etc/cron.d/mystack']
    expect(diffHostFiles(files, files)).toEqual([])
  })

  it('returns empty when remote is empty', () => {
    expect(diffHostFiles([], ['/etc/logrotate.d/mystack'])).toEqual([])
  })

  it('returns all remote files when local is empty', () => {
    const remote = ['/etc/logrotate.d/mystack', '/etc/cron.d/mystack']
    expect(diffHostFiles(remote, [])).toEqual([
      '/etc/logrotate.d/mystack',
      '/etc/cron.d/mystack',
    ])
  })
})
