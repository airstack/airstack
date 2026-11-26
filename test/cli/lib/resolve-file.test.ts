import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { resolveFile, resolveDir, getSharedPaths } from '../../../cli/lib/resolve-file'

function makeTmp() {
  const dir = join(tmpdir(), `resolve-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('resolveFile', () => {
  let projectRoot: string
  let sharedDir: string

  beforeEach(() => {
    projectRoot = makeTmp()
    sharedDir = makeTmp()
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(sharedDir, { recursive: true, force: true })
  })

  it('finds file in projectRoot when sharedPaths is empty', () => {
    writeFileSync(join(projectRoot, 'stack.yml'), 'test')
    expect(resolveFile(projectRoot, [], 'stack.yml')).toBe(join(projectRoot, 'stack.yml'))
  })

  it('falls back to sharedPaths when not in projectRoot', () => {
    mkdirSync(join(sharedDir, 'templates'), { recursive: true })
    writeFileSync(join(sharedDir, 'templates', 'compose.hbs'), 'test')
    expect(resolveFile(projectRoot, [sharedDir], 'templates/compose.hbs'))
      .toBe(join(sharedDir, 'templates', 'compose.hbs'))
  })

  it('prefers projectRoot over sharedPaths', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    mkdirSync(join(sharedDir, 'templates'), { recursive: true })
    writeFileSync(join(projectRoot, 'templates', 'compose.hbs'), 'local')
    writeFileSync(join(sharedDir, 'templates', 'compose.hbs'), 'shared')
    expect(resolveFile(projectRoot, [sharedDir], 'templates/compose.hbs'))
      .toBe(join(projectRoot, 'templates', 'compose.hbs'))
  })

  it('throws when file not found anywhere', () => {
    expect(() => resolveFile(projectRoot, [sharedDir], 'missing.txt'))
      .toThrow(/not found/i)
  })

  it('searches multiple sharedPaths in order', () => {
    const shared2 = makeTmp()
    writeFileSync(join(shared2, 'file.txt'), 'from-second')
    expect(resolveFile(projectRoot, [sharedDir, shared2], 'file.txt'))
      .toBe(join(shared2, 'file.txt'))
    rmSync(shared2, { recursive: true, force: true })
  })
})

describe('resolveDir', () => {
  let projectRoot: string
  let sharedDir: string

  beforeEach(() => {
    projectRoot = makeTmp()
    sharedDir = makeTmp()
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(sharedDir, { recursive: true, force: true })
  })

  it('finds directory in projectRoot', () => {
    mkdirSync(join(projectRoot, 'deploy', 'host'), { recursive: true })
    expect(resolveDir(projectRoot, [], 'deploy/host'))
      .toBe(join(projectRoot, 'deploy', 'host'))
  })

  it('falls back to sharedPaths for directories', () => {
    mkdirSync(join(sharedDir, 'deploy', 'host'), { recursive: true })
    expect(resolveDir(projectRoot, [sharedDir], 'deploy/host'))
      .toBe(join(sharedDir, 'deploy', 'host'))
  })

  it('throws when directory not found', () => {
    expect(() => resolveDir(projectRoot, [], 'nope'))
      .toThrow(/not found/i)
  })
})

describe('getSharedPaths', () => {
  it('returns empty array when env var not set', () => {
    delete process.env.STACK_CLI_SHARED_PATH
    expect(getSharedPaths()).toEqual([])
  })

  it('returns array with path when env var is set', () => {
    process.env.STACK_CLI_SHARED_PATH = '/some/path'
    expect(getSharedPaths()).toEqual(['/some/path'])
    delete process.env.STACK_CLI_SHARED_PATH
  })
})
