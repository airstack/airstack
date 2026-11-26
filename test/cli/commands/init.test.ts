import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fleetNameFor, initCommand, initFleet } from '../../../cli/commands/init.js'
import { VERSION } from '../../../cli/lib/core.js'
import { loadFleet, loadMachine } from '../../../cli/lib/fleet.js'
import { EXIT, Output } from '../../../cli/lib/output.js'

const CLI = resolve(import.meta.dirname, '../../../cli/index.ts')
const quiet = () => new Output(() => {})
const mode = (p: string) => statSync(p).mode & 0o777

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'airstack-init-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('airstack init', () => {
  it('creates the skeleton with the right modes', () => {
    const dir = join(tmp, 'my-fleet')
    const out = quiet()
    expect(initFleet(dir, out, tmp)).toBe(EXIT.OK)
    for (const f of ['airstack.yaml', '.gitignore', 'machines/web-1.yaml.example', 'stacks/README.md', 'plugins/README.md', 'templates/README.md', '.airstack/secrets/_fleet.jsonc']) {
      expect(existsSync(join(dir, f)), f).toBe(true)
    }
    expect(readFileSync(join(dir, 'airstack.yaml'), 'utf8')).toContain(`version: ${VERSION}`)
    expect(readFileSync(join(dir, 'airstack.yaml'), 'utf8')).toContain('name: my-fleet')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/^\.airstack\/$/m)
    expect(mode(join(dir, '.airstack/secrets/_fleet.jsonc'))).toBe(0o600)
    expect(mode(join(dir, '.airstack'))).toBe(0o700)
    expect(mode(join(dir, '.airstack/secrets'))).toBe(0o700)
    expect(out.lines.some((l) => l.includes('created my-fleet/airstack.yaml'))).toBe(true)
    expect(out.lines.some((l) => /^->\s+git init$/.test(l))).toBe(true) // tmp is not a git repo
    expect(out.lines.some((l) => /^->\s+airstack fleet check$/.test(l))).toBe(true)
    expect(out.lines.some((l) => l.includes('airstack deploy web-1 --install'))).toBe(true)
  })

  it('refuses a second run (exit 3) and changes nothing', () => {
    const dir = join(tmp, 'f')
    initFleet(dir, quiet(), tmp)
    writeFileSync(join(dir, 'airstack.yaml'), 'fleet: { name: mine }\n')
    const out = quiet()
    expect(initFleet(dir, out, tmp)).toBe(EXIT.USAGE)
    expect(out.lines[0]).toMatch(/^fail\s+blocked: f\/airstack\.yaml already exists/)
    expect(readFileSync(join(dir, 'airstack.yaml'), 'utf8')).toBe('fleet: { name: mine }\n')
  })

  it('never overwrites existing files; appends .airstack/ to an existing .gitignore', () => {
    const dir = join(tmp, 'existing')
    mkdirSync(join(dir, 'stacks'), { recursive: true })
    writeFileSync(join(dir, 'stacks/README.md'), 'mine\n')
    writeFileSync(join(dir, '.gitignore'), 'node_modules/')
    const out = quiet()
    expect(initFleet(dir, out, tmp)).toBe(EXIT.WARN)
    expect(readFileSync(join(dir, 'stacks/README.md'), 'utf8')).toBe('mine\n')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/^node_modules\/\n[\s\S]*^\.airstack\/$/m)
    expect(out.lines.some((l) => l.includes('kept existing/stacks/README.md'))).toBe(true)
  })

  it('the new fleet loads with no fail issues, also after copying the example machine', () => {
    const dir = join(tmp, 'f')
    initFleet(dir, quiet(), tmp)
    let fleet = loadFleet(dir)
    expect(fleet.issues.filter((i) => i.level === 'fail')).toEqual([])
    expect(fleet.machines).toEqual([]) // the .example file is not a machine
    copyFileSync(join(dir, 'machines/web-1.yaml.example'), join(dir, 'machines/web-1.yaml'))
    fleet = loadFleet(dir)
    expect(fleet.issues.filter((i) => i.level === 'fail')).toEqual([])
    const m = loadMachine(fleet, 'web-1')
    expect(m.issues.filter((i) => i.level === 'fail')).toEqual([])
    expect(m.host.ip).toBe('192.0.2.10')
  })

  it('parses arguments', () => {
    expect(initCommand(['--bogus'], quiet(), tmp)).toBe(EXIT.USAGE)
    expect(initCommand(['a', 'b'], quiet(), tmp)).toBe(EXIT.USAGE)
    expect(initCommand(['--help'], quiet(), tmp)).toBe(EXIT.OK)
    expect(initCommand([], quiet(), tmp)).toBe(EXIT.OK)
    expect(existsSync(join(tmp, 'airstack.yaml'))).toBe(true)
  })

  it('names the fleet after the directory', () => {
    expect(fleetNameFor('/x/My Fleet_2')).toBe('my-fleet-2')
    expect(fleetNameFor('/x/2026')).toBe('fleet-2026')
  })

  it('is registered in the CLI and needs no fleet', () => {
    const r = spawnSync('bun', [CLI, 'init', 'new'], { cwd: tmp, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('ok   created new/airstack.yaml')
    const again = spawnSync('bun', [CLI, 'init', 'new'], { cwd: tmp, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
    expect(again.status).toBe(3)
  })
})
