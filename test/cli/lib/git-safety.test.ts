import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { makeTmpDir } from '../helpers'
import {
  isTrackedByGit,
  isIgnoredByGit,
  assertSafeForSecrets,
} from '../../../cli/lib/git-safety'

// ── helpers ──────────────────────────────────────────────────────────
// Test setup uses execSync (not execFileSync) for convenience —
// all inputs are hardcoded literals controlled by the test, so there
// is no shell-injection risk here.
function gitInit(dir: string) {
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
}

// ── isTrackedByGit ──────────────────────────────────────────────────
describe('isTrackedByGit', () => {
  const cleanups: string[] = []

  afterEach(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
    cleanups.length = 0
  })

  it('returns true for a tracked file', () => {
    const dir = makeTmpDir('git-safety')
    cleanups.push(dir)
    gitInit(dir)
    const file = join(dir, 'tracked.txt')
    writeFileSync(file, 'hello')
    execSync('git add tracked.txt', { cwd: dir, stdio: 'pipe' })
    execSync('git commit --no-gpg-sign -m "init"', { cwd: dir, stdio: 'pipe' })

    expect(isTrackedByGit(file)).toBe(true)
  })

  it('returns false for an untracked file', () => {
    const dir = makeTmpDir('git-safety')
    cleanups.push(dir)
    gitInit(dir)
    const file = join(dir, 'untracked.txt')
    writeFileSync(file, 'hello')

    expect(isTrackedByGit(file)).toBe(false)
  })

  it('returns false for a nonexistent file', () => {
    const dir = makeTmpDir('git-safety')
    cleanups.push(dir)
    gitInit(dir)

    expect(isTrackedByGit(join(dir, 'nope.txt'))).toBe(false)
  })

  it('returns false outside a git repo', () => {
    const dir = makeTmpDir('git-safety-nogit')
    cleanups.push(dir)
    const file = join(dir, 'orphan.txt')
    writeFileSync(file, 'hello')

    expect(isTrackedByGit(file)).toBe(false)
  })
})

// ── isIgnoredByGit ──────────────────────────────────────────────────
describe('isIgnoredByGit', () => {
  const cleanups: string[] = []

  afterEach(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
    cleanups.length = 0
  })

  it('returns true for a gitignored path', () => {
    const dir = makeTmpDir('git-safety')
    cleanups.push(dir)
    gitInit(dir)
    writeFileSync(join(dir, '.gitignore'), 'secret.env\n')
    execSync('git add .gitignore', { cwd: dir, stdio: 'pipe' })

    const file = join(dir, 'secret.env')
    writeFileSync(file, 'KEY=val')

    expect(isIgnoredByGit(file)).toBe(true)
  })

  it('returns false for a non-ignored path', () => {
    const dir = makeTmpDir('git-safety')
    cleanups.push(dir)
    gitInit(dir)
    writeFileSync(join(dir, '.gitignore'), 'secret.env\n')
    execSync('git add .gitignore', { cwd: dir, stdio: 'pipe' })

    const file = join(dir, 'readme.txt')
    writeFileSync(file, 'hi')

    expect(isIgnoredByGit(file)).toBe(false)
  })

  it('returns true for a path matching a wildcard pattern', () => {
    const dir = makeTmpDir('git-safety')
    cleanups.push(dir)
    gitInit(dir)
    writeFileSync(join(dir, '.gitignore'), '.deploy*\n')
    execSync('git add .gitignore', { cwd: dir, stdio: 'pipe' })

    const file = join(dir, '.deploy-logs')
    writeFileSync(file, 'log data')

    expect(isIgnoredByGit(file)).toBe(true)
  })

  it('returns false outside a git repo', () => {
    const dir = makeTmpDir('git-safety-nogit')
    cleanups.push(dir)
    const file = join(dir, 'orphan.txt')
    writeFileSync(file, 'hello')

    expect(isIgnoredByGit(file)).toBe(false)
  })
})

// ── assertSafeForSecrets ────────────────────────────────────────────
describe('assertSafeForSecrets', () => {
  const cleanups: string[] = []

  afterEach(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
    cleanups.length = 0
  })

  it('throws if file is tracked by git', () => {
    const dir = makeTmpDir('git-safety')
    cleanups.push(dir)
    gitInit(dir)
    const file = join(dir, '.env')
    writeFileSync(file, 'SECRET=x')
    execSync('git add .env', { cwd: dir, stdio: 'pipe' })
    execSync('git commit --no-gpg-sign -m "init"', { cwd: dir, stdio: 'pipe' })

    expect(() => assertSafeForSecrets(file, '.env')).toThrowError(/tracked by git/)
  })

  it('throws if file is not gitignored', () => {
    const dir = makeTmpDir('git-safety')
    cleanups.push(dir)
    gitInit(dir)
    // create an initial commit so HEAD exists
    writeFileSync(join(dir, 'dummy.txt'), 'x')
    execSync('git add dummy.txt', { cwd: dir, stdio: 'pipe' })
    execSync('git commit --no-gpg-sign -m "init"', { cwd: dir, stdio: 'pipe' })

    const file = join(dir, '.env')
    writeFileSync(file, 'SECRET=x')

    expect(() => assertSafeForSecrets(file, '.env')).toThrowError(/not gitignored/)
  })

  it('does not throw if file is gitignored and not tracked', () => {
    const dir = makeTmpDir('git-safety')
    cleanups.push(dir)
    gitInit(dir)
    writeFileSync(join(dir, '.gitignore'), '.env\n')
    execSync('git add .gitignore', { cwd: dir, stdio: 'pipe' })
    execSync('git commit --no-gpg-sign -m "init"', { cwd: dir, stdio: 'pipe' })

    const file = join(dir, '.env')
    writeFileSync(file, 'SECRET=x')

    expect(() => assertSafeForSecrets(file, '.env')).not.toThrow()
  })

  it('does not throw outside a git repo', () => {
    const dir = makeTmpDir('git-safety-nogit')
    cleanups.push(dir)
    const file = join(dir, '.env')
    writeFileSync(file, 'SECRET=x')

    expect(() => assertSafeForSecrets(file, '.env')).not.toThrow()
  })

  it('does not throw when allowUnsafeGit is true', () => {
    const dir = makeTmpDir('git-safety')
    cleanups.push(dir)
    gitInit(dir)
    const file = join(dir, '.env')
    writeFileSync(file, 'SECRET=x')
    execSync('git add .env', { cwd: dir, stdio: 'pipe' })
    execSync('git commit --no-gpg-sign -m "init"', { cwd: dir, stdio: 'pipe' })

    expect(() => assertSafeForSecrets(file, '.env', true)).not.toThrow()
  })
})
