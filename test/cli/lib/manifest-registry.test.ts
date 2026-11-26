import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../../support/legacy-config'
import { stage } from '../../../cli/lib/stage'
import { setupProject } from '../helpers'

describe('manifest: CONFIG_DIR and STATE_DIR', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('manifest contains CONFIG_DIR and STATE_DIR derived from INSTALL_DIR', () => {
    root = setupProject('', `
stack:
  installDir: /opt/mystack
  projectName: mystack
host:
  hostname: myhost
`)
    const deployDir = join(root, '.deploy')
    const config = loadConfig(root)
    // Simulate pre-stage core enrichment
    const manifestEntries: Record<string, string> = {
      PROJECT_NAME: 'mystack',
      INSTALL_DIR: '/opt/mystack',
      CONFIG_DIR: '/opt/mystack/.stack-config',
      STATE_DIR: '/opt/mystack/.stack-state',
    }
    stage({ projectRoot: root, sharedPaths: [], config, deployDir, manifestEntries })

    const manifest = readFileSync(join(deployDir, 'etc', 'stacks', 'mystack.env'), 'utf8')
    expect(manifest).toMatch(/^CONFIG_DIR=\/opt\/mystack\/\.stack-config$/m)
    expect(manifest).toMatch(/^STATE_DIR=\/opt\/mystack\/\.stack-state$/m)
  })

  it('manifest includes plugin-contributed manifestEntries', () => {
    root = setupProject('', `
stack:
  installDir: /opt/mystack
  projectName: mystack
host:
  hostname: myhost
`)
    const deployDir = join(root, '.deploy')
    const config = loadConfig(root)
    stage({
      projectRoot: root,
      sharedPaths: [],
      config,
      deployDir,
      manifestEntries: {
        BACKUP_HEALTH_CHECK: '/opt/mystack/plugins/backup/check-health.sh',
      },
    })

    const manifest = readFileSync(join(deployDir, 'etc', 'stacks', 'mystack.env'), 'utf8')
    expect(manifest).toMatch(/^BACKUP_HEALTH_CHECK=\/opt\/mystack\/plugins\/backup\/check-health\.sh$/m)
  })

  it('manifest entries are available in template context as {{manifest.*}}', () => {
    root = setupProject('', `
stack:
  installDir: /opt/mystack
  projectName: tmpl-test
host:
  hostname: myhost
templates:
  out.txt: templates/out.hbs
`)
    const deployDir = join(root, '.deploy')
    mkdirSync(join(root, 'templates'), { recursive: true })
    writeFileSync(
      join(root, 'templates', 'out.hbs'),
      'check={{manifest.BACKUP_HEALTH_CHECK}}',
    )

    const config = loadConfig(root)
    stage({
      projectRoot: root,
      sharedPaths: [],
      config,
      deployDir,
      manifestEntries: { BACKUP_HEALTH_CHECK: '/opt/mystack/plugins/backup/check-health.sh' },
    })

    expect(readFileSync(join(deployDir, 'out.txt'), 'utf8'))
      .toBe('check=/opt/mystack/plugins/backup/check-health.sh')
  })

  it('works with only core manifestEntries (no plugin contributions)', () => {
    root = setupProject('', `
stack:
  installDir: /opt/app
  projectName: bare
host:
  hostname: myhost
`)
    const deployDir = join(root, '.deploy')
    const config = loadConfig(root)
    // Simulate pre-stage core enrichment
    const manifestEntries: Record<string, string> = {
      PROJECT_NAME: 'bare',
      INSTALL_DIR: '/opt/app',
      CONFIG_DIR: '/opt/app/.stack-config',
      STATE_DIR: '/opt/app/.stack-state',
    }
    stage({ projectRoot: root, sharedPaths: [], config, deployDir, manifestEntries })

    const manifest = readFileSync(join(deployDir, 'etc', 'stacks', 'bare.env'), 'utf8')
    const dataLines = manifest.split('\n').filter(l => l && !l.startsWith('#'))
    expect(dataLines).toHaveLength(4) // PROJECT_NAME, INSTALL_DIR, CONFIG_DIR, STATE_DIR
  })
})
