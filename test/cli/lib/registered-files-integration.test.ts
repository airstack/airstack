import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir, nullLogger } from '../helpers'
import { preSync } from '../../../cli/deploy/02a-pre-sync'
import type { DeployContext, Config, RemoteExecutor } from '../../../cli/types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(): Config {
  return {
    stackConfig: { stackFile: '/opt/test/stack.yml', envFile: '/opt/test/.env', allowUnsafeGit: false },
    host: { hostname: 'test', timezone: '', appUser: 'test', ip: '127.0.0.1', sshUser: 'root', sshPort: 22, sshKey: '', sudoUser: 'root', sudoUserPassword: '', appUserPassword: '', devUsers: [], brewOwner: '', sshHardenedPort: 2222, sshExpose: 'public', sshTunnelHostname: '' },
    stack: { installDir: '/opt/test', projectName: 'test' } as Config['stack'],
    templates: {},
    plugins: {},
    deploy: {
      sync: { default: 'delete', preserve: [], delete: [] },
      hooks: {},
      report: { template: 'templates/deploy-report.md.hbs', destination: './deploy-report.md', secrets: [] },
      stagingDir: '.deploy',
      deployLogs: '.deploy-logs',
    },
  }
}

function makeMockRemote(): RemoteExecutor {
  return {
    async run() {
      return { stdout: 'ok\n', stderr: '', exitCode: 0 }
    },
    async rsync() {
      return { exitCode: 0 }
    },
  }
}

function makeCtx(overrides?: Partial<DeployContext>): DeployContext {
  const projectRoot = makeTmpDir()
  const deployDir = join(projectRoot, '.deploy')
  mkdirSync(deployDir, { recursive: true })

  return {
    phase: 'init',
    projectRoot,
    sharedPaths: [],
    deployDir,
    config: makeConfig(),
    ssh: { host: '127.0.0.1', port: 22, user: 'root', keyPath: '' },
    plugins: [],
    log: nullLogger,
    remote: makeMockRemote(),
    errors: [],
    changes: [],
    phaseStatus: [],
    compose: { services: [], buildArgs: [], upArgs: [], profiles: [] },
    report: { data: {} },
    manifest: { destination: '', entries: {} },
    registeredFiles: { scripts: { dirs: ['plugins', 'crons'], exclude: [] }, hostFiles: [] },
    updateConfig: () => { throw new Error('updateConfig not available in tests') },
    force: false,
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
  cleanups.length = 0
})

describe('pre-sync: local script permission check', () => {
  it('pushes fatal error when .deploy/ scripts lack +x', async () => {
    const ctx = makeCtx()
    cleanups.push(ctx.projectRoot)

    // Create a script without execute permission in .deploy/plugins/
    mkdirSync(join(ctx.deployDir, 'plugins'), { recursive: true })
    writeFileSync(join(ctx.deployDir, 'plugins', 'run.sh'), '#!/bin/bash\necho hi')
    chmodSync(join(ctx.deployDir, 'plugins', 'run.sh'), 0o644)

    await preSync(ctx)

    const fatal = ctx.errors.find(e => e.fatal && e.phase === 'pre-sync')
    expect(fatal).toBeDefined()
    expect(fatal!.message).toContain('Staged scripts have no execute permission')
    expect(fatal!.message).toContain('plugins/run.sh')
    expect(fatal!.message).toContain('chmod +x')
  })

  it('passes when all scripts have +x', async () => {
    const ctx = makeCtx()
    cleanups.push(ctx.projectRoot)

    // Create a script with execute permission
    mkdirSync(join(ctx.deployDir, 'plugins'), { recursive: true })
    writeFileSync(join(ctx.deployDir, 'plugins', 'run.sh'), '#!/bin/bash\necho hi')
    chmodSync(join(ctx.deployDir, 'plugins', 'run.sh'), 0o755)

    await preSync(ctx)

    const fatal = ctx.errors.find(e => e.fatal)
    expect(fatal).toBeUndefined()
    expect(ctx.phaseStatus).toHaveLength(1)
    expect(ctx.phaseStatus[0].success).toBe(true)
  })

  it('respects exclude list', async () => {
    const ctx = makeCtx()
    cleanups.push(ctx.projectRoot)

    // Create a script without +x in an excluded path
    mkdirSync(join(ctx.deployDir, 'plugins', 'cron', 'lib'), { recursive: true })
    writeFileSync(join(ctx.deployDir, 'plugins', 'cron', 'lib', 'stacks.sh'), '#!/bin/bash\n')
    chmodSync(join(ctx.deployDir, 'plugins', 'cron', 'lib', 'stacks.sh'), 0o644)

    ctx.registeredFiles.scripts.exclude = ['plugins/cron/lib/stacks.sh']

    await preSync(ctx)

    const fatal = ctx.errors.find(e => e.fatal && e.message.includes('no execute permission'))
    expect(fatal).toBeUndefined()
    expect(ctx.phaseStatus).toHaveLength(1)
    expect(ctx.phaseStatus[0].success).toBe(true)
  })

  it('passes when no script dirs exist in .deploy/', async () => {
    const ctx = makeCtx()
    cleanups.push(ctx.projectRoot)
    // Don't create plugins/ or crons/ dirs — they just don't exist yet

    await preSync(ctx)

    expect(ctx.errors.filter(e => e.fatal)).toHaveLength(0)
    expect(ctx.phaseStatus).toHaveLength(1)
    expect(ctx.phaseStatus[0].success).toBe(true)
  })
})
