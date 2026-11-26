import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { renderReport } from '../../../cli/lib/report'
import { nullLogger, makeTmpDir } from '../helpers'
import type { DeployContext, Config, Plugin } from '../../../cli/types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    stackConfig: { stackFile: '/opt/app/stack.yml', envFile: '/opt/app/.env', allowUnsafeGit: false },
    host: { hostname: 'test-host', timezone: 'UTC', appUser: 'test', ip: '10.0.0.1', sshUser: 'root', sshPort: 22, sshKey: '', sudoUser: 'root', sudoUserPassword: '', appUserPassword: '', devUsers: [], brewOwner: '', sshHardenedPort: 2222, sshExpose: 'public', sshTunnelHostname: '' },
    stack: { installDir: '/opt/app', projectName: 'myproject' } as Config['stack'],
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
    phase: 'done',
    projectRoot,
    sharedPaths: [],
    deployDir,
    config: makeConfig(),
    ssh: { host: '10.0.0.1', port: 22, user: 'root', keyPath: '' },
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

const SIMPLE_TEMPLATE = `# Report
**Phase:** {{completedPhase}}
**Date:** {{date}}
**Host:** {{host.hostname}}
**Project:** {{stack.projectName}}
{{#each phaseStatus}}
- {{this.phase}}: {{#if this.success}}OK{{else}}FAIL{{/if}}
{{/each}}
{{#each errors}}
- ERROR: {{this.message}}
{{/each}}
{{#each pluginReports}}
## {{this.title}}
{{{this.rendered}}}
{{/each}}
`

// ── Tests ────────────────────────────────────────────────────────────────────

describe('renderReport: basic rendering', () => {
  it('renders report with phase status', () => {
    const ctx = makeCtx()
    ctx.phaseStatus = [
      { phase: 'pre-stage', success: true, message: 'Ready' },
      { phase: 'stage', success: true, message: 'Staged' },
    ]

    // Write template
    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), SIMPLE_TEMPLATE)

    const dest = renderReport(ctx)

    const content = readFileSync(dest, 'utf-8')
    expect(content).toContain('pre-stage: OK')
    expect(content).toContain('stage: OK')
  })

  it('renders report with errors', () => {
    const ctx = makeCtx()
    ctx.errors = [
      { phase: 'sync', message: 'VPS unreachable', fatal: true },
      { phase: 'validate', message: 'Warning: disk low', fatal: false },
    ]

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), SIMPLE_TEMPLATE)

    const dest = renderReport(ctx)

    const content = readFileSync(dest, 'utf-8')
    expect(content).toContain('VPS unreachable')
    expect(content).toContain('Warning: disk low')
  })

  it('renders plugin report sections (pre-rendered)', () => {
    const plugin: Plugin = {
      name: 'test-plugin',
      report: {
        title: 'Test Section',
        template: '**Status:** All good from {{stack.projectName}}',
        order: 10,
      },
    }

    const ctx = makeCtx({ plugins: [plugin] })

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), SIMPLE_TEMPLATE)

    const dest = renderReport(ctx)

    const content = readFileSync(dest, 'utf-8')
    expect(content).toContain('## Test Section')
    expect(content).toContain('**Status:** All good from myproject')
  })

  it('plugin sections sorted by order', () => {
    const pluginA: Plugin = {
      name: 'later',
      report: { title: 'Later Section', template: 'LATER', order: 50 },
    }
    const pluginB: Plugin = {
      name: 'earlier',
      report: { title: 'Earlier Section', template: 'EARLIER', order: 10 },
    }

    const ctx = makeCtx({ plugins: [pluginA, pluginB] })

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), SIMPLE_TEMPLATE)

    const dest = renderReport(ctx)

    const content = readFileSync(dest, 'utf-8')
    const earlierIdx = content.indexOf('Earlier Section')
    const laterIdx = content.indexOf('Later Section')
    expect(earlierIdx).toBeLessThan(laterIdx)
  })
})

describe('renderReport: fallback template', () => {
  it('uses fallback template when configured template is missing', () => {
    const ctx = makeCtx()
    // Don't create the template file — should use fallback
    ctx.phaseStatus = [{ phase: 'pre-stage', success: true, message: 'Ready' }]

    const dest = renderReport(ctx)

    const content = readFileSync(dest, 'utf-8')
    // Fallback template should render
    expect(content).toContain('Deploy Report')
    expect(content).toContain('Report template not found')
    // Should still have our data
    expect(content).toContain('pre-stage')
    // Should push a non-fatal error about missing template
    expect(ctx.errors.some(e => !e.fatal && e.message.includes('Report template not found'))).toBe(true)
  })
})

describe('renderReport: Docker services from compose yaml', () => {
  it('parses docker services from staged docker-compose.yml', () => {
    const ctx = makeCtx()
    // Write a compose file in deployDir
    writeFileSync(
      join(ctx.deployDir, 'docker-compose.yml'),
      `version: "3"
services:
  web:
    container_name: myapp-web
    image: nginx:latest
  db:
    container_name: myapp-db
    image: postgres:15
`,
    )

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(
      join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'),
      `{{#each dockerServices}}{{this.name}}:{{this.image}} {{/each}}`,
    )

    renderReport(ctx)

    const data = ctx.report.data as any
    expect(data.dockerServices).toHaveLength(2)
    expect(data.dockerServices[0]).toMatchObject({ name: 'web', containerName: 'myapp-web', image: 'nginx:latest' })
    expect(data.dockerServices[1]).toMatchObject({ name: 'db', containerName: 'myapp-db', image: 'postgres:15' })
  })

  it('uses (build) for services without an image', () => {
    const ctx = makeCtx()
    writeFileSync(
      join(ctx.deployDir, 'docker-compose.yml'),
      `version: "3"
services:
  custom:
    build: .
    container_name: myapp-custom
`,
    )

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), '{{completedPhase}}')

    renderReport(ctx)

    const data = ctx.report.data as any
    expect(data.dockerServices[0].image).toBe('(build)')
  })

  it('detects empty env vars in compose yaml', () => {
    const ctx = makeCtx()
    writeFileSync(
      join(ctx.deployDir, 'docker-compose.yml'),
      `version: "3"
services:
  web:
    image: nginx
    environment:
      - NODE_ENV=production
      - SECRET_KEY=
      - API_TOKEN=
      - FILLED_VAR=abc
`,
    )

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), '{{completedPhase}}')

    renderReport(ctx)

    const data = ctx.report.data as any
    expect(data.emptyEnvVars).toContain('SECRET_KEY')
    expect(data.emptyEnvVars).toContain('API_TOKEN')
    expect(data.emptyEnvVars).not.toContain('NODE_ENV')
    expect(data.emptyEnvVars).not.toContain('FILLED_VAR')
  })
})

describe('renderReport: output destinations', () => {
  it('writes report to destination path', () => {
    const ctx = makeCtx()
    ctx.config.deploy.report.destination = './reports/deploy.md'

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), 'Report: {{completedPhase}}')

    const dest = renderReport(ctx)

    expect(dest).toBe(join(ctx.projectRoot, 'reports', 'deploy.md'))
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toContain('Report: completed')
  })

  it('copies report to logDir when provided', () => {
    const ctx = makeCtx()
    const logDir = join(makeTmpDir(), 'deploy-logs')

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), 'Log copy test')

    renderReport(ctx, logDir)

    const logCopy = join(logDir, 'deploy-report.md')
    expect(existsSync(logCopy)).toBe(true)
    expect(readFileSync(logCopy, 'utf-8')).toBe('Log copy test')
  })

  it('does not write to logDir when not provided', () => {
    const ctx = makeCtx()

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), 'no logDir')

    const dest = renderReport(ctx)

    // Only the destination file should exist
    expect(existsSync(dest)).toBe(true)
  })
})

describe('renderReport: report data enrichment', () => {
  it('includes host, stack, date, completedPhase', () => {
    const ctx = makeCtx()

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), '{{host.hostname}} {{stack.projectName}} {{completedPhase}} {{date}}')

    renderReport(ctx)

    const data = ctx.report.data as any
    expect(data.host.hostname).toBe('test-host')
    expect(data.stack.projectName).toBe('myproject')
    expect(data.completedPhase).toBe('completed')
    expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('includes errors in report data', () => {
    const ctx = makeCtx()
    ctx.errors = [
      { phase: 'sync', message: 'sync failed', fatal: true },
    ]

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), '{{completedPhase}}')

    renderReport(ctx)

    const data = ctx.report.data as any
    expect(data.errors).toHaveLength(1)
    expect(data.errors[0].message).toBe('sync failed')
  })

  it('includes phaseStatus in report data', () => {
    const ctx = makeCtx()
    ctx.phaseStatus = [
      { phase: 'stage', success: true, message: 'Staged' },
    ]

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), '{{completedPhase}}')

    renderReport(ctx)

    const data = ctx.report.data as any
    expect(data.phaseStatus).toHaveLength(1)
    expect(data.phaseStatus[0].phase).toBe('stage')
  })

  it('includes pluginReports sorted by order', () => {
    const pluginA: Plugin = {
      name: 'z-last',
      report: { title: 'Last', template: 'last content', order: 90 },
    }
    const pluginB: Plugin = {
      name: 'a-first',
      report: { title: 'First', template: 'first content', order: 5 },
    }

    const ctx = makeCtx({ plugins: [pluginA, pluginB] })

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), '{{completedPhase}}')

    renderReport(ctx)

    const data = ctx.report.data as any
    expect(data.pluginReports).toHaveLength(2)
    expect(data.pluginReports[0].title).toBe('First')
    expect(data.pluginReports[1].title).toBe('Last')
  })
})

describe('renderReport: edge cases', () => {
  it('works with empty plugins array', () => {
    const ctx = makeCtx({ plugins: [] })

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), 'empty plugins: {{completedPhase}}')

    const dest = renderReport(ctx)

    const content = readFileSync(dest, 'utf-8')
    expect(content).toContain('empty plugins: completed')
  })

  it('works with plugins that have no report section', () => {
    const plugin: Plugin = {
      name: 'no-report',
      hooks: {
        'pre-stage': async () => {},
      },
    }
    const ctx = makeCtx({ plugins: [plugin] })

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), '{{completedPhase}}')

    const dest = renderReport(ctx)

    const data = ctx.report.data as any
    expect(data.pluginReports).toHaveLength(0)
    expect(existsSync(dest)).toBe(true)
  })

  it('handles plugin report template rendering error gracefully', () => {
    const plugin: Plugin = {
      name: 'bad-template',
      report: {
        title: 'Bad Section',
        template: '{{#if}}missing close{{/wrong}}',  // invalid Handlebars
        order: 10,
      },
    }
    const ctx = makeCtx({ plugins: [plugin] })

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), SIMPLE_TEMPLATE)

    // Should not throw
    const dest = renderReport(ctx)
    const content = readFileSync(dest, 'utf-8')

    // Should contain error message in the rendered section
    expect(content).toContain('Bad Section')
    expect(content).toContain('Error rendering report section')
  })

  it('handles no docker-compose.yml in deployDir gracefully', () => {
    const ctx = makeCtx()
    // Don't write docker-compose.yml to deployDir

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), '{{completedPhase}}')

    const dest = renderReport(ctx)

    const data = ctx.report.data as any
    expect(data.dockerServices).toBeUndefined()
    expect(data.emptyEnvVars).toBeUndefined()
    expect(existsSync(dest)).toBe(true)
  })

  it('uses default order (50) for plugins without explicit order', () => {
    const pluginLow: Plugin = {
      name: 'low',
      report: { title: 'Low', template: 'low', order: 10 },
    }
    const pluginDefault: Plugin = {
      name: 'default-order',
      report: { title: 'Default', template: 'default' },
      // no order — defaults to 50
    }
    const pluginHigh: Plugin = {
      name: 'high',
      report: { title: 'High', template: 'high', order: 80 },
    }

    const ctx = makeCtx({ plugins: [pluginHigh, pluginDefault, pluginLow] })

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'), '{{completedPhase}}')

    renderReport(ctx)

    const data = ctx.report.data as any
    expect(data.pluginReports.map((r: any) => r.title)).toEqual(['Low', 'Default', 'High'])
  })

  it('deploy-logs report copy strips secrets', () => {
    const ctx = makeCtx()
    ctx.config.deploy.report.secrets = [
      { name: 'DB Password', value: 'super-secret-pw' },
    ]

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(
      join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'),
      '{{#each secrets}}{{this.name}}: {{this.value}}\n{{/each}}Done',
    )

    const logDir = join(ctx.projectRoot, '.deploy-logs', 'test')
    renderReport(ctx, logDir)

    // Main report should contain the secret
    const mainContent = readFileSync(join(ctx.projectRoot, 'deploy-report.md'), 'utf-8')
    expect(mainContent).toContain('super-secret-pw')

    // Log copy should NOT contain the secret
    const logContent = readFileSync(join(logDir, 'deploy-report.md'), 'utf-8')
    expect(logContent).not.toContain('super-secret-pw')
  })

  it('deploy-logs report copy redacts 64-char hex tokens', () => {
    const ctx = makeCtx()
    const fakeToken = 'a'.repeat(64)

    const plugin: Plugin = {
      name: 'test-plugin',
      report: {
        title: 'Test',
        template: `Token: \`${fakeToken}\``,
        order: 10,
      },
    }
    ctx.plugins = [plugin]

    mkdirSync(join(ctx.projectRoot, 'templates'), { recursive: true })
    writeFileSync(
      join(ctx.projectRoot, 'templates', 'deploy-report.md.hbs'),
      '{{#each pluginReports}}{{{this.rendered}}}{{/each}}',
    )

    const logDir = join(ctx.projectRoot, '.deploy-logs', 'test')
    renderReport(ctx, logDir)

    // Main report should contain the token
    const mainContent = readFileSync(join(ctx.projectRoot, 'deploy-report.md'), 'utf-8')
    expect(mainContent).toContain(fakeToken)

    // Log copy should have it redacted
    const logContent = readFileSync(join(logDir, 'deploy-report.md'), 'utf-8')
    expect(logContent).not.toContain(fakeToken)
    expect(logContent).toContain('[REDACTED]')
  })

  it('resolves template from sharedPaths when not in projectRoot', () => {
    const ctx = makeCtx()
    const sharedDir = makeTmpDir()
    ctx.sharedPaths = [sharedDir]

    // Write template to sharedDir instead of projectRoot
    mkdirSync(join(sharedDir, 'templates'), { recursive: true })
    writeFileSync(join(sharedDir, 'templates', 'deploy-report.md.hbs'), 'Shared: {{completedPhase}}')

    const dest = renderReport(ctx)

    const content = readFileSync(dest, 'utf-8')
    expect(content).toContain('Shared: completed')
    // Should not have pushed an error since template was found
    expect(ctx.errors.filter(e => e.message.includes('Report template not found'))).toHaveLength(0)
  })
})
