import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { historyPlugin, readStackBase, STACK_BASE_FILE, type HistoryOptions } from '../../../cli/lib/history-hooks'
import { MANAGED_FILE, parseManaged } from '../../../cli/lib/managed'
import { blobId } from '../../../cli/node/history'
import type { DeployContext, DeployLogger, Plugin, RemoteExecutor } from '../../../cli/types'
import { fakeRemote, makeRoot, writeFiles } from '../node/helpers'

const DRIFT = 'sudo /usr/local/bin/airstack machine drift'
const BASE = 'a'.repeat(40)

let root: string
let cleanup: () => void
let deployDir: string
let machineDir: string
beforeEach(() => {
  ({ root, cleanup } = makeRoot('airstack-hist-hooks-'))
  deployDir = join(root, 'deploy', 'unit')
  machineDir = join(root, 'deploy')
  writeFiles(deployDir, { 'docker-compose.yml': 'services: {}\n', 'conf/app.env': 'A=1\n' })
})
afterEach(() => cleanup())

function makeCtx(plugins: Plugin[], remote?: RemoteExecutor) {
  const infos: string[] = []
  const log: DeployLogger = { error() {}, warn() {}, info: (m) => infos.push(m), debug() {} }
  const ctx = { phase: 'stage', deployDir, plugins, errors: [], log, remote } as unknown as DeployContext
  return { ctx, infos }
}

function plugin(o: Partial<HistoryOptions> = {}) {
  return historyPlugin({ nodeUnit: 'web', machineDeployDir: machineDir, fleetCommit: 'abc1234', force: false, ...o })
}

async function runPhases(p: Plugin, ctx: DeployContext, phases: ('stage' | 'pre-sync' | 'post-sync')[]) {
  for (const ph of phases) {
    ctx.phase = ph
    await p.hooks![ph]!(ctx, undefined)
  }
}

describe('historyPlugin stage', () => {
  it('writes managed.json with rendered, tracked and redact from ctx.plugins', async () => {
    const others: Plugin[] = [
      { name: 'a', tracked: ['.cli/config.yaml'], redact: [{ files: ['.cli/config.yaml'], keys: ['api-keys'] }] },
      { name: 'b' },
      { name: 'c', tracked: ['z.yaml', '.cli/config.yaml'] },
    ]
    const p = plugin()
    const { ctx } = makeCtx([...others])
    await runPhases(p, ctx, ['stage'])
    const m = parseManaged(readFileSync(join(deployDir, MANAGED_FILE), 'utf-8'))!
    expect(m).toMatchObject({
      unit: 'web', kind: 'stack', fleetCommit: 'abc1234',
      rendered: ['conf/app.env', 'docker-compose.yml'],
      tracked: ['.cli/config.yaml', 'z.yaml'],
      redact: [{ files: ['.cli/config.yaml'], keys: ['api-keys'] }],
    })
    expect(Number.isNaN(Date.parse(m.deployedAt))).toBe(false)
  })

  it('kind is machine for the machine unit', async () => {
    const { ctx } = makeCtx([])
    await runPhases(plugin({ nodeUnit: 'machine' }), ctx, ['stage'])
    expect(parseManaged(readFileSync(join(deployDir, MANAGED_FILE), 'utf-8'))?.kind).toBe('machine')
  })
})

describe('historyPlugin pre-sync (drift guard)', () => {
  const incoming = { 'conf/app.env': blobId('A=1\n'), 'docker-compose.yml': blobId('services: {}\n') }

  it('does nothing without a remote', async () => {
    const { ctx } = makeCtx([])
    await runPhases(plugin(), ctx, ['stage', 'pre-sync', 'post-sync'])
    expect(ctx.errors).toEqual([])
  })

  it('sends incoming blob ids on stdin; no conflicts → no errors; box edits logged', async () => {
    const remote = fakeRemote((cmd) => cmd.startsWith(DRIFT) ? { stdout: 'noise\n{"boxEdits":["x.yml"],"conflicts":[]}\n' } : undefined)
    const { ctx, infos } = makeCtx([], remote)
    await runPhases(plugin(), ctx, ['stage', 'pre-sync'])
    expect(remote.calls).toHaveLength(1)
    expect(remote.calls[0].cmd).toBe(`${DRIFT} web`)
    expect(JSON.parse(remote.calls[0].stdin!)).toEqual({ incoming })
    expect(ctx.errors).toEqual([])
    expect(infos).toEqual(['box edits saved in history: x.yml'])
  })

  it('adds --base when .stack-base holds a commit', async () => {
    mkdirSync(machineDir, { recursive: true })
    writeFileSync(join(machineDir, STACK_BASE_FILE), `${BASE}\n`)
    expect(readStackBase(machineDir)).toBe(BASE)
    const remote = fakeRemote(() => ({ stdout: '{"conflicts":[]}' }))
    const { ctx } = makeCtx([], remote)
    await runPhases(plugin(), ctx, ['stage', 'pre-sync'])
    expect(remote.runs()).toEqual([`${DRIFT} web --base ${BASE}`])
  })

  it('ignores a malformed .stack-base', async () => {
    mkdirSync(machineDir, { recursive: true })
    writeFileSync(join(machineDir, STACK_BASE_FILE), 'not-a-sha; rm -rf /\n')
    expect(readStackBase(machineDir)).toBeUndefined()
    const remote = fakeRemote(() => ({ stdout: '{"conflicts":[]}' }))
    const { ctx } = makeCtx([], remote)
    await runPhases(plugin(), ctx, ['stage', 'pre-sync'])
    expect(remote.runs()).toEqual([`${DRIFT} web`])
  })

  it('conflicts → one fatal error', async () => {
    const remote = fakeRemote(() => ({ stdout: '{"conflicts":["conf/app.env","docker-compose.yml"]}' }))
    const { ctx } = makeCtx([], remote)
    await runPhases(plugin(), ctx, ['stage', 'pre-sync'])
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toMatchObject({ phase: 'pre-sync', fatal: true })
    expect(ctx.errors[0].message).toContain('box edits would be lost: conf/app.env, docker-compose.yml')
  })

  it('conflicts with force → warning only', async () => {
    const remote = fakeRemote(() => ({ stdout: '{"conflicts":["conf/app.env"]}' }))
    const { ctx } = makeCtx([], remote)
    await runPhases(plugin({ force: true }), ctx, ['stage', 'pre-sync'])
    expect(ctx.errors).toEqual([{ phase: 'pre-sync', fatal: false, message: expect.stringContaining('--force: overwrites box edits to conf/app.env') }])
  })

  it('unparseable output (old node binary) → warning only', async () => {
    const remote = fakeRemote(() => ({ stdout: '', stderr: 'airstack: unknown command "drift"\n', exitCode: 3 }))
    const { ctx } = makeCtx([], remote)
    await runPhases(plugin(), ctx, ['stage', 'pre-sync'])
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0].fatal).toBe(false)
    expect(ctx.errors[0].message).toContain('the drift check did not run (airstack: unknown command "drift")')
  })

  it('unparseable output with no text names the exit code', async () => {
    const remote = fakeRemote(() => ({ exitCode: 127 }))
    const { ctx } = makeCtx([], remote)
    await runPhases(plugin(), ctx, ['stage', 'pre-sync'])
    expect(ctx.errors[0].message).toContain('(exit 127)')
  })
})

describe('historyPlugin post-sync', () => {
  it('calls record-deploy with --commit', async () => {
    const remote = fakeRemote(() => ({ stdout: '{"conflicts":[]}' }))
    const { ctx } = makeCtx([], remote)
    await runPhases(plugin({ nodeUnit: 'machine', fleetCommit: 'def5678-dirty' }), ctx, ['stage', 'pre-sync', 'post-sync'])
    expect(remote.runs()[1]).toBe('sudo /usr/local/bin/airstack machine record-deploy machine --commit def5678-dirty')
    expect(ctx.errors).toEqual([])
  })

  it('a failed record → warning', async () => {
    const remote = fakeRemote((cmd) => cmd.includes('record-deploy') ? { stderr: 'boom\n', exitCode: 2 } : undefined)
    const { ctx } = makeCtx([], remote)
    await runPhases(plugin(), ctx, ['post-sync'])
    expect(ctx.errors).toEqual([{ phase: 'post-sync', fatal: false, message: 'config history: could not record the deploy (boom)' }])
  })
})
