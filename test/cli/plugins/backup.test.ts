import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { register } from '../../../cli/plugins/backup/index'
import { loadConfig } from '../../../cli/lib/config'
import { nullLogger, setupProject } from '../helpers'
import type { DeployContext } from '../../../cli/types'

// ── Stack YAML helpers ────────────────────────────────────────────────────────

function makeStackWithBackup(backupYaml: string): string {
  return `
stack:
  installDir: /home/deploy
  projectName: myproject
host:
  hostname: myhost
plugins:
  backup:
${backupYaml}
`
}

// ── Context builder ──────────────────────────────────────────────────────────

function makeContext(root: string, overrides: Partial<DeployContext> = {}): DeployContext {
  const deployDir = join(root, '.deploy')
  mkdirSync(deployDir, { recursive: true })

  return {
    phase: 'stage',
    projectRoot: root,
    sharedPaths: [],
    deployDir,
    config: loadConfig(root),
    ssh: { host: '', port: 22, user: 'root', keyPath: '' },
    plugins: [],
    log: nullLogger,
    errors: [],
    changes: [],
    phaseStatus: [],
    compose: { services: [], buildArgs: [], upArgs: [], profiles: [] },
    report: { data: {} },
    manifest: { destination: '', entries: {} },
    registeredFiles: { scripts: { dirs: ['plugins', 'crons'], exclude: [] }, hostFiles: [] },
    updateConfig: () => { throw new Error("updateConfig not available in tests") },
    force: false,
    ...overrides,
  }
}

// ── Section 1: register() basics ──────────────────────────────────────────────

describe('backup plugin: register()', () => {
  it('returns a plugin named "backup"', () => {
    const plugin = register(null)
    expect(plugin.name).toBe('backup')
  })

  it('has pre-stage and stage hooks', () => {
    const plugin = register(null)
    expect(plugin.hooks).toBeDefined()
    expect(typeof plugin.hooks!['pre-stage']).toBe('function')
    expect(typeof plugin.hooks!['stage']).toBe('function')
  })

  it('has a report section titled "Backups" with order 25', () => {
    const plugin = register(null)
    expect(plugin.report).toBeDefined()
    expect(plugin.report!.title).toBe('Backups')
    expect(plugin.report!.order).toBe(25)
  })

  it('report template contains backup set placeholders', () => {
    const plugin = register(null)
    expect(plugin.report!.template).toContain('backup.sets')
    expect(plugin.report!.template).toContain('backup.destination')
  })
})

// ── Section 2: pre-stage hook sets manifest entries ───────────────────────────

describe('backup plugin: pre-stage hook', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('sets BACKUP_HEALTH_CHECK in manifest when config has sources', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    sources:
      - data/
      - configs/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['pre-stage']!(ctx, raw)

    expect(ctx.manifest.entries.BACKUP_HEALTH_CHECK).toBe('/home/deploy/plugins/backup/check-health.sh')
  })

  it('does NOT set manifest entries when config is null/empty and warns', async () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: myproject
host:
  hostname: myhost
`
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const warnings: string[] = []
    ctx.log = { ...nullLogger, warn(msg) { warnings.push(msg) } }
    await register(null).hooks!['pre-stage']!(ctx, null)

    expect(ctx.manifest.entries.BACKUP_HEALTH_CHECK).toBeUndefined()
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain('[backup]')
  })

  it('does NOT set manifest when sources array is empty', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    sources: []
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['pre-stage']!(ctx, raw)

    expect(ctx.manifest.entries.BACKUP_HEALTH_CHECK).toBeUndefined()
  })
})

// ── Section 3: config parsing — simple form ───────────────────────────────────

describe('backup plugin: config parsing — simple form', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('sources at top level creates a "default" set', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    retentionDays: 30
    sources:
      - data/
      - logs/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const backup = ctx.report.data.backup as any
    expect(backup.sets).toHaveLength(1)
    expect(backup.sets[0].name).toBe('default')
  })

  it('generated config has correct DESTINATION, RETENTION_DAYS, [default] section, and SOURCE lines', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    retentionDays: 14
    sources:
      - data/
      - configs/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const configPath = join(ctx.deployDir, '.stack-config', 'backup', 'config')
    expect(existsSync(configPath)).toBe(true)
    const content = readFileSync(configPath, 'utf-8')

    expect(content).toContain('DESTINATION=/home/deploy/backups')
    expect(content).toContain('RETENTION_DAYS=14')
    expect(content).toContain('[default]')
    expect(content).toContain('SOURCE=data/')
    expect(content).toContain('SOURCE=configs/')
  })

  it('uses default retentionDays of 30 when not specified', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    sources:
      - data/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const configPath = join(ctx.deployDir, '.stack-config', 'backup', 'config')
    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('RETENTION_DAYS=30')
  })
})

// ── Section 4: config parsing — advanced form with named sets ─────────────────

describe('backup plugin: config parsing — advanced form', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('creates multiple named sets from sets: key', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    retentionDays: 30
    sets:
      databases:
        sources:
          - db/
      media:
        sources:
          - uploads/
          - images/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const backup = ctx.report.data.backup as any
    expect(backup.sets).toHaveLength(2)
    const names = backup.sets.map((s: any) => s.name)
    expect(names).toContain('databases')
    expect(names).toContain('media')
  })

  it('generates [section] headers per set in INI config', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    sets:
      app:
        sources:
          - app/
      db:
        sources:
          - db/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const configPath = join(ctx.deployDir, '.stack-config', 'backup', 'config')
    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('[app]')
    expect(content).toContain('[db]')
  })

  it('per-set retentionDays overrides global', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    retentionDays: 30
    sets:
      short:
        sources:
          - tmp/
        retentionDays: 7
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const configPath = join(ctx.deployDir, '.stack-config', 'backup', 'config')
    const content = readFileSync(configPath, 'utf-8')
    // After [short] section there should be RETENTION_DAYS=7
    const afterShort = content.slice(content.indexOf('[short]'))
    expect(afterShort).toContain('RETENTION_DAYS=7')
  })

  it('retainCount generates RETAIN_COUNT in INI config', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    sets:
      weekly:
        sources:
          - data/
        retainCount: 4
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const configPath = join(ctx.deployDir, '.stack-config', 'backup', 'config')
    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('RETAIN_COUNT=4')
    // Should NOT have RETENTION_DAYS in this section
    const afterWeekly = content.slice(content.indexOf('[weekly]'))
    expect(afterWeekly).not.toContain('RETENTION_DAYS')
  })
})

// ── Section 5: destination resolution ────────────────────────────────────────

describe('backup plugin: destination resolution', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('relative destination gets INSTALL_DIR prefix', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    sources:
      - data/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const backup = ctx.report.data.backup as any
    expect(backup.destination).toBe('/home/deploy/backups')
  })

  it('absolute destination is used as-is', async () => {
    const stack = makeStackWithBackup(`
    destination: /mnt/external/backups
    sources:
      - data/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const backup = ctx.report.data.backup as any
    expect(backup.destination).toBe('/mnt/external/backups')
  })

  it('relative destination without trailing slash works correctly', async () => {
    const stack = makeStackWithBackup(`
    destination: backups
    sources:
      - data/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const backup = ctx.report.data.backup as any
    expect(backup.destination).toBe('/home/deploy/backups')
  })
})

// ── Section 6: scripts are auto-staged ────────────────────────────────────────
// Script deployment is handled by core auto-staging (01b-stage.ts copies deploy/ → .deploy/plugins/backup/).
// Tested in test/cli/deploy/auto-stage.test.ts.

// ── Section 7: stage hook warnings ───────────────────────────────────────────

describe('backup plugin: stage hook warnings', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('warns when no backup cron registered', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    sources:
      - data/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const warnings: string[] = []
    ctx.log = { ...nullLogger, warn(msg) { warnings.push(msg) } }
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    expect(warnings.some(w => w.includes('[backup]') && w.includes('cron'))).toBe(true)
  })

  it('does not warn about missing cron when backup cron is registered', async () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: myproject
host:
  hostname: myhost
plugins:
  backup:
    destination: backups/
    sources:
      - data/
  cron:
    crons:
      backup: "0 3 * * *"
`
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const warnings: string[] = []
    ctx.log = { ...nullLogger, warn(msg) { warnings.push(msg) } }
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const cronWarnings = warnings.filter(w => w.includes('cron') && w.includes('backup'))
    expect(cronWarnings).toHaveLength(0)
  })

  it('does nothing when config is null/empty', async () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: myproject
host:
  hostname: myhost
`
    root = setupProject('', stack)
    const ctx = makeContext(root)
    await register(null).hooks!['stage']!(ctx, null)

    expect(ctx.errors).toHaveLength(0)
    expect(ctx.report.data.backup).toBeUndefined()
    expect(existsSync(join(ctx.deployDir, '.stack-config', 'backup'))).toBe(false)
  })
})

// ── Section 8: report data ────────────────────────────────────────────────────

describe('backup plugin: report data', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('populates report.data.backup with set info', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    retentionDays: 30
    sources:
      - data/
      - logs/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const backup = ctx.report.data.backup as any
    expect(backup).toBeDefined()
    expect(backup.destination).toBe('/home/deploy/backups')
    expect(backup.retentionDays).toBe(30)
    expect(Array.isArray(backup.sets)).toBe(true)
  })

  it('each set has name, sources count, and retention text', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    retentionDays: 14
    sources:
      - data/
      - configs/
      - logs/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const backup = ctx.report.data.backup as any
    const set = backup.sets[0]
    expect(set.name).toBe('default')
    expect(set.sources).toBe(3)
    expect(set.retention).toBe('14 days')
  })

  it('retention text shows copies when retainCount is set', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    sets:
      weekly:
        sources:
          - data/
        retainCount: 4
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const backup = ctx.report.data.backup as any
    const set = backup.sets[0]
    expect(set.name).toBe('weekly')
    expect(set.retention).toBe('4 copies')
  })

  it('populates report for multiple named sets', async () => {
    const stack = makeStackWithBackup(`
    destination: backups/
    sets:
      databases:
        sources:
          - db/
      media:
        sources:
          - uploads/
          - images/
          - videos/
`)
    root = setupProject('', stack)
    const ctx = makeContext(root)
    const raw = loadConfig(root).plugins['backup']
    await register(null).hooks!['stage']!(ctx, raw)

    const backup = ctx.report.data.backup as any
    expect(backup.sets).toHaveLength(2)
    const dbSet = backup.sets.find((s: any) => s.name === 'databases')
    const mediaSet = backup.sets.find((s: any) => s.name === 'media')
    expect(dbSet.sources).toBe(1)
    expect(mediaSet.sources).toBe(3)
  })
})
