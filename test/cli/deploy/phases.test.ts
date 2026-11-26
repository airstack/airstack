import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runDeploy } from '../../../cli/deploy/runner'
import { createMockExecutor } from '../../../cli/lib/ssh'
import { nullLogger, makeTmpDir } from '../helpers'
import type { DeployContext, DeployPhase, Plugin, Config } from '../../../cli/types'

// ── Context builder ──────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    stackConfig: { stackFile: '/test/stack.yml', envFile: '/test/.env', allowUnsafeGit: false },
    host: { hostname: 'test', timezone: '', appUser: 'test', ip: '127.0.0.1', sshUser: 'root', sshPort: 22, sshKey: '', sudoUser: 'root', sudoUserPassword: '', appUserPassword: '', devUsers: [], brewOwner: '', sshHardenedPort: 2222, sshExpose: 'public', sshTunnelHostname: '' },
    stack: { installDir: '/test', projectName: 'test' } as Config['stack'],
    templates: {},
    plugins: {},
    deploy: {
      sync: { default: 'delete', preserve: [], delete: [] },
      hooks: {},
      report: { template: 'templates/deploy-report.md.hbs', destination: './deploy-report.md', secrets: [] },
      stagingDir: '.deploy',
      deployLogs: '.deploy-logs',
    },
    ...overrides,
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

// ── Runner tests ─────────────────────────────────────────────────────────────

describe('deploy runner: stopAfter', () => {
  it('stops after the named phase', async () => {
    const remote = createMockExecutor({
      'echo ok': { stdout: 'ok', exitCode: 0 },
    })

    // pre-stage is a no-op, stage processes templates but we can skip by using stopAfter='pre-stage'
    const ctx = makeCtx({ remote, stopAfter: 'pre-stage' })
    await runDeploy(ctx)

    // Runner leaves phase as the last executed phase (deploy.ts decides 'done')
    expect(ctx.phase).toBe('pre-stage')
    // Should not have reached sync
    const phases = ctx.phaseStatus.map(s => s.phase)
    expect(phases).toContain('pre-stage')
    expect(phases).not.toContain('sync')
  })

  it('runs exactly the phases up to and including stopAfter', async () => {
    // pre-stage is hooks-only so it always succeeds
    const ctx = makeCtx({ stopAfter: 'pre-stage' })
    await runDeploy(ctx)

    expect(ctx.phaseStatus).toHaveLength(1)
    expect(ctx.phaseStatus[0].phase).toBe('pre-stage')
  })
})

describe('deploy runner: fatal error abort', () => {
  it('stops pipeline on fatal error from a phase', async () => {
    // pre-sync pushes a fatal error when no remote is configured
    const ctx = makeCtx()
    // Don't set remote — phases after pre-stage/stage that need remote will fail
    // But stage itself needs templates. Let's inject a fatal error via plugin hook.
    const fatalPlugin: Plugin = {
      name: 'fatal-test',
      hooks: {
        'pre-stage': async (c) => {
          c.errors.push({ phase: 'pre-stage', message: 'boom', fatal: true })
        },
      },
    }
    ctx.plugins = [fatalPlugin]
    ctx.config.plugins = { 'fatal-test': {} }

    await runDeploy(ctx)

    // Should have stopped — phase should still be 'pre-stage'
    expect(ctx.phase).toBe('pre-stage')
    // Should NOT reach stage
    const phases = ctx.phaseStatus.map(s => s.phase)
    expect(phases).toContain('pre-stage')
    expect(phases).not.toContain('stage')
  })

  it('phase is not "done" when a fatal error occurs', async () => {
    const fatalPlugin: Plugin = {
      name: 'fatal-test',
      hooks: {
        'pre-stage': async (c) => {
          c.errors.push({ phase: 'pre-stage', message: 'abort', fatal: true })
        },
      },
    }
    const ctx = makeCtx({ plugins: [fatalPlugin] })
    ctx.config.plugins = { 'fatal-test': {} }

    await runDeploy(ctx)

    expect(ctx.phase).not.toBe('done')
  })
})

describe('deploy runner: plugin hooks', () => {
  it('calls plugin hooks in registration order', async () => {
    const order: string[] = []
    const pluginA: Plugin = {
      name: 'a',
      hooks: {
        'pre-stage': async () => { order.push('a') },
      },
    }
    const pluginB: Plugin = {
      name: 'b',
      hooks: {
        'pre-stage': async () => { order.push('b') },
      },
    }
    const ctx = makeCtx({
      plugins: [pluginA, pluginB],
      stopAfter: 'pre-stage',
    })
    ctx.config.plugins = { a: {}, b: {} }

    await runDeploy(ctx)

    expect(order).toEqual(['a', 'b'])
  })

  it('plugin hook error is non-fatal and accumulated', async () => {
    const badPlugin: Plugin = {
      name: 'bad',
      hooks: {
        'pre-stage': async () => { throw new Error('plugin exploded') },
      },
    }
    const ctx = makeCtx({
      plugins: [badPlugin],
      stopAfter: 'pre-stage',
    })
    ctx.config.plugins = { bad: {} }

    await runDeploy(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0].message).toContain('plugin exploded')
    expect(ctx.errors[0].fatal).toBe(false)
  })

  it('receives plugin config from ctx.config.plugins', async () => {
    let receivedConfig: unknown
    const plugin: Plugin = {
      name: 'cfg-test',
      hooks: {
        'pre-stage': async (_ctx, config) => { receivedConfig = config },
      },
    }
    const ctx = makeCtx({
      plugins: [plugin],
      stopAfter: 'pre-stage',
    })
    ctx.config.plugins = { 'cfg-test': { key: 'value' } }

    await runDeploy(ctx)

    expect(receivedConfig).toEqual({ key: 'value' })
  })
})

describe('deploy runner: deploy hooks from config', () => {
  it('runs deploy hook after plugin hooks', async () => {
    const order: string[] = []
    const plugin: Plugin = {
      name: 'ordered',
      hooks: {
        'pre-stage': async () => { order.push('plugin') },
      },
    }

    // Create a hook module that the runner can import
    const projectRoot = makeTmpDir()
    const deployDir = join(projectRoot, '.deploy')
    mkdirSync(deployDir, { recursive: true })

    const hookDir = join(projectRoot, 'hooks')
    mkdirSync(hookDir, { recursive: true })
    writeFileSync(
      join(hookDir, 'pre-stage-hook.ts'),
      `export async function runHook(ctx) { ctx.report.data._hookOrder = 'hook-ran' }`,
    )

    const ctx = makeCtx({
      projectRoot,
      deployDir,
      plugins: [plugin],
      stopAfter: 'pre-stage',
    })
    ctx.config.plugins = { ordered: {} }
    ctx.config.deploy.hooks = { 'pre-stage': 'hooks/pre-stage-hook.ts' }

    await runDeploy(ctx)

    expect(order).toEqual(['plugin'])
    // The hook should also have run
    expect(ctx.report.data._hookOrder).toBe('hook-ran')
  })

  it('skips gracefully when hook path not found', async () => {
    const ctx = makeCtx({ stopAfter: 'pre-stage' })
    ctx.config.deploy.hooks = { 'pre-stage': 'nonexistent/hook.ts' }

    await runDeploy(ctx)

    // Should complete without fatal error — missing hook is logged but not fatal
    expect(ctx.errors.filter(e => e.fatal)).toHaveLength(0)
  })
})

// ── Individual phase tests ───────────────────────────────────────────────────

describe('phase: pre-sync (VPS reachability)', () => {
  it('pushes fatal error when remote is not configured', async () => {
    const { preSync } = await import('../../../cli/deploy/02a-pre-sync')
    const ctx = makeCtx()
    // no remote set
    await preSync(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0].fatal).toBe(true)
    expect(ctx.errors[0].message).toContain('No remote executor configured')
  })

  it('pushes fatal error when VPS is unreachable', async () => {
    const { preSync } = await import('../../../cli/deploy/02a-pre-sync')
    const remote = createMockExecutor({
      'echo ok': { exitCode: 1, stderr: 'connection refused' },
    })
    const ctx = makeCtx({ remote })
    await preSync(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0].fatal).toBe(true)
    expect(ctx.errors[0].message).toContain('VPS unreachable')
    expect(ctx.errors[0].message).toContain('connection refused')
  })

  it('succeeds when VPS responds with exit 0', async () => {
    const { preSync } = await import('../../../cli/deploy/02a-pre-sync')
    const remote = createMockExecutor({
      'echo ok': { stdout: 'ok', exitCode: 0 },
    })
    const ctx = makeCtx({ remote })
    await preSync(ctx)

    expect(ctx.errors).toHaveLength(0)
    expect(ctx.phaseStatus).toHaveLength(1)
    expect(ctx.phaseStatus[0].success).toBe(true)
    expect(ctx.phaseStatus[0].message).toBe('VPS reachable')
  })
})

describe('phase: sync', () => {
  it('rsyncs .deploy/ entries to VPS (mock remote)', async () => {
    const { sync } = await import('../../../cli/deploy/02b-sync')
    const remote = createMockExecutor()
    const ctx = makeCtx({ remote })

    // Create some entries in deployDir
    mkdirSync(join(ctx.deployDir, 'scripts'), { recursive: true })
    writeFileSync(join(ctx.deployDir, 'scripts', 'run.sh'), '#!/bin/bash')
    writeFileSync(join(ctx.deployDir, 'docker-compose.yml'), 'version: "3"')

    await sync(ctx)

    expect(ctx.errors).toHaveLength(0)
    // Should have made rsync calls for each entry
    const rsyncCalls = remote.calls.filter(c => c.type === 'rsync')
    expect(rsyncCalls.length).toBeGreaterThanOrEqual(2) // scripts dir + docker-compose.yml file

    // Should create install dir
    const mkdirCall = remote.calls.find(c => c.type === 'run' && c.args[0].includes('mkdir -p'))
    expect(mkdirCall).toBeDefined()
  })

  it('respects deploy.sync.preserve config (no --delete for preserved dirs)', async () => {
    const { sync } = await import('../../../cli/deploy/02b-sync')
    const remote = createMockExecutor()
    const ctx = makeCtx({ remote })
    ctx.config.deploy.sync = { default: 'delete', preserve: ['data'], delete: [] }

    mkdirSync(join(ctx.deployDir, 'data'), { recursive: true })
    writeFileSync(join(ctx.deployDir, 'data', 'file.txt'), 'keep')
    mkdirSync(join(ctx.deployDir, 'config'), { recursive: true })
    writeFileSync(join(ctx.deployDir, 'config', 'app.conf'), 'x=1')

    await sync(ctx)

    const rsyncCalls = remote.calls.filter(c => c.type === 'rsync')

    // data dir should NOT have --delete
    const dataSync = rsyncCalls.find(c => c.args[0].includes('data'))
    expect(dataSync).toBeDefined()
    expect(dataSync!.args).not.toContain('--delete')

    // config dir SHOULD have --delete (default is delete)
    const configSync = rsyncCalls.find(c => c.args[0].includes('config'))
    expect(configSync).toBeDefined()
    expect(configSync!.args).toContain('--delete')
  })

  it('respects deploy.sync.delete config (explicit --delete for listed dirs)', async () => {
    const { sync } = await import('../../../cli/deploy/02b-sync')
    const remote = createMockExecutor()
    const ctx = makeCtx({ remote })
    ctx.config.deploy.sync = { default: 'preserve', preserve: [], delete: ['cache'] }

    mkdirSync(join(ctx.deployDir, 'cache'), { recursive: true })
    writeFileSync(join(ctx.deployDir, 'cache', 'temp.dat'), 'data')
    mkdirSync(join(ctx.deployDir, 'logs'), { recursive: true })
    writeFileSync(join(ctx.deployDir, 'logs', 'app.log'), 'log')

    await sync(ctx)

    const rsyncCalls = remote.calls.filter(c => c.type === 'rsync')

    // cache dir SHOULD have --delete (explicitly listed)
    const cacheSync = rsyncCalls.find(c => c.args[0].includes('cache'))
    expect(cacheSync).toBeDefined()
    expect(cacheSync!.args).toContain('--delete')

    // logs dir should NOT have --delete (default is preserve)
    const logsSync = rsyncCalls.find(c => c.args[0].includes('logs'))
    expect(logsSync).toBeDefined()
    expect(logsSync!.args).not.toContain('--delete')
  })

  it('pushes fatal error when remote not configured', async () => {
    const { sync } = await import('../../../cli/deploy/02b-sync')
    const ctx = makeCtx()
    await sync(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0].fatal).toBe(true)
  })
})

describe('phase: post-sync', () => {
  it('sets timezone when configured and different from current', async () => {
    const { postSync } = await import('../../../cli/deploy/02c-post-sync')
    const remote = createMockExecutor({
      [expect.stringContaining('timedatectl') as unknown as string]: { stdout: 'UTC', exitCode: 0 },
    })
    // The mock executor matches command strings exactly. We need to
    // provide a response for the timedatectl command and the verify command.
    const responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }> = {}
    const mockRemote = createMockExecutor(responses)

    const ctx = makeCtx({ remote: mockRemote })
    ctx.config.host.timezone = 'America/New_York'

    // The timedatectl show command
    // We need to override the mock to return specific values for specific commands
    const calls: { type: string; args: string[] }[] = []
    let callIdx = 0
    const timedateResponses = [
      { stdout: 'UTC', stderr: '', exitCode: 0 },        // timedatectl show
      { stdout: '', stderr: '', exitCode: 0 },             // timedatectl set-timezone
      { stdout: 'ok', stderr: '', exitCode: 0 },           // verify docker-compose.yml
    ]
    ctx.remote = {
      async run(command: string) {
        calls.push({ type: 'run', args: [command] })
        const resp = timedateResponses[callIdx++] || { stdout: '', stderr: '', exitCode: 0 }
        return resp
      },
      async rsync(src: string, dest: string, opts: string[] = []) {
        calls.push({ type: 'rsync', args: [src, dest, ...opts] })
        return { exitCode: 0 }
      },
    }

    await postSync(ctx)

    // Should have called timedatectl set-timezone
    const setTzCall = calls.find(c => c.args[0].includes('timedatectl set-timezone'))
    expect(setTzCall).toBeDefined()
    expect(setTzCall!.args[0]).toContain('America/New_York')
  })

  it('skips timezone set when already matching', async () => {
    const { postSync } = await import('../../../cli/deploy/02c-post-sync')

    const calls: { type: string; args: string[] }[] = []
    let callIdx = 0
    const ctx = makeCtx({
      remote: {
        async run(command: string) {
          calls.push({ type: 'run', args: [command] })
          // /etc/ dir checks → no dirs found
          if (command.includes('test -d')) return { stdout: 'no', stderr: '', exitCode: 0 }
          // timedatectl → already matching
          if (command.includes('timedatectl show')) return { stdout: 'America/New_York', stderr: '', exitCode: 0 }
          // verify → ok
          if (command.includes('test -f')) return { stdout: 'ok', stderr: '', exitCode: 0 }
          return { stdout: '', stderr: '', exitCode: 0 }
        },
        async rsync() { return { exitCode: 0 } },
      },
    })
    ctx.config.host.timezone = 'America/New_York'

    await postSync(ctx)

    const setTzCall = calls.find(c => c.args[0].includes('timedatectl set-timezone'))
    expect(setTzCall).toBeUndefined()
    expect(ctx.errors).toHaveLength(0)
  })

  it('pushes fatal error when docker-compose.yml missing after sync', async () => {
    const { postSync } = await import('../../../cli/deploy/02c-post-sync')

    let callIdx = 0
    const responses = [
      { stdout: '', stderr: '', exitCode: 0 },  // no timezone to set (empty)
      { stdout: '', stderr: '', exitCode: 1 },   // verify fails — no "ok"
    ]
    const ctx = makeCtx({
      remote: {
        async run() {
          return responses[callIdx++] || { stdout: '', stderr: '', exitCode: 0 }
        },
        async rsync() { return { exitCode: 0 } },
      },
    })
    ctx.config.host.timezone = ''

    await postSync(ctx)

    expect(ctx.errors.some(e => e.fatal && e.message.includes('docker-compose.yml missing'))).toBe(true)
  })

  it('pushes fatal error when remote not configured', async () => {
    const { postSync } = await import('../../../cli/deploy/02c-post-sync')
    const ctx = makeCtx()
    await postSync(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0].fatal).toBe(true)
  })
})

describe('phase: start', () => {
  it('calls docker compose up -d via remote (mock)', async () => {
    const { start } = await import('../../../cli/deploy/03c-start')
    const remote = createMockExecutor()
    const ctx = makeCtx({ remote })

    await start(ctx)

    expect(ctx.errors).toHaveLength(0)
    const upCall = remote.calls.find(c => c.type === 'run' && c.args[0].includes('docker compose'))
    expect(upCall).toBeDefined()
    expect(upCall!.args[0]).toContain('up -d')
  })

  it('starts specific services when compose.services has actions', async () => {
    const { start } = await import('../../../cli/deploy/03c-start')
    const remote = createMockExecutor()
    const ctx = makeCtx({ remote })
    ctx.compose.services = [
      { service: 'web', action: 'recreate', reason: 'config changed' },
      { service: 'db', action: 'none', reason: 'unchanged' },
    ]

    await start(ctx)

    const upCall = remote.calls.find(c => c.type === 'run' && c.args[0].includes('docker compose'))
    expect(upCall).toBeDefined()
    expect(upCall!.args[0]).toContain('web')
    expect(upCall!.args[0]).not.toContain(' db')
    expect(upCall!.args[0]).toContain('--force-recreate')
  })

  it('includes profiles in compose command', async () => {
    const { start } = await import('../../../cli/deploy/03c-start')
    const remote = createMockExecutor()
    const ctx = makeCtx({ remote })
    ctx.compose.profiles = ['sandbox', 'monitoring']

    await start(ctx)

    const upCall = remote.calls.find(c => c.type === 'run' && c.args[0].includes('docker compose'))
    // The compose command sits inside bash -c '…', so inner quotes arrive escaped as '\''
    const unescaped = upCall!.args[0].replaceAll(`'\\''`, `'`)
    expect(unescaped).toContain("--profile 'sandbox'")
    expect(unescaped).toContain("--profile 'monitoring'")
  })

  it('pushes fatal error on non-zero exit', async () => {
    const { start } = await import('../../../cli/deploy/03c-start')
    const ctx = makeCtx({
      remote: {
        async run() { return { stdout: '', stderr: 'compose error', exitCode: 1 } },
        async rsync() { return { exitCode: 0 } },
      },
    })

    await start(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0].fatal).toBe(true)
    expect(ctx.errors[0].message).toContain('docker compose up failed')
  })

  it('pushes fatal error when remote not configured', async () => {
    const { start } = await import('../../../cli/deploy/03c-start')
    const ctx = makeCtx()
    await start(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0].fatal).toBe(true)
  })
})

describe('phase: pre-start', () => {
  it('adds --force-recreate when ctx.force is true and no services listed', async () => {
    const { preStart } = await import('../../../cli/deploy/03a-pre-start')
    const ctx = makeCtx({ force: true })

    await preStart(ctx)

    expect(ctx.compose.upArgs).toContain('--force-recreate')
  })

  it('always adds --force-recreate when force is true, even with services listed', async () => {
    const { preStart } = await import('../../../cli/deploy/03a-pre-start')
    const ctx = makeCtx({ force: true })
    ctx.compose.services = [{ service: 'web', action: 'recreate', reason: 'test' }]

    await preStart(ctx)

    expect(ctx.compose.upArgs).toContain('--force-recreate')
  })

  it('reports service action count in phaseStatus', async () => {
    const { preStart } = await import('../../../cli/deploy/03a-pre-start')
    const ctx = makeCtx()
    ctx.compose.services = [
      { service: 'web', action: 'recreate', reason: 'test' },
      { service: 'db', action: 'none', reason: 'unchanged' },
    ]

    await preStart(ctx)

    expect(ctx.phaseStatus[0].message).toContain('1 service(s) need action')
  })
})

describe('phase: dry-run', () => {
  it('pushes fatal error when remote not configured', async () => {
    const { dryRun } = await import('../../../cli/deploy/03b-dry-run')
    const ctx = makeCtx()
    await dryRun(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0].fatal).toBe(true)
  })

  it('validates compose config via remote run', async () => {
    const { dryRun } = await import('../../../cli/deploy/03b-dry-run')
    const remote = createMockExecutor()
    const ctx = makeCtx({ remote })

    await dryRun(ctx)

    const configCall = remote.calls.find(c => c.type === 'run' && c.args[0].includes('compose') && c.args[0].includes('config'))
    expect(configCall).toBeDefined()
    expect(ctx.errors).toHaveLength(0)
  })

  it('builds services marked for build before validating', async () => {
    const { dryRun } = await import('../../../cli/deploy/03b-dry-run')
    const remote = createMockExecutor()
    const ctx = makeCtx({ remote })
    ctx.compose.services = [
      { service: 'custom-app', action: 'build', reason: 'image changed' },
    ]

    await dryRun(ctx)

    const buildCall = remote.calls.find(c => c.type === 'run' && c.args[0].includes('build') && c.args[0].includes('custom-app'))
    expect(buildCall).toBeDefined()
  })

  it('pushes fatal error when docker compose config fails', async () => {
    const { dryRun } = await import('../../../cli/deploy/03b-dry-run')
    let callIdx = 0
    const ctx = makeCtx({
      remote: {
        async run() {
          return { stdout: 'invalid yaml', stderr: '', exitCode: callIdx++ === 0 ? 1 : 0 }
        },
        async rsync() { return { exitCode: 0 } },
      },
    })

    await dryRun(ctx)

    expect(ctx.errors.some(e => e.fatal && e.message.includes('config validation failed'))).toBe(true)
  })
})

describe('phases: skip gracefully when no remote', () => {
  const phasesToTest: Array<{ name: string; importFn: () => Promise<{ [k: string]: (ctx: DeployContext) => Promise<void> }>; fnName: string }> = [
    { name: 'pre-sync', importFn: () => import('../../../cli/deploy/02a-pre-sync'), fnName: 'preSync' },
    { name: 'sync', importFn: () => import('../../../cli/deploy/02b-sync'), fnName: 'sync' },
    { name: 'post-sync', importFn: () => import('../../../cli/deploy/02c-post-sync'), fnName: 'postSync' },
    { name: 'dry-run', importFn: () => import('../../../cli/deploy/03b-dry-run'), fnName: 'dryRun' },
    { name: 'start', importFn: () => import('../../../cli/deploy/03c-start'), fnName: 'start' },
  ]

  for (const { name, importFn, fnName } of phasesToTest) {
    it(`${name} phase pushes fatal error when no remote`, async () => {
      const mod = await importFn()
      const fn = mod[fnName] as (ctx: DeployContext) => Promise<void>
      const ctx = makeCtx()

      await fn(ctx)

      expect(ctx.errors).toHaveLength(1)
      expect(ctx.errors[0].fatal).toBe(true)
      expect(ctx.errors[0].phase).toBe(name)
    })
  }
})

describe('phases: hooks-only phases push status', () => {
  it('pre-stage pushes "Ready" status', async () => {
    const { preStage } = await import('../../../cli/deploy/01a-pre-stage')
    const ctx = makeCtx()
    await preStage(ctx)

    expect(ctx.phaseStatus).toHaveLength(1)
    expect(ctx.phaseStatus[0]).toMatchObject({ phase: 'pre-stage', success: true, message: 'Ready' })
  })

  it('build pushes "Ready" status', async () => {
    const { build } = await import('../../../cli/deploy/02d-build')
    const ctx = makeCtx()
    await build(ctx)

    expect(ctx.phaseStatus).toHaveLength(1)
    expect(ctx.phaseStatus[0]).toMatchObject({ phase: 'build', success: true, message: 'Ready' })
  })

  it('healthcheck pushes "Healthcheck complete" status', async () => {
    const { healthcheck } = await import('../../../cli/deploy/04-healthcheck')
    const ctx = makeCtx()
    await healthcheck(ctx)

    expect(ctx.phaseStatus).toHaveLength(1)
    expect(ctx.phaseStatus[0]).toMatchObject({ phase: 'healthcheck', success: true })
  })

  it('post-deploy pushes "Post-deploy complete" status', async () => {
    const { postDeploy } = await import('../../../cli/deploy/05-post-deploy')
    const ctx = makeCtx()
    await postDeploy(ctx)

    expect(ctx.phaseStatus).toHaveLength(1)
    expect(ctx.phaseStatus[0]).toMatchObject({ phase: 'post-deploy', success: true })
  })

  it('validate pushes status with warning count', async () => {
    const { validate } = await import('../../../cli/deploy/06-validate')
    const ctx = makeCtx()
    ctx.errors.push({ phase: 'validate', message: 'non-fatal warning', fatal: false })

    await validate(ctx)

    expect(ctx.phaseStatus[0].warnings).toBe(1)
    expect(ctx.phaseStatus[0].message).toContain('1 warning(s)')
    expect(ctx.phaseStatus[0].success).toBe(true)
  })

  it('validate marks success=false on fatal validate error', async () => {
    const { validate } = await import('../../../cli/deploy/06-validate')
    const ctx = makeCtx()
    ctx.errors.push({ phase: 'validate', message: 'fatal issue', fatal: true })

    await validate(ctx)

    expect(ctx.phaseStatus[0].success).toBe(false)
  })
})

describe('deploy runner: full pipeline end-to-end', () => {
  it('leaves phase as last executed phase (deploy.ts decides done)', async () => {
    const ctx = makeCtx({ stopAfter: 'pre-stage' })
    await runDeploy(ctx)

    // Runner leaves phase as last executed — deploy.ts sets 'done'
    expect(ctx.phase).toBe('pre-stage')
  })
})
