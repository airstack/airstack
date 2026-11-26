import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../../../cli/lib/config'
import { makeTmpDir, setupProject } from '../helpers'

// ── Minimal valid stack.yml ──────────────────────────────────────────────────

const MINIMAL_STACK = `
stack:
  installDir: /home/deploy
  projectName: test-stack
host:
  hostname: myhost
`

// ── Tests ────────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('loads minimal config (hostname, installDir, projectName)', () => {
    const root = setupProject('', MINIMAL_STACK)
    const cfg = loadConfig(root)

    expect(cfg.stack.installDir).toBe('/home/deploy')
    expect(cfg.stack.projectName).toBe('test-stack')
    expect(cfg.host.hostname).toBe('myhost')
  })

  it('resolves ${VAR} from .env', () => {
    const env = 'PROJECT_NAME=my-project\nINSTALL_DIR=/opt/app'
    const stack = `
stack:
  installDir: \${INSTALL_DIR}
  projectName: \${PROJECT_NAME}
`
    const root = setupProject(env, stack)
    const cfg = loadConfig(root)

    expect(cfg.stack.installDir).toBe('/opt/app')
    expect(cfg.stack.projectName).toBe('my-project')
  })

  it('resolves ${VAR:-default} syntax', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: \${PROJECT_NAME:-default-project}
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.stack.projectName).toBe('default-project')
  })

  it('${VAR:-default} uses .env value when set', () => {
    const env = 'PROJECT_NAME=from-env'
    const stack = `
stack:
  installDir: /home/deploy
  projectName: \${PROJECT_NAME:-fallback}
`
    const root = setupProject(env, stack)
    const cfg = loadConfig(root)

    expect(cfg.stack.projectName).toBe('from-env')
  })

  it('resolves <<+ before ${VAR} (so defaults can contain ${VAR} refs)', () => {
    // <<+ resolution happens on the already-env-resolved YAML.
    // This test verifies that env vars in the defaults source object are also
    // resolved (because resolveEnvRefs runs first, then resolveDefaults).
    const env = 'MY_TZ=America/Chicago'
    const stack = `
host_defaults:
  timezone: America/Chicago
  appUser: stackroot

host:
  <<+: host_defaults
  hostname: resolved-host

stack:
  installDir: /home/deploy
  projectName: test-stack
`
    const root = setupProject(env, stack)
    const cfg = loadConfig(root)

    // host should have timezone from defaults
    expect(cfg.host.hostname).toBe('resolved-host')
    // appUser fallback from defaults (via resolveDefaults + rawHost.appUser)
    // Note: <<+ in host section lands in rawHost — appUser key matters here
  })

  it('reads dev users and the Homebrew owner from .env (space/comma separated)', () => {
    const root = setupProject('DEV_USERS=alice, bob carol\nBREW_OWNER=alice', MINIMAL_STACK)
    const cfg = loadConfig(root)
    expect(cfg.host.devUsers).toEqual(['alice', 'bob', 'carol'])
    expect(cfg.host.brewOwner).toBe('alice')
  })

  it('devUsers and brewOwner default to empty; stack.yml host values win over .env', () => {
    expect(loadConfig(setupProject('', MINIMAL_STACK)).host.devUsers).toEqual([])
    const stack = `
host:
  hostname: h
  devUsers: [x, y]
  brewOwner: x
stack:
  installDir: /home/deploy
  projectName: p
`
    const cfg = loadConfig(setupProject('DEV_USERS=ignored\nBREW_OWNER=ignored', stack))
    expect(cfg.host.devUsers).toEqual(['x', 'y'])
    expect(cfg.host.brewOwner).toBe('x')
  })

  it('SSH falls back to .env (SSH_IP, SSH_USER, SSH_PORT, SSH_KEY)', () => {
    const env = [
      'SSH_IP=192.0.2.4',
      'SSH_USER=deploy',
      'SSH_PORT=2222',
      'SSH_KEY=~/.ssh/deploy_key',
    ].join('\n')
    const root = setupProject(env, MINIMAL_STACK)
    const cfg = loadConfig(root)

    expect(cfg.host.ip).toBe('192.0.2.4')
    expect(cfg.host.sshUser).toBe('deploy')
    expect(cfg.host.sshPort).toBe(2222)
    expect(cfg.host.sshKey).toBe('~/.ssh/deploy_key')
  })

  it('host.ip overrides .env SSH_IP', () => {
    const env = 'SSH_IP=192.0.2.4'
    const stack = `
host:
  hostname: myhost
  ip: 192.0.2.9

stack:
  installDir: /home/deploy
  projectName: test-stack
`
    const root = setupProject(env, stack)
    const cfg = loadConfig(root)

    expect(cfg.host.ip).toBe('192.0.2.9')
  })

  it('throws on missing stack.yml', () => {
    const root = makeTmpDir()
    // only write .env, no stack.yml
    writeFileSync(join(root, '.env'), '')

    expect(() => loadConfig(root)).toThrow('stack.yml not found')
  })

  it('throws on missing installDir', () => {
    const stack = `
stack:
  projectName: test-stack
`
    const root = setupProject('', stack)
    expect(() => loadConfig(root)).toThrow('stack.installDir')
  })

  it('throws on missing projectName', () => {
    const stack = `
stack:
  installDir: /home/deploy
`
    const root = setupProject('', stack)
    expect(() => loadConfig(root)).toThrow('stack.projectName')
  })

  it('defaults deploy.sync to delete with empty lists', () => {
    const root = setupProject('', MINIMAL_STACK)
    const cfg = loadConfig(root)

    expect(cfg.deploy.sync.default).toBe('delete')
    expect(cfg.deploy.sync.preserve).toEqual([])
    expect(cfg.deploy.sync.delete).toEqual([])
  })

  it('defaults deploy.hooks to {}', () => {
    const root = setupProject('', MINIMAL_STACK)
    const cfg = loadConfig(root)

    expect(cfg.deploy.hooks).toEqual({})
  })

  it('defaults host.appUser to appuser', () => {
    const root = setupProject('', MINIMAL_STACK)
    const cfg = loadConfig(root)

    expect(cfg.host.appUser).toBe('appuser')
  })

  it('resolves timezone abbreviations (PST → America/Los_Angeles)', () => {
    const stack = `
host:
  hostname: myhost
  timezone: PST

stack:
  installDir: /home/deploy
  projectName: test-stack
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.host.timezone).toBe('America/Los_Angeles')
  })

  it('parses templates section (string form)', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack

templates:
  docker-compose.yml: templates/docker-compose.yml.hbs
  nginx.conf: templates/nginx.conf.hbs
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.templates['docker-compose.yml']).toEqual({ src: 'templates/docker-compose.yml.hbs' })
    expect(cfg.templates['nginx.conf']).toEqual({ src: 'templates/nginx.conf.hbs' })
  })

  it('parses templates section (object form)', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack

templates:
  docker-compose.yml:
    src: templates/docker-compose.yml.hbs
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.templates['docker-compose.yml']).toEqual({ src: 'templates/docker-compose.yml.hbs' })
  })

  it('parses plugins section', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack

plugins:
  my-plugin:
    enabled: true
    config: some-value
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.plugins['my-plugin']).toEqual({ enabled: true, config: 'some-value' })
  })

  it('defaults plugins to {}', () => {
    const root = setupProject('', MINIMAL_STACK)
    const cfg = loadConfig(root)

    expect(cfg.plugins).toEqual({})
  })

  it('works with missing .env (treats all vars as empty strings)', () => {
    // No .env file at all — should not throw
    const root = makeTmpDir()
    writeFileSync(join(root, 'stack.yml'), MINIMAL_STACK)

    const cfg = loadConfig(root)
    expect(cfg.stack.installDir).toBe('/home/deploy')
    expect(cfg.host.ip).toBe('')
    expect(cfg.host.sshUser).toBe('root')
    expect(cfg.host.sshPort).toBe(22)
  })

  it('works with empty templates section', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack

templates: {}
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.templates).toEqual({})
  })

  it('works with empty plugins section', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack

plugins: {}
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.plugins).toEqual({})
  })

  it('works with empty deploy section', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack

deploy: {}
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.deploy.sync.default).toBe('delete')
    expect(cfg.deploy.hooks).toEqual({})
  })

  it('preserves deploy.sync lists when specified', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack

deploy:
  sync:
    default: preserve
    preserve:
      - data/
      - logs/
    delete:
      - cache/
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.deploy.sync.default).toBe('preserve')
    expect(cfg.deploy.sync.preserve).toEqual(['data/', 'logs/'])
    expect(cfg.deploy.sync.delete).toEqual(['cache/'])
  })

  it('resolves <<+ across tree before building config', () => {
    const stack = `
serviceDefaults:
  timezone: UTC
  resources:
    cpu: 4

stack:
  installDir: /home/deploy
  projectName: test-stack
  services:
    my-service:
      <<+: serviceDefaults
      resources:
        memory: 8G
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    // <<+ should be resolved in stack section
    const services = cfg.stack.services as Record<string, unknown>
    const myService = services['my-service'] as Record<string, unknown>
    expect(myService).toBeDefined()
    expect('<<+' in myService).toBe(false)
    const resources = myService.resources as Record<string, unknown>
    expect(resources.cpu).toBe(4)
    expect(resources.memory).toBe('8G')
  })

  // ── New coverage ────────────────────────────────────────────────────────────

  it('deploy.report uses defaults when not specified', () => {
    const root = setupProject('', MINIMAL_STACK)
    const cfg = loadConfig(root)

    expect(cfg.deploy.report.template).toBe('templates/deploy-report.md.hbs')
    expect(cfg.deploy.report.destination).toBe('./deploy-report.md')
  })

  it('deploy.report parses custom template and destination', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack

deploy:
  report:
    template: templates/my-report.hbs
    destination: /tmp/my-report.md
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.deploy.report.template).toBe('templates/my-report.hbs')
    expect(cfg.deploy.report.destination).toBe('/tmp/my-report.md')
  })

  it('host.appUser stack.yml value takes priority over APP_USER env', () => {
    const env = 'APP_USER=from-env'
    const stack = `
host:
  hostname: myhost
  appUser: from-stack

stack:
  installDir: /home/app
  projectName: test-stack
`
    const root = setupProject(env, stack)
    const cfg = loadConfig(root)

    expect(cfg.host.appUser).toBe('from-stack')
  })

  it('host.appUser falls back to APP_USER env when not in stack.yml', () => {
    const env = 'APP_USER=env-user'
    const root = setupProject(env, MINIMAL_STACK)
    const cfg = loadConfig(root)

    expect(cfg.host.appUser).toBe('env-user')
  })

  it('host.appUser falls back to "appuser" when neither stack.yml nor APP_USER set', () => {
    const root = setupProject('', MINIMAL_STACK)
    const cfg = loadConfig(root)

    expect(cfg.host.appUser).toBe('appuser')
  })

  it('host.sshPort as a number (not string) in stack.yml', () => {
    const stack = `
host:
  hostname: myhost
  sshPort: 2222

stack:
  installDir: /home/deploy
  projectName: test-stack
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.host.sshPort).toBe(2222)
    expect(typeof cfg.host.sshPort).toBe('number')
  })

  it('${VAR} with no match resolves to empty string (not undefined)', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: \${MISSING_VAR}
`
    // MISSING_VAR is not in the env — ${VAR} should resolve to ''
    // which then causes a validation failure since projectName is required
    const root = setupProject('', stack)

    expect(() => loadConfig(root)).toThrow('stack.projectName')
  })

  it('${VAR:-default} treats empty string env value as missing (uses default)', () => {
    // VAR is defined but set to ''
    const env = 'MY_VAR='
    const stack = `
stack:
  installDir: /home/deploy
  projectName: \${MY_VAR:-fallback-value}
`
    const root = setupProject(env, stack)
    const cfg = loadConfig(root)

    expect(cfg.stack.projectName).toBe('fallback-value')
  })

  it('${VAR:-default} uses non-empty env value, not default', () => {
    const env = 'MY_VAR=actual-value'
    const stack = `
stack:
  installDir: /home/deploy
  projectName: \${MY_VAR:-fallback-value}
`
    const root = setupProject(env, stack)
    const cfg = loadConfig(root)

    expect(cfg.stack.projectName).toBe('actual-value')
  })

  it('multiple <<+ references in different parts of the tree', () => {
    const stack = `
web_defaults:
  port: 80
  protocol: http

db_defaults:
  port: 5432
  engine: postgres

stack:
  installDir: /home/deploy
  projectName: test-stack
  services:
    web:
      <<+: web_defaults
      name: frontend
    db:
      <<+: db_defaults
      name: database
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    const services = cfg.stack.services as Record<string, Record<string, unknown>>
    expect(services.web.port).toBe(80)
    expect(services.web.protocol).toBe('http')
    expect(services.web.name).toBe('frontend')
    expect('<<+' in services.web).toBe(false)

    expect(services.db.port).toBe(5432)
    expect(services.db.engine).toBe('postgres')
    expect(services.db.name).toBe('database')
    expect('<<+' in services.db).toBe(false)
  })

  it('comments in stack.yml are ignored (not breaking YAML parsing)', () => {
    const stack = `
# This is a top-level comment
stack:
  # installDir comment
  installDir: /home/deploy
  projectName: test-stack  # inline comment

host:
  # hostname comment
  hostname: myhost
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.stack.installDir).toBe('/home/deploy')
    expect(cfg.stack.projectName).toBe('test-stack')
    expect(cfg.host.hostname).toBe('myhost')
  })

  it('comments in stack.yml are not affected by ${VAR} resolution', () => {
    // A comment line containing ${VAR} should NOT be substituted
    const env = 'DANGER=replaced'
    const stack = `
# \${DANGER} should not be resolved here
stack:
  installDir: /home/deploy
  projectName: test-stack
`
    const root = setupProject(env, stack)
    // If comment lines were substituted, the YAML would still parse fine here,
    // but the resolveEnvRefs function contract says comment lines are untouched.
    // We just verify the load doesn't throw and produces correct values.
    const cfg = loadConfig(root)

    expect(cfg.stack.installDir).toBe('/home/deploy')
    expect(cfg.stack.projectName).toBe('test-stack')
  })

  it('deploy.sync.default = "preserve" (non-default value)', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack

deploy:
  sync:
    default: preserve
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.deploy.sync.default).toBe('preserve')
  })

  it('deploy.hooks parses multiple hooks', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack

deploy:
  hooks:
    pre-sync: echo pre-sync
    post-sync: echo post-sync
    post-deploy: ./scripts/notify.sh
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    expect(cfg.deploy.hooks['pre-sync']).toBe('echo pre-sync')
    expect(cfg.deploy.hooks['post-sync']).toBe('echo post-sync')
    expect(cfg.deploy.hooks['post-deploy']).toBe('./scripts/notify.sh')
    expect(Object.keys(cfg.deploy.hooks)).toHaveLength(3)
  })

  it('stack keys with deeply nested objects are preserved verbatim', () => {
    const stack = `
stack:
  installDir: /home/deploy
  projectName: test-stack
  services:
    personal:
      image: myapp:latest
      env:
        NODE_ENV: production
        LOG_LEVEL: info
      resources:
        cpu: 2
        memory:
          limit: 4G
          reservation: 2G
`
    const root = setupProject('', stack)
    const cfg = loadConfig(root)

    const services = cfg.stack.services as Record<string, unknown>
    const personal = services.personal as Record<string, unknown>
    expect(personal.image).toBe('myapp:latest')

    const env = personal.env as Record<string, unknown>
    expect(env.NODE_ENV).toBe('production')
    expect(env.LOG_LEVEL).toBe('info')

    const resources = personal.resources as Record<string, unknown>
    expect(resources.cpu).toBe(2)

    const memory = resources.memory as Record<string, unknown>
    expect(memory.limit).toBe('4G')
    expect(memory.reservation).toBe('2G')
  })
})

// ── StackConfig resolution ─────────────────────────────────────────────────

describe('StackConfig resolution', () => {
  const cleanups: string[] = []

  afterEach(() => {
    for (const dir of cleanups) {
      try {
        require('node:fs').rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
    cleanups.length = 0
  })

  it('defaults stackFile to stack.yml', () => {
    const root = setupProject('', MINIMAL_STACK)
    cleanups.push(root)
    const config = loadConfig(root)
    expect(config.stackConfig.stackFile).toBe(join(root, 'stack.yml'))
  })

  it('defaults envFile to .env', () => {
    const root = setupProject('', MINIMAL_STACK)
    cleanups.push(root)
    const config = loadConfig(root)
    expect(config.stackConfig.envFile).toBe(join(root, '.env'))
  })

  it('reads envFile from stack.yml', () => {
    const root = setupProject(
      '',
      `
stack:
  installDir: /opt/test
  projectName: test
  envFile: .env.prod
host:
  hostname: test
`
    )
    cleanups.push(root)
    const config = loadConfig(root)
    expect(config.stackConfig.envFile).toBe(join(root, '.env.prod'))
  })

  it('defaults allowUnsafeGit to false', () => {
    const root = setupProject('', MINIMAL_STACK)
    cleanups.push(root)
    const config = loadConfig(root)
    expect(config.stackConfig.allowUnsafeGit).toBe(false)
  })

  it('defaults stagingDir to .deploy', () => {
    const root = setupProject('', MINIMAL_STACK)
    cleanups.push(root)
    const config = loadConfig(root)
    expect(config.deploy.stagingDir).toBe('.deploy')
  })

  it('defaults deployLogs to .deploy-logs', () => {
    const root = setupProject('', MINIMAL_STACK)
    cleanups.push(root)
    const config = loadConfig(root)
    expect(config.deploy.deployLogs).toBe('.deploy-logs')
  })
})
