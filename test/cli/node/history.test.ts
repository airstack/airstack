import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeManaged } from '../../../cli/lib/managed'
import { blobId as hookBlobId } from '../../../cli/lib/history-hooks'
import { blobId, checkDrift, recordDeploy, snapshotUnit } from '../../../cli/node/history'
import { Store } from '../../../cli/node/store'
import type { NodeUnit } from '../../../cli/node/units'
import { machineUnit, makeRoot, stackUnit, writeFiles } from './helpers'

let root: string
let cleanup: () => void
let store: Store
let unit: NodeUnit

const subjects = () => store.log([], 50).map((e) => e.subject)
const commitCount = () => Number(store.git(['rev-list', '--count', 'HEAD']).out.trim())

/** A deployed unit: rendered files + managed.json naming one tracked file. */
function deployUnit(u: NodeUnit, files: Record<string, string> = { 'docker-compose.yml': 'services: {}\n', 'conf/app.env': 'A=1\n' }) {
  writeFiles(u.dir, files)
  writeManaged(u.dir, { unit: u.name, kind: u.kind, deployedAt: 't', tracked: ['box/config.yaml'] })
}

const edit = (u: NodeUnit, rel: string, text: string) => writeFiles(u.dir, { [rel]: text })

// The store is a root-only repo on a node: keep the developer's global git config (hooks,
// signing, identity checks) out of it.
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})
afterAll(() => {
  if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = savedEnv.global
  if (savedEnv.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = savedEnv.nosystem
})

beforeEach(() => {
  ({ root, cleanup } = makeRoot('airstack-history-'))
  store = new Store(root)
  unit = machineUnit(root)
})
afterEach(() => cleanup())

describe('blobId', () => {
  it('equals git hash-object and the controller-side blobId', () => {
    const f = join(root, 'sample.txt')
    const text = 'hello airstack\nline 2\n'
    writeFileSync(f, text)
    const git = spawnSync('git', ['hash-object', f], { encoding: 'utf-8' }).stdout.trim()
    expect(blobId(text)).toBe(git)
    expect(blobId(readFileSync(f))).toBe(git)
    expect(hookBlobId(readFileSync(f))).toBe(git)
    expect(blobId('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  })
})

describe('snapshotUnit', () => {
  it('missing managed.json → untracked, no store', () => {
    writeFiles(unit.dir, { 'a.txt': 'a' })
    expect(snapshotUnit(store, unit)).toEqual({ unit: 'machine', changed: [], untracked: true })
    expect(store.exists()).toBe(false)
  })

  it('first call commits "first snapshot", no change → no commit', () => {
    deployUnit(unit)
    const r = snapshotUnit(store, unit)
    expect(r.changed).toEqual(['conf/app.env', 'docker-compose.yml'])
    expect(r.commit).toBe(store.head())
    expect(subjects()[0]).toBe('first snapshot: machine: conf/app.env, docker-compose.yml')
    expect(subjects().at(-1)).toBe('start config history')
    expect(statSync(store.dir).mode & 0o777).toBe(0o700)

    const n = commitCount()
    expect(snapshotUnit(store, unit)).toEqual({ unit: 'machine', changed: [] })
    expect(commitCount()).toBe(n)
  })

  it('a rendered file edit → "box edit" commit listing it', () => {
    deployUnit(unit)
    snapshotUnit(store, unit)
    edit(unit, 'conf/app.env', 'A=2\n')
    const r = snapshotUnit(store, unit)
    expect(r.changed).toEqual(['conf/app.env'])
    expect(subjects()[0]).toBe('box edit: machine: conf/app.env')
    expect(store.fileAt('HEAD', 'machine/conf/app.env')?.toString()).toBe('A=2\n')
  })

  it('captures tracked files and ignores state files', () => {
    deployUnit(unit)
    snapshotUnit(store, unit)
    edit(unit, 'box/config.yaml', 'k: v\n')
    edit(unit, 'data/state.db', 'blob')
    const r = snapshotUnit(store, unit, 'custom why')
    expect(r.changed).toEqual(['box/config.yaml'])
    expect(subjects()[0]).toBe('custom why: machine: box/config.yaml')
    expect(store.slotFiles('machine')).toEqual(['box/config.yaml', 'conf/app.env', 'docker-compose.yml'])

    edit(unit, 'data/state.db', 'blob2')
    expect(snapshotUnit(store, unit).changed).toEqual([])
  })

  it('records a deleted file', () => {
    deployUnit(unit)
    snapshotUnit(store, unit)
    rmSync(join(unit.dir, 'conf/app.env'))
    expect(snapshotUnit(store, unit).changed).toEqual(['conf/app.env'])
    expect(store.fileAt('HEAD', 'machine/conf/app.env')).toBeUndefined()
  })

  it('summarizes more than three files', () => {
    deployUnit(unit, { a: '1', b: '2', c: '3', d: '4', e: '5' })
    snapshotUnit(store, unit)
    expect(subjects()[0]).toBe('first snapshot: machine: a, b, c +2 more')
  })

  it('works for a stack slot (stacks/<name>), first snapshot is per slot', () => {
    deployUnit(unit)
    snapshotUnit(store, unit)
    const web = stackUnit(root, 'web')
    deployUnit(web, { 'compose.yml': 'x' })
    snapshotUnit(store, web)
    expect(subjects()[0]).toBe('first snapshot: web: compose.yml')
    edit(web, 'compose.yml', 'y')
    snapshotUnit(store, web)
    expect(subjects()[0]).toBe('box edit: web: compose.yml')
  })
})

describe('recordDeploy', () => {
  it('commits and marks the deployed ref; slot "/" becomes "_"', () => {
    const web = stackUnit(root, 'web')
    deployUnit(web)
    const r = recordDeploy(store, web, 'abc1234')
    expect(r.commit).toBeDefined()
    expect(subjects()[0]).toBe('deploy web (fleet abc1234): conf/app.env, docker-compose.yml')
    expect(store.deployedRef('stacks/web')).toBe('refs/airstack/deployed/stacks_web')
    expect(store.git(['rev-parse', 'refs/airstack/deployed/stacks_web']).out.trim()).toBe(r.commit)
    expect(store.lastDeployed('stacks/web')).toBe(r.commit)
  })

  it('no file change → no commit, ref still moves to HEAD', () => {
    deployUnit(unit)
    snapshotUnit(store, unit)
    edit(unit, 'conf/app.env', 'A=9\n')
    snapshotUnit(store, unit)
    const head = store.head()
    const n = commitCount()
    const r = recordDeploy(store, unit)
    expect(r.commit).toBeUndefined()
    expect(r.changed).toEqual([])
    expect(commitCount()).toBe(n)
    expect(store.lastDeployed('machine')).toBe(head)
  })

  it('default fleet commit is "unknown"; missing managed.json → untracked', () => {
    deployUnit(unit)
    recordDeploy(store, unit)
    expect(subjects()[0]).toMatch(/^deploy machine \(fleet unknown\): /)
    const bare = stackUnit(root, 'bare')
    writeFiles(bare.dir, { x: 'x' })
    expect(recordDeploy(store, bare).untracked).toBe(true)
    expect(store.lastDeployed('stacks/bare')).toBeUndefined()
  })
})

describe('checkDrift', () => {
  const inc = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, blobId(v)]))

  it('no managed.json → nothing', () => {
    expect(checkDrift(store, unit, inc({ a: 'x' }))).toEqual({ unit: 'machine', boxEdits: [], conflicts: [] })
  })

  it('live == incoming → no conflict', () => {
    deployUnit(unit)
    recordDeploy(store, unit)
    edit(unit, 'conf/app.env', 'A=2\n')
    const r = checkDrift(store, unit, inc({ 'conf/app.env': 'A=2\n' }))
    expect(r.boxEdits).toEqual(['conf/app.env'])
    expect(r.conflicts).toEqual([])
    expect(r.head).toBe(store.head())
    expect(subjects()[0]).toBe('box edit (found before deploy): machine: conf/app.env')
  })

  it('live == last deploy → no conflict', () => {
    deployUnit(unit)
    recordDeploy(store, unit)
    const r = checkDrift(store, unit, inc({ 'conf/app.env': 'A=new\n', 'docker-compose.yml': 'new' }))
    expect(r).toMatchObject({ boxEdits: [], conflicts: [] })
  })

  it('box edit nobody pulled → conflict; pulled base → no conflict; later edit → conflict again', () => {
    deployUnit(unit)
    recordDeploy(store, unit)
    edit(unit, 'conf/app.env', 'A=box\n')
    edit(unit, 'docker-compose.yml', 'box compose')
    const incoming = inc({ 'conf/app.env': 'A=fleet\n', 'docker-compose.yml': 'fleet compose' })
    const first = checkDrift(store, unit, incoming)
    expect(first.conflicts).toEqual(['conf/app.env', 'docker-compose.yml'])

    // `airstack pull` stores the head as its base.
    const base = first.head!
    expect(checkDrift(store, unit, incoming, base).conflicts).toEqual([])

    edit(unit, 'conf/app.env', 'A=box2\n')
    expect(checkDrift(store, unit, incoming, base).conflicts).toEqual(['conf/app.env'])
  })

  it('a bad or unknown base is ignored', () => {
    deployUnit(unit)
    recordDeploy(store, unit)
    edit(unit, 'conf/app.env', 'A=box\n')
    expect(checkDrift(store, unit, inc({ 'conf/app.env': 'x' }), 'f'.repeat(40)).conflicts).toEqual(['conf/app.env'])
    expect(checkDrift(store, unit, inc({ 'conf/app.env': 'x' }), '$(bad)').conflicts).toEqual(['conf/app.env'])
  })

  it('no deploy recorded yet → no conflict', () => {
    deployUnit(unit)
    snapshotUnit(store, unit)
    edit(unit, 'conf/app.env', 'A=box\n')
    expect(checkDrift(store, unit, inc({ 'conf/app.env': 'A=fleet\n' })).conflicts).toEqual([])
  })

  it('files on the box but not in incoming are ignored; incoming files not on the box too', () => {
    deployUnit(unit)
    recordDeploy(store, unit)
    edit(unit, 'box/config.yaml', 'new tracked file\n')
    edit(unit, 'conf/app.env', 'A=box\n')
    const r = checkDrift(store, unit, inc({ 'docker-compose.yml': 'fleet', 'brand/new.txt': 'n' }))
    expect(r.boxEdits).toEqual(['box/config.yaml', 'conf/app.env'])
    expect(r.conflicts).toEqual([])
  })
})

describe('Store.restore and Store.diff', () => {
  it('restores changed and deleted files from a commit, skips identical ones', () => {
    deployUnit(unit)
    const dep = recordDeploy(store, unit).commit!
    edit(unit, 'conf/app.env', 'A=box\n')
    rmSync(join(unit.dir, 'docker-compose.yml'))
    snapshotUnit(store, unit)
    edit(unit, 'box/config.yaml', 'untouched')

    const done = store.restore(dep, unit, process.getuid!(), process.getgid!())
    expect(done.sort()).toEqual(['conf/app.env', 'docker-compose.yml'])
    expect(readFileSync(join(unit.dir, 'conf/app.env'), 'utf-8')).toBe('A=1\n')
    expect(readFileSync(join(unit.dir, 'docker-compose.yml'), 'utf-8')).toBe('services: {}\n')
    expect(statSync(join(unit.dir, 'docker-compose.yml')).mode & 0o777).toBe(0o600)
    expect(existsSync(join(unit.dir, 'box/config.yaml'))).toBe(true)

    expect(store.restore(dep, unit, process.getuid!(), process.getgid!())).toEqual([])
  })

  it('diff with relative gives paths relative to the slot', () => {
    const web = stackUnit(root, 'web')
    deployUnit(web)
    const a = recordDeploy(store, web).commit!
    edit(web, 'conf/app.env', 'A=2\n')
    const b = snapshotUnit(store, web).commit!

    const rel = store.diff(a, b, ['stacks/web'], 'stacks/web')
    expect(rel).toContain('--- a/conf/app.env')
    expect(rel).toContain('+++ b/conf/app.env')
    expect(rel).toContain('+A=2')
    expect(rel).not.toContain('stacks/web')

    const full = store.diff(a, b, ['stacks/web'])
    expect(full).toContain('+++ b/stacks/web/conf/app.env')
  })
})
