import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { listFiles, MANAGED_FILE, parseManaged, safeRelPath, writeManaged } from '../../../cli/lib/managed'
import { makeRoot, writeFiles } from '../node/helpers'

let root: string
let cleanup: () => void
beforeEach(() => ({ root, cleanup } = makeRoot('airstack-managed-')))
afterEach(() => cleanup())

describe('listFiles', () => {
  it('lists nested files, relative and sorted, without managed.json', () => {
    writeFiles(root, {
      'docker-compose.yml': 'a',
      'b/c/d.txt': 'b',
      'a.env': 'c',
      '.stack-config/other.json': 'd',
      [MANAGED_FILE]: '{}',
    })
    symlinkSync('a.env', join(root, 'link'))
    expect(listFiles(root)).toEqual(['.stack-config/other.json', 'a.env', 'b/c/d.txt', 'docker-compose.yml', 'link'])
  })

  it('answers [] for a missing dir or a file', () => {
    expect(listFiles(join(root, 'nope'))).toEqual([])
    writeFiles(root, { f: 'x' })
    expect(listFiles(join(root, 'f'))).toEqual([])
  })
})

describe('writeManaged / parseManaged', () => {
  it('round-trips, dedupes and sorts tracked, defaults rendered and redact', () => {
    writeFiles(root, { 'z.yml': 'z', 'a/b.conf': 'b' })
    const m = writeManaged(root, {
      unit: 'machine', kind: 'machine', fleetCommit: 'abc1234', deployedAt: '2026-01-01T00:00:00.000Z',
      tracked: ['x/y.yaml', 'a.yaml', 'x/y.yaml'],
    })
    expect(m).toEqual({
      format: 1, unit: 'machine', kind: 'machine', fleetCommit: 'abc1234', deployedAt: '2026-01-01T00:00:00.000Z',
      rendered: ['a/b.conf', 'z.yml'], tracked: ['a.yaml', 'x/y.yaml'], redact: [],
    })
    const text = readFileSync(join(root, MANAGED_FILE), 'utf-8')
    expect(text.endsWith('\n')).toBe(true)
    expect(parseManaged(text)).toEqual(m)
  })

  it('keeps given rendered and redact', () => {
    const redact = [{ files: ['config.yaml'], keys: ['api-keys'] }]
    const m = writeManaged(root, { unit: 'web', kind: 'stack', deployedAt: 't', tracked: [], rendered: ['only.txt'], redact })
    expect(m.rendered).toEqual(['only.txt'])
    expect(parseManaged(readFileSync(join(root, MANAGED_FILE), 'utf-8'))?.redact).toEqual(redact)
  })

  it('parseManaged defaults a missing or bad redact to []', () => {
    expect(parseManaged(JSON.stringify({ format: 1, rendered: [], tracked: [] }))?.redact).toEqual([])
    expect(parseManaged(JSON.stringify({ format: 1, rendered: [], tracked: [], redact: 'x' }))?.redact).toEqual([])
  })

  it('parseManaged rejects bad input', () => {
    expect(parseManaged('')).toBeUndefined()
    expect(parseManaged('not json')).toBeUndefined()
    expect(parseManaged('null')).toBeUndefined()
    expect(parseManaged(JSON.stringify({ format: 2, rendered: [], tracked: [] }))).toBeUndefined()
    expect(parseManaged(JSON.stringify({ format: 1, rendered: 'a', tracked: [] }))).toBeUndefined()
    expect(parseManaged(JSON.stringify({ format: 1, rendered: [] }))).toBeUndefined()
  })
})

describe('safeRelPath', () => {
  it('accepts plain relative paths', () => {
    for (const p of ['a', 'a/b.txt', '.env', '.stack-config/x.json', 'a..b']) expect(safeRelPath(p)).toBe(true)
  })
  it('rejects empty, absolute, .., empty segments and NUL', () => {
    for (const p of ['', '/etc/passwd', '../x', 'a/../../x', 'a/..', 'a//b', 'a/', 'a\0b']) expect(safeRelPath(p)).toBe(false)
  })
})
