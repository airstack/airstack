import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { processTemplates } from '../../../cli/lib/template-engine'

function makeTmpDir(prefix = 'tmpl-test'): string {
  const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('processTemplates', () => {
  let projectRoot: string
  let deployDir: string
  let sharedDir: string

  beforeEach(() => {
    projectRoot = makeTmpDir('project')
    deployDir = makeTmpDir('deploy')
    sharedDir = makeTmpDir('shared')
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(deployDir, { recursive: true, force: true })
    rmSync(sharedDir, { recursive: true, force: true })
  })

  it('renders .hbs template with config context', () => {
    const tmplDir = join(projectRoot, 'templates')
    mkdirSync(tmplDir, { recursive: true })
    writeFileSync(join(tmplDir, 'config.hbs'), 'project: {{stack.projectName}}')

    const context = { stack: { projectName: 'my-project' } }
    processTemplates(
      { 'config.txt': { src: 'templates/config.hbs' } },
      context,
      projectRoot,
      [],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'config.txt'), 'utf8')
    expect(out).toBe('project: my-project')
  })

  it('copies non-.hbs files as-is', () => {
    writeFileSync(join(projectRoot, 'script.sh'), '#!/bin/bash\necho hello')

    processTemplates(
      { 'script.sh': { src: 'script.sh' } },
      {},
      projectRoot,
      [],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'script.sh'), 'utf8')
    expect(out).toBe('#!/bin/bash\necho hello')
  })

  it('creates nested destination directories', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(projectRoot, 'templates', 'nginx.hbs'), 'server_name {{host}};')

    processTemplates(
      { 'conf/nginx/nginx.conf': { src: 'templates/nginx.hbs' } },
      { host: 'example.com' },
      projectRoot,
      [],
      deployDir,
    )

    const outPath = join(deployDir, 'conf', 'nginx', 'nginx.conf')
    expect(existsSync(outPath)).toBe(true)
    expect(readFileSync(outPath, 'utf8')).toBe('server_name example.com;')
  })

  it('resolves source file from sharedPaths when not in projectRoot', () => {
    mkdirSync(join(sharedDir, 'templates'), { recursive: true })
    writeFileSync(join(sharedDir, 'templates', 'shared.hbs'), 'value: {{val}}')

    processTemplates(
      { 'out.txt': { src: 'templates/shared.hbs' } },
      { val: 'from-shared' },
      projectRoot,
      [sharedDir],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'out.txt'), 'utf8')
    expect(out).toBe('value: from-shared')
  })

  it('pushes error for missing source file and does not throw', () => {
    const errors: string[] = []

    expect(() =>
      processTemplates(
        { 'out.txt': { src: 'missing/file.hbs' } },
        {},
        projectRoot,
        [],
        deployDir,
        errors,
      )
    ).not.toThrow()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/not found/i)
  })

  it('renders destination path with {{}} expressions', () => {
    writeFileSync(join(projectRoot, 'setup.sh'), 'setup content')

    processTemplates(
      { 'services/{{service_name}}/setup.sh': { src: 'setup.sh' } },
      { service_name: 'my-service' },
      projectRoot,
      [],
      deployDir,
    )

    const outPath = join(deployDir, 'services', 'my-service', 'setup.sh')
    expect(existsSync(outPath)).toBe(true)
    expect(readFileSync(outPath, 'utf8')).toBe('setup content')
  })

  it('does not render {{}} content of non-.hbs files', () => {
    writeFileSync(join(projectRoot, 'raw.sh'), 'echo {{this_is_not_rendered}}')

    processTemplates(
      { 'raw.sh': { src: 'raw.sh' } },
      { this_is_not_rendered: 'SHOULD_NOT_APPEAR' },
      projectRoot,
      [],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'raw.sh'), 'utf8')
    expect(out).toBe('echo {{this_is_not_rendered}}')
    expect(out).not.toContain('SHOULD_NOT_APPEAR')
  })

  it('uses noEscape for Handlebars (does not HTML-escape special chars)', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'templates', 'script.hbs'),
      'TOKEN={{token}}\nURL={{url}}',
    )

    processTemplates(
      { 'script.sh': { src: 'templates/script.hbs' } },
      { token: 'abc&def', url: 'http://host/path?a=1&b=2' },
      projectRoot,
      [],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'script.sh'), 'utf8')
    expect(out).toBe('TOKEN=abc&def\nURL=http://host/path?a=1&b=2')
    expect(out).not.toContain('&amp;')
  })

  it('processes multiple templates in one call', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(projectRoot, 'templates', 'a.hbs'), 'A={{val}}')
    writeFileSync(join(projectRoot, 'templates', 'b.hbs'), 'B={{val}}')

    processTemplates(
      {
        'a.txt': { src: 'templates/a.hbs' },
        'b.txt': { src: 'templates/b.hbs' },
      },
      { val: 'hello' },
      projectRoot,
      [],
      deployDir,
    )

    expect(readFileSync(join(deployDir, 'a.txt'), 'utf8')).toBe('A=hello')
    expect(readFileSync(join(deployDir, 'b.txt'), 'utf8')).toBe('B=hello')
  })

  it('collects multiple errors without stopping processing', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(projectRoot, 'templates', 'good.hbs'), 'ok={{val}}')

    const errors: string[] = []
    processTemplates(
      {
        'missing1.txt': { src: 'gone/one.hbs' },
        'good.txt': { src: 'templates/good.hbs' },
        'missing2.txt': { src: 'gone/two.hbs' },
      },
      { val: 'yes' },
      projectRoot,
      [],
      deployDir,
      errors,
    )

    expect(errors).toHaveLength(2)
    expect(readFileSync(join(deployDir, 'good.txt'), 'utf8')).toBe('ok=yes')
  })

  it('renders {{#each}} loops correctly', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'templates', 'list.hbs'),
      '{{#each items}}- {{this}}\n{{/each}}',
    )

    processTemplates(
      { 'list.txt': { src: 'templates/list.hbs' } },
      { items: ['alpha', 'beta', 'gamma'] },
      projectRoot,
      [],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'list.txt'), 'utf8')
    expect(out).toContain('- alpha')
    expect(out).toContain('- beta')
    expect(out).toContain('- gamma')
  })

  it('renders {{#each}} loops over objects using @key and this', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'templates', 'env.hbs'),
      '{{#each vars}}{{@key}}={{this}}\n{{/each}}',
    )

    processTemplates(
      { 'env.txt': { src: 'templates/env.hbs' } },
      { vars: { HOST: 'localhost', PORT: '8080' } },
      projectRoot,
      [],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'env.txt'), 'utf8')
    expect(out).toContain('HOST=localhost')
    expect(out).toContain('PORT=8080')
  })

  it('renders {{#if}} conditionals (truthy branch)', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'templates', 'cond.hbs'),
      '{{#if enabled}}enabled=true{{else}}enabled=false{{/if}}',
    )

    processTemplates(
      { 'cond.txt': { src: 'templates/cond.hbs' } },
      { enabled: true },
      projectRoot,
      [],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'cond.txt'), 'utf8')
    expect(out).toBe('enabled=true')
  })

  it('renders {{#if}} conditionals (falsy branch)', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'templates', 'cond.hbs'),
      '{{#if enabled}}enabled=true{{else}}enabled=false{{/if}}',
    )

    processTemplates(
      { 'cond.txt': { src: 'templates/cond.hbs' } },
      { enabled: false },
      projectRoot,
      [],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'cond.txt'), 'utf8')
    expect(out).toBe('enabled=false')
  })

  it('accesses deeply nested context values (a.b.c)', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'templates', 'deep.hbs'),
      'token={{egressProxy.auth.token}} port={{egressProxy.port}}',
    )

    processTemplates(
      { 'deep.txt': { src: 'templates/deep.hbs' } },
      { egressProxy: { auth: { token: 'secret123' }, port: '3128' } },
      projectRoot,
      [],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'deep.txt'), 'utf8')
    expect(out).toBe('token=secret123 port=3128')
  })

  it('renders empty template content as empty output', () => {
    mkdirSync(join(projectRoot, 'templates'), { recursive: true })
    writeFileSync(join(projectRoot, 'templates', 'empty.hbs'), '')

    processTemplates(
      { 'empty.txt': { src: 'templates/empty.hbs' } },
      { anything: 'value' },
      projectRoot,
      [],
      deployDir,
    )

    const out = readFileSync(join(deployDir, 'empty.txt'), 'utf8')
    expect(out).toBe('')
  })
})
