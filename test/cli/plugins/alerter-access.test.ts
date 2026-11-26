// host_alerter.sh access guard block (access.onScan): run the marked block alone with a fake
// host_security.sh and a fake docker on PATH.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDir } from '../helpers'

const ALERTER = join(__dirname, '../../../cli/plugins/cron/deploy/host-status/host_alerter.sh')
const STACKS = join(__dirname, '../../../cli/plugins/cron/deploy/lib/stacks.sh')

describe('host_alerter.sh access guard (onScan)', () => {
  let root: string
  beforeEach(() => {
    root = makeTmpDir('alerter-access')
    mkdirSync(join(root, 'manifests'))
    mkdirSync(join(root, 'bin'))
    mkdirSync(join(root, 'state'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function setup(onScan: string, accessOut: string, running = 'true') {
    writeFileSync(join(root, 'manifests', 'airstack.env'), `INSTALL_DIR=/srv/airstack/machine\nCF_CONTAINER=airstack-cloudflared\nCF_ACCESS_ON_SCAN=${onScan}\n`)
    writeFileSync(join(root, 'manifests', 'web.env'), 'INSTALL_DIR=/srv/airstack/stacks/web\n')
    writeFileSync(join(root, 'sec.sh'), `printf '%s\\n' ${accessOut}`)
    // Fake docker: logs every call; inspect answers $RUNNING.
    writeFileSync(join(root, 'bin', 'docker'), `#!/bin/bash\necho "$*" >> "${root}/docker.log"\n[[ "$1" == inspect ]] && echo "${running}"\nexit 0\n`)
    chmodSync(join(root, 'bin', 'docker'), 0o755)
  }

  function run(): string[] {
    const src = readFileSync(ALERTER, 'utf-8')
    const block = src.slice(src.indexOf('# >>> access-guard'), src.indexOf('# <<< access-guard'))
    writeFileSync(join(root, 'block.sh'), block)
    const out = execFileSync('bash', ['-c', `set -euo pipefail; source "${STACKS}"; source "${join(root, 'block.sh')}"; alerts=(); access_alerts; printf '%s\\n' \${alerts[@]+"\${alerts[@]}"}`], {
      env: {
        PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
        INSTALL_DIR: root, STATE_DIR: join(root, 'state'),
        STACKS_MANIFEST_DIR: join(root, 'manifests'), SECURITY_SCRIPT: join(root, 'sec.sh'),
      },
      encoding: 'utf-8',
    })
    return out.split('\n').filter(Boolean)
  }
  const docker = () => (existsSync(join(root, 'docker.log')) ? readFileSync(join(root, 'docker.log'), 'utf-8') : '')
  const FAIL = `'FAIL|access|app.example.com: PUBLIC, reachable without Cloudflare Access (HTTP 200 → http://localhost:8317; onScan: stop)'`

  it('alert: a FAIL becomes an alert and nothing is stopped', () => {
    setup('alert', FAIL)
    expect(run()).toEqual(['Cloudflare Access: app.example.com: PUBLIC, reachable without Cloudflare Access (HTTP 200 → http://localhost:8317; onScan: stop)'])
    expect(docker()).toBe('')
  })

  it('stop: stops the container, writes the flag, alerts once with steady text', () => {
    setup('stop', FAIL)
    const first = run()
    expect(docker()).toContain('stop airstack-cloudflared')
    expect(first).toEqual(['🛑 Cloudflare tunnel stopped by the Access guard: app.example.com: PUBLIC, reachable without Cloudflare Access. Protect the route, then deploy again.'])
    // Next run: the container is down, the check cannot read routes; the alert text stays the same.
    setup('stop', `'WARN|access|cannot read the tunnel routes'`, 'false')
    expect(run()).toEqual(first)
  })

  it('stop: the flag clears once a deploy starts the container again', () => {
    setup('stop', FAIL)
    run()
    setup('stop', `'OK|access|app.example.com is protected'`, 'true')
    expect(run()).toEqual([])
    expect(existsSync(join(root, 'state', 'host-health', 'access-stopped'))).toBe(false)
  })

  it('WARN lines alert as unverified and never stop the tunnel', () => {
    setup('stop', `'WARN|access|app.example.com: could not verify Cloudflare Access (HTTP 530)'`)
    expect(run()).toEqual(['Cloudflare Access (unverified): app.example.com: could not verify Cloudflare Access (HTTP 530)'])
    expect(docker()).toBe('')
  })
})
