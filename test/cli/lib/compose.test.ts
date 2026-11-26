import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { composeCommand } from '../../../cli/lib/compose'

const ctx = (stack: Record<string, unknown>, appUser = 'stackroot') =>
  ({ config: { host: { appUser }, stack: { installDir: '/home/deploy/stacks/cliproxy', projectName: 'cliproxy', ...stack } } }) as any

describe('composeCommand', () => {
  it('passes the project name and runs as the run user', () => {
    expect(composeCommand(ctx({}), 'up -d')).toBe(
      `sudo -u stackroot bash -c 'cd /home/deploy/stacks/cliproxy && docker compose -p cliproxy up -d'`,
    )
  })

  it('dev-user units use the rootless socket from id -u on the box', () => {
    const cmd = composeCommand(ctx({ runUserKind: 'dev', installDir: '/home/deployuser/airstack/dev', projectName: 'dev' }, 'deployuser'), 'config')
    expect(cmd).toBe(
      `sudo -u deployuser bash -c 'DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock cd /home/deployuser/airstack/dev && docker compose -p dev config'`,
    )
  })

  it('inner single quotes survive the bash -c wrapping', () => {
    const cmd = composeCommand(ctx({}), `--profile 'a b' up -d`)
    // Let a real shell parse the outer layer; the inner command must come back intact.
    const inner = execFileSync('sh', ['-c', `set -- ${cmd.replace(/^sudo -u stackroot /, '')}; printf %s "$3"`], { encoding: 'utf8' })
    expect(inner).toBe(`cd /home/deploy/stacks/cliproxy && docker compose -p cliproxy --profile 'a b' up -d`)
  })
})
