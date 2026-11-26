import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { register as registerBackup } from '../../../cli/plugins/backup/index'
import { register as registerProxy } from '../../../cli/plugins/cliproxyapi/index'
import { postSync } from '../../../cli/deploy/02c-post-sync'
import { loadConfig } from '../../../cli/lib/config'
import { nullLogger, setupProject } from '../helpers'
import type { DeployContext } from '../../../cli/types'

const STACK = `
stack:
  installDir: /home/deploy
  projectName: myproject
host:
  hostname: myhost
plugins:
  cliproxyapi: {}
  backup:
    destination: backups/
    sets:
      cliproxyapi:
        sources:
          - .cliproxyapi/config.yaml
`

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

function ctxWith(run: (c: string) => { stdout?: string; exitCode?: number }): { ctx: DeployContext; cmds: string[] } {
  root = setupProject('', STACK)
  const cmds: string[] = []
  const ctx = {
    phase: 'post-sync', projectRoot: root, sharedPaths: [], deployDir: root,
    config: loadConfig(root), ssh: { host: '', port: 22, user: 'root', keyPath: '' }, plugins: [],
    log: nullLogger, errors: [], changes: [], phaseStatus: [],
    compose: { services: [], buildArgs: [], upArgs: [], profiles: [] }, report: { data: {} },
    manifest: { destination: '', entries: {} },
    registeredFiles: { scripts: { dirs: [], exclude: [] }, hostFiles: [] },
    remote: {
      async run(c: string) { cmds.push(c); const r = run(c); return { stdout: r.stdout ?? '', stderr: '', exitCode: r.exitCode ?? 0 } },
      async rsync() { return { exitCode: 0 } },
    },
  } as unknown as DeployContext
  return { ctx, cmds }
}

describe('file permission hardening', () => {
  it('core post-sync closes installDir to other users and reads it with sudo', async () => {
    const { ctx, cmds } = ctxWith((c) => ({ stdout: c.includes('test -f') ? 'ok' : c.includes('test -d') ? 'yes' : '' }))
    ctx.manifest.destination = '/etc/stacks/myproject.env'
    await postSync(ctx)
    // globs over installDir must expand inside sudo, not in the unprivileged ssh shell
    const copies = cmds.filter(c => /\bcp\b/.test(c))
    expect(copies.length).toBeGreaterThanOrEqual(2)
    for (const c of copies) expect(c).toMatch(/^sudo sh -c 'cp /)
    expect(cmds[0]).toBe('sudo chmod 750 /home/deploy')
    const reads = cmds.filter(c => /\b(test -d|find )/.test(c))
    expect(reads.length).toBeGreaterThan(0)
    for (const c of reads) expect(c).toMatch(/sudo (test -d|find)/)
  })

  it('cliproxyapi post-sync makes auth files owner-only', async () => {
    const { ctx, cmds } = ctxWith((c) => ({ stdout: c.includes('test -f') ? 'ok' : '', exitCode: c.includes('grep') ? 1 : 0 }))
    const raw = loadConfig(root).plugins['cliproxyapi']
    await registerProxy(raw).hooks!['post-sync']!(ctx, raw)
    expect(cmds.some(c => c.includes('find /home/deploy/.cliproxyapi/auths -type f -exec chmod 600'))).toBe(true)
  })

  it('backup post-sync strips group/other access from the backups dir', async () => {
    const { ctx, cmds } = ctxWith(() => ({}))
    const raw = loadConfig(root).plugins['backup']
    await registerBackup(raw).hooks!['post-sync']!(ctx, raw)
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toContain('sudo chmod -R go-rwx /home/deploy/backups')
  })
})

import { ownershipCommand } from '../../../cli/lib/ownership'

describe('ownership reset', () => {
  it('is a plain recursive chown when nothing is kept', () => {
    expect(ownershipCommand('/home/deploy', 'stackroot', [])).toBe('sudo chown -R stackroot:stackroot /home/deploy/')
  })

  it('skips keepOwner paths without descending into them', () => {
    const cmd = ownershipCommand('/home/deploy/', 'stackroot', ['.usage-server/data', '/other/'])
    expect(cmd).toBe(
      "sudo find /home/deploy -path '/home/deploy/.usage-server/data' -prune -o -path '/home/deploy/other' -prune -o -exec chown stackroot:stackroot {} +",
    )
  })

  it('quotes odd paths', () => {
    expect(ownershipCommand('/h', 'u', ["a b'c"])).toContain(`-path '/h/a b'\\''c' -prune`)
  })
})
