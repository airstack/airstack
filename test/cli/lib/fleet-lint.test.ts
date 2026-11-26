import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { loadFleet, loadMachine, type Issue } from '../../../cli/lib/fleet'
import { lintMachine, parsePortEntry } from '../../../cli/lib/fleet-lint'

const LINT = resolve(import.meta.dirname, '../../fixtures/fleet-lint')
const BASIC = resolve(import.meta.dirname, '../../fixtures/fleet-basic')

async function lint(root: string, name: string): Promise<Issue[]> {
  const fleet = loadFleet(root)
  const m = loadMachine(fleet, name)
  expect(m.issues.filter((i) => i.level === 'fail')).toEqual([])
  return lintMachine(fleet, m)
}
const lines = (issues: Issue[], level: 'fail' | 'warn') =>
  issues.filter((i) => i.level === level).map((i) => `${i.key ?? ''}: ${i.message}`)

describe('parsePortEntry', () => {
  it('reads short and long compose syntax', () => {
    expect(parsePortEntry('8080:80')).toEqual([{ port: 8080, proto: 'tcp', bind: '*' }])
    expect(parsePortEntry('127.0.0.1:8080:80/udp')).toEqual([{ port: 8080, proto: 'udp', bind: '127.0.0.1' }])
    expect(parsePortEntry('[::1]:8080:80')).toEqual([{ port: 8080, proto: 'tcp', bind: '::1' }])
    expect(parsePortEntry('0.0.0.0:7000-7001:7000-7001')).toEqual([
      { port: 7000, proto: 'tcp', bind: '*' },
      { port: 7001, proto: 'tcp', bind: '*' },
    ])
    expect(parsePortEntry('${WEB_PORT:-8088}:80')).toEqual([{ port: 8088, proto: 'tcp', bind: '*' }])
    expect(parsePortEntry({ target: 80, published: '8081', host_ip: 'localhost' })).toEqual([{ port: 8081, proto: 'tcp', bind: '127.0.0.1' }])
  })

  it('skips entries without a fixed host port', () => {
    expect(parsePortEntry(80)).toEqual([])
    expect(parsePortEntry('80')).toEqual([])
    expect(parsePortEntry('127.0.0.1::80')).toEqual([])
    expect(parsePortEntry('${WEB_PORT}:80')).toEqual([])
    expect(parsePortEntry({ target: 80 })).toEqual([])
  })
})

describe('lintMachine', () => {
  it('is clean when binds do not overlap and tailscale names published ports', async () => {
    expect(await lint(LINT, 'clean')).toEqual([])
  })

  it('is clean on fleet-basic (tailscale 8317 is the cliproxy port)', async () => {
    expect(await lint(BASIC, 'airstack-test1')).toEqual([])
    expect(await lint(BASIC, 'ops2')).toEqual([])
  })

  it('fails on host port collisions (stacks, built-in host-network port, sshd)', async () => {
    const issues = await lint(LINT, 'ports')
    expect(lines(issues, 'fail')).toEqual([
      'stacks.web-b: service web: host port 127.0.0.1:8081 is already used by stacks.web-a (service web). Use another port.',
      'stacks.web-c: service web: host port 127.0.0.1:8317 is already used by stacks.cliproxy (service cli-proxy-api). Use another port.',
      'stacks.web-e: service web: host port 222 is already used by sshd (host.ssh.port). Use another port.',
    ])
  })

  it('warns when tailscale names a port nothing publishes (never a collision)', async () => {
    const warns = lines(await lint(LINT, 'ports'), 'warn')
    expect(warns).toHaveLength(3)
    expect(warns[0]).toMatch(/^plugins\.airstack\/tailscale\.ports: no stack on this machine publishes port 9999\./)
    expect(warns[1]).toMatch(/port 8090 is published on loopback only \(stacks\.web-d, service web\)/)
    expect(warns[2]).toMatch(/^plugins\.airstack\/tailscale\.serve: serve port 4000 forwards to 127\.0\.0\.1:4000, but no airstack stack/)
  })

  it('fails on rootless stacks that join the shared network or publish a low port', async () => {
    const issues = await lint(LINT, 'rootless')
    const fails = lines(issues, 'fail')
    expect(fails).toHaveLength(3)
    expect(fails[0]).toMatch(/^stacks\.shared: the compose file joins the shared 'airstack' network, but this stack runs in devuser's rootless Docker\./)
    expect(fails[1]).toMatch(/^stacks\.web: service web publishes host port 80, but devuser's rootless Docker cannot bind ports below 1024\./)
    expect(fails[2]).toMatch(/^stacks\.shared-root: network 'stack-net' uses the name 'airstack' without external: true\./)
    expect(lines(issues, 'warn')).toEqual([
      expect.stringMatching(/^stacks\.cliproxy: service cli-proxy-api uses network_mode: host, but devuser's rootless Docker has its own host network/),
    ])
  })

  it('warns when a host-network service also lists ports', async () => {
    expect(lines(await lint(LINT, 'hostnet'), 'warn')).toEqual([
      'stacks.hostnet: service app uses network_mode: host and also lists ports. Docker ignores these ports. Remove ports, or remove network_mode: host.',
    ])
  })

  it('fails on shared compose projects and shared or nested install dirs', async () => {
    expect(lines(await lint(LINT, 'dupes'), 'fail')).toEqual([
      "stacks.web-b.composeProject: compose project 'web-a' is already used by stacks.web-a. Use another composeProject.",
      "stacks.web-b.installDir: install dir /srv/airstack/stacks/web-a is already used by stacks.web-a. Deploy can delete the other stack's files. Use a separate installDir.",
      "stacks.web-c.composeProject: compose project 'airstack' is the machine project. Use another composeProject.",
      "stacks.web-c.installDir: install dir /srv/airstack/stacks/web-a/sub is inside the install dir of stacks.web-a. Deploy can delete the other stack's files. Use a separate installDir.",
    ])
  })
})
