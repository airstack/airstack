import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, rmSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { updateConfig } from '../../../cli/lib/config-writer'
import { loadConfig } from '../../../cli/lib/config'
import { setupProject, nullLogger } from '../helpers'
import type { DeployContext } from '../../../cli/types'

const MINIMAL_STACK = `
stack:
  installDir: /opt/test
  projectName: test
host:
  hostname: myhost
`

describe('updateConfig', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('writes a new literal value to stack.yml and mutates config in place', () => {
    root = setupProject('', MINIMAL_STACK)
    const config = loadConfig(root)

    updateConfig(root, config, 'stack.my_token', 'abc123')

    // In-memory config is mutated
    expect((config.stack as any).my_token).toBe('abc123')

    // Persisted to disk
    const raw = readFileSync(join(root, 'stack.yml'), 'utf-8')
    expect(raw).toContain('abc123')
  })

  it('updates an existing literal value in stack.yml', () => {
    const stack = `
stack:
  installDir: /opt/test
  projectName: test
  my_key: old_value
host:
  hostname: myhost
`
    root = setupProject('', stack)
    const config = loadConfig(root)

    updateConfig(root, config, 'stack.my_key', 'new_value')

    expect((config.stack as any).my_key).toBe('new_value')
  })

  it('updates .env when stack.yml key uses ${VAR} reference', () => {
    const stack = `
stack:
  installDir: /opt/test
  projectName: test
  secret: \${MY_SECRET}
host:
  hostname: myhost
`
    root = setupProject('MY_SECRET=old_secret', stack)
    const config = loadConfig(root)

    updateConfig(root, config, 'stack.secret', 'new_secret')

    // In-memory config updated
    expect((config.stack as any).secret).toBe('new_secret')

    // .env updated
    const envContent = readFileSync(join(root, '.env'), 'utf-8')
    expect(envContent).toContain('MY_SECRET=new_secret')

    // stack.yml still has ${MY_SECRET} reference (not overwritten)
    const yamlContent = readFileSync(join(root, 'stack.yml'), 'utf-8')
    expect(yamlContent).toContain('${MY_SECRET}')
  })

  it('creates nested keys that do not exist yet', () => {
    root = setupProject('', MINIMAL_STACK)
    const config = loadConfig(root)

    updateConfig(root, config, 'stack.services.my_service.gatewayToken', 'tok123')

    expect((config.stack as any).services.my_service.gatewayToken).toBe('tok123')
  })

  it('in-memory mutation is visible to all holders of the same config reference', () => {
    root = setupProject('', MINIMAL_STACK)
    const config = loadConfig(root)

    // Simulate what DeployContext does — multiple references to same config
    const ctx = { config }
    const anotherRef = ctx.config

    updateConfig(root, ctx.config, 'stack.new_field', 'shared_value')

    // Both references see the change
    expect((ctx.config.stack as any).new_field).toBe('shared_value')
    expect((anotherRef.stack as any).new_field).toBe('shared_value')
  })
})

describe('updateConfig: stack.yml formatting preservation', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('preserves comments, blank lines, and indentation when adding a nested key', () => {
    const input = `# My stack config
stack:
  installDir: /opt/test
  projectName: test

  # Important comment about services
  services:
    personal-service:
      domain: example.com
      gatewayPort: 18789

host:
  hostname: myhost
`
    const expected = `# My stack config
stack:
  installDir: /opt/test
  projectName: test

  # Important comment about services
  services:
    personal-service:
      domain: example.com
      gatewayPort: 18789
      gatewayToken: tok_123

host:
  hostname: myhost
`
    root = setupProject('', input)
    const config = loadConfig(root)
    updateConfig(root, config, 'stack.services.personal-service.gatewayToken', 'tok_123')
    expect(readFileSync(join(root, 'stack.yml'), 'utf-8')).toBe(expected)
  })

  it('preserves blank lines between sections when adding a key', () => {
    const input = `stack:
  installDir: /opt/test
  projectName: test

  services:
    my-service:
      domain: example.com

host:
  hostname: myhost
`
    const expected = `stack:
  installDir: /opt/test
  projectName: test

  services:
    my-service:
      domain: example.com
      new_key: new_val

host:
  hostname: myhost
`
    root = setupProject('', input)
    const config = loadConfig(root)
    updateConfig(root, config, 'stack.services.my-service.new_key', 'new_val')
    expect(readFileSync(join(root, 'stack.yml'), 'utf-8')).toBe(expected)
  })

  it('updates existing value inline, preserving everything else exactly', () => {
    const input = `# Config file
stack:
  installDir: /opt/test
  projectName: test
  my_key: old_value
host:
  hostname: myhost
`
    const expected = `# Config file
stack:
  installDir: /opt/test
  projectName: test
  my_key: new_value
host:
  hostname: myhost
`
    root = setupProject('', input)
    const config = loadConfig(root)
    updateConfig(root, config, 'stack.my_key', 'new_value')
    expect(readFileSync(join(root, 'stack.yml'), 'utf-8')).toBe(expected)
  })

  it('does not mangle other sections when inserting a deeply nested key', () => {
    const input = `stack:
  installDir: /opt/test
  projectName: test

  aiGateway:
    url: https://gateway.example.com
    token: gw_token_123

  services:
    personal-service:
      domain: example.com

host:
  hostname: myhost
  timezone: UTC
`
    const expected = `stack:
  installDir: /opt/test
  projectName: test

  aiGateway:
    url: https://gateway.example.com
    token: gw_token_123

  services:
    personal-service:
      domain: example.com
      gatewayToken: service_tok

host:
  hostname: myhost
  timezone: UTC
`
    root = setupProject('', input)
    const config = loadConfig(root)
    updateConfig(root, config, 'stack.services.personal-service.gatewayToken', 'service_tok')
    expect(readFileSync(join(root, 'stack.yml'), 'utf-8')).toBe(expected)
  })

  it('preserves multiple comments and inline structure in a complex file', () => {
    const input = `# Stack configuration
# Generated by stack-cli

stack:
  installDir: /opt/app
  projectName: myapp

  # AI provider config
  aiGateway:
    url: https://ai.example.com
    token: \${AI_TOKEN}

  # Service instances
  serviceDefaults:
    timezone: America/Los_Angeles

  services:
    work-service:
      domain: work.example.com
      gatewayPort: 18790

# Host access
host:
  hostname: myserver
  # SSH settings below
  appUser: deploy
`
    const expected = `# Stack configuration
# Generated by stack-cli

stack:
  installDir: /opt/app
  projectName: myapp

  # AI provider config
  aiGateway:
    url: https://ai.example.com
    token: \${AI_TOKEN}

  # Service instances
  serviceDefaults:
    timezone: America/Los_Angeles

  services:
    work-service:
      domain: work.example.com
      gatewayPort: 18790
      gatewayToken: generated_abc

# Host access
host:
  hostname: myserver
  # SSH settings below
  appUser: deploy
`
    root = setupProject('AI_TOKEN=real_token', input)
    const config = loadConfig(root)
    updateConfig(root, config, 'stack.services.work-service.gatewayToken', 'generated_abc')
    expect(readFileSync(join(root, 'stack.yml'), 'utf-8')).toBe(expected)
  })
})

describe('updateConfig: safety mechanisms', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('rejects values containing newlines', () => {
    root = setupProject('', MINIMAL_STACK)
    const config = loadConfig(root)

    expect(() => {
      updateConfig(root, config, 'stack.bad_key', 'line1\nline2')
    }).toThrow(/newlines/)
  })

  it('rejects values containing carriage returns', () => {
    root = setupProject('', MINIMAL_STACK)
    const config = loadConfig(root)

    expect(() => {
      updateConfig(root, config, 'stack.bad_key', 'line1\rline2')
    }).toThrow(/newlines/)
  })

  it('does not corrupt stack.yml when value is rejected', () => {
    root = setupProject('', MINIMAL_STACK)
    const config = loadConfig(root)
    const originalContent = readFileSync(join(root, 'stack.yml'), 'utf-8')

    try {
      updateConfig(root, config, 'stack.bad_key', 'line1\nline2')
    } catch { /* expected */ }

    // File unchanged
    expect(readFileSync(join(root, 'stack.yml'), 'utf-8')).toBe(originalContent)
  })

  it('quotes values containing YAML special characters', () => {
    const input = `stack:
  installDir: /opt/test
  projectName: test
host:
  hostname: myhost
`
    const expected = `stack:
  installDir: /opt/test
  projectName: test
  url: "https://example.com:8080/path#fragment"
host:
  hostname: myhost
`
    root = setupProject('', input)
    const config = loadConfig(root)
    updateConfig(root, config, 'stack.url', 'https://example.com:8080/path#fragment')
    expect(readFileSync(join(root, 'stack.yml'), 'utf-8')).toBe(expected)
  })

  it('quotes values that look like YAML booleans', () => {
    const input = `stack:
  installDir: /opt/test
  projectName: test
host:
  hostname: myhost
`
    root = setupProject('', input)
    const config = loadConfig(root)
    updateConfig(root, config, 'stack.flag', 'true')
    const result = readFileSync(join(root, 'stack.yml'), 'utf-8')
    expect(result).toContain('flag: "true"')
  })

  it('quotes empty string values', () => {
    const input = `stack:
  installDir: /opt/test
  projectName: test
host:
  hostname: myhost
`
    root = setupProject('', input)
    const config = loadConfig(root)
    updateConfig(root, config, 'stack.empty', '')
    const result = readFileSync(join(root, 'stack.yml'), 'utf-8')
    expect(result).toContain('empty: ""')
  })

  it('edited file is valid YAML (verified by parsing)', () => {
    root = setupProject('', MINIMAL_STACK)
    const config = loadConfig(root)
    updateConfig(root, config, 'stack.token', 'abc123xyz')

    // If we got here without throwing, the YAML validation passed.
    // Double-check by parsing ourselves:
    const content = readFileSync(join(root, 'stack.yml'), 'utf-8')
    expect(() => yaml.load(content)).not.toThrow()
  })
})

describe('ctx.updateConfig integration', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('ctx.updateConfig mutates ctx.config in place (mirrors deploy.ts wiring)', () => {
    root = setupProject('', MINIMAL_STACK)
    const deployDir = join(root, '.deploy')
    mkdirSync(deployDir, { recursive: true })

    // Build ctx exactly as deploy.ts does — updateConfig reads ctx.config at call time
    const ctx: DeployContext = {
      phase: 'init',
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
      force: false,
      updateConfig(dotPath: string, value: string) {
        updateConfig(root, ctx.config, dotPath, value)
      },
    }

    // Call through ctx.updateConfig (the way plugins do)
    ctx.updateConfig('stack.my_generated_token', 'gen_abc_123')

    // ctx.config is updated in place — no assignment needed
    expect((ctx.config.stack as any).my_generated_token).toBe('gen_abc_123')

    // Persisted to disk
    const raw = readFileSync(join(root, 'stack.yml'), 'utf-8')
    expect(raw).toContain('gen_abc_123')
  })

  it('config changes from ctx.updateConfig are visible to later consumers of ctx.config', () => {
    root = setupProject('', MINIMAL_STACK)
    const deployDir = join(root, '.deploy')
    mkdirSync(deployDir, { recursive: true })

    const ctx: DeployContext = {
      phase: 'init',
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
      force: false,
      updateConfig(dotPath: string, value: string) {
        updateConfig(root, ctx.config, dotPath, value)
      },
    }

    // Simulate plugin A setting a value in pre-stage
    ctx.updateConfig('stack.services.test_service.gatewayToken', 'tok_from_plugin_a')

    // Simulate plugin B reading ctx.config in a later phase
    const laterConfig = ctx.config
    expect((laterConfig.stack as any).services.test_service.gatewayToken).toBe('tok_from_plugin_a')

    // Simulate plugin C reading through a function that receives ctx
    function readFromCtx(c: DeployContext): string {
      return (c.config.stack as any).services.test_service.gatewayToken
    }
    expect(readFromCtx(ctx)).toBe('tok_from_plugin_a')
  })
})

describe('updateConfig: git safety', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('throws when stack.yml is tracked by git', () => {
    root = setupProject('', MINIMAL_STACK)
    // Safe: hardcoded test commands with no user input
    execSync('git init && git add stack.yml && git commit -m init --no-gpg-sign', { cwd: root, stdio: 'pipe' })
    const config = loadConfig(root)

    expect(() => updateConfig(root, config, 'stack.new_key', 'value'))
      .toThrow(/tracked by git/)
  })

  it('does not throw when allowUnsafeGit is set', () => {
    root = setupProject('', MINIMAL_STACK)
    // Safe: hardcoded test commands with no user input
    execSync('git init && git add stack.yml && git commit -m init --no-gpg-sign', { cwd: root, stdio: 'pipe' })
    const config = loadConfig(root)
    config.stackConfig.allowUnsafeGit = true

    expect(() => updateConfig(root, config, 'stack.new_key', 'value'))
      .not.toThrow()
  })
})
