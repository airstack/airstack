import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { nullLogger, setupProject } from '../helpers'
import { loadConfig } from '../../support/legacy-config'
import type { DeployContext, Plugin } from '../../../cli/types'

function makeCtx(root: string, plugins: Plugin[] = []): DeployContext {
  const deployDir = join(root, '.deploy')
  mkdirSync(deployDir, { recursive: true })
  return {
    phase: 'stage',
    projectRoot: root,
    sharedPaths: [],
    deployDir,
    config: loadConfig(root),
    ssh: { host: '', port: 22, user: 'root', keyPath: '' },
    plugins,
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
  }
}

describe('deploy/ auto-staging', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('copies plugin deploy/ dir to .deploy/plugins/{name}/', async () => {
    root = setupProject('', `
stack:
  installDir: /opt/test
  projectName: test
host:
  hostname: test
`)
    const pluginDir = join(root, 'fake-plugin')
    mkdirSync(join(pluginDir, 'deploy', 'scripts'), { recursive: true })
    writeFileSync(join(pluginDir, 'deploy', 'scripts', 'run.sh'), '#!/bin/bash\necho hi')
    writeFileSync(join(pluginDir, 'deploy', 'config.ini'), '[test]\nkey=val')

    const plugin: Plugin = { name: 'myplugin', sourceDir: pluginDir }

    const { stage } = await import('../../../cli/deploy/01b-stage')
    const ctx = makeCtx(root, [plugin])
    await stage(ctx)

    expect(existsSync(join(ctx.deployDir, 'plugins', 'myplugin', 'scripts', 'run.sh'))).toBe(true)
    expect(readFileSync(join(ctx.deployDir, 'plugins', 'myplugin', 'scripts', 'run.sh'), 'utf8'))
      .toContain('echo hi')
    expect(existsSync(join(ctx.deployDir, 'plugins', 'myplugin', 'config.ini'))).toBe(true)
  })

  it('skips auto-staging when plugin has no deploy/ dir', async () => {
    root = setupProject('', `
stack:
  installDir: /opt/test
  projectName: test
host:
  hostname: test
`)
    const pluginDir = join(root, 'no-deploy-plugin')
    mkdirSync(pluginDir, { recursive: true })

    const plugin: Plugin = { name: 'noplug', sourceDir: pluginDir }

    const { stage } = await import('../../../cli/deploy/01b-stage')
    const ctx = makeCtx(root, [plugin])
    await stage(ctx)

    expect(existsSync(join(ctx.deployDir, 'plugins', 'noplug'))).toBe(false)
  })

  it('uses deploySourceDir override when set', async () => {
    root = setupProject('', `
stack:
  installDir: /opt/test
  projectName: test
host:
  hostname: test
`)
    const customDir = join(root, 'custom-assets')
    mkdirSync(customDir, { recursive: true })
    writeFileSync(join(customDir, 'data.txt'), 'custom')

    const plugin: Plugin = {
      name: 'custom',
      sourceDir: join(root, 'some-plugin'),
      deploySourceDir: customDir,
    }

    const { stage } = await import('../../../cli/deploy/01b-stage')
    const ctx = makeCtx(root, [plugin])
    await stage(ctx)

    expect(readFileSync(join(ctx.deployDir, 'plugins', 'custom', 'data.txt'), 'utf8')).toBe('custom')
  })

  it('skips plugin with no sourceDir', async () => {
    root = setupProject('', `
stack:
  installDir: /opt/test
  projectName: test
host:
  hostname: test
`)
    const plugin: Plugin = { name: 'nosource' }

    const { stage } = await import('../../../cli/deploy/01b-stage')
    const ctx = makeCtx(root, [plugin])
    await stage(ctx)

    expect(existsSync(join(ctx.deployDir, 'plugins', 'nosource'))).toBe(false)
  })
})
