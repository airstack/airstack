import { describe, expect, it } from 'vitest'
import { ensureAdminGroup, SUDOERS_PATH } from '../../../cli/lib/node-setup'
import { fakeRemote } from '../node/helpers'

const RULE = '%airstack-admin ALL=(root) NOPASSWD: /usr/local/bin/airstack machine *'

describe('ensureAdminGroup', () => {
  it('rejects bad user names before any remote call', async () => {
    const remote = fakeRemote()
    const r = await ensureAdminGroup(remote, ['alice', 'Bob', 'x;rm -rf /', '-root'])
    expect(r.ok).toBe(false)
    expect(r.note).toBe('bad user name(s) in host.users.admins: Bob, x;rm -rf /, -root')
    expect(remote.calls).toEqual([])
  })

  it('creates the group, adds members, checks the rule with visudo before install', async () => {
    const remote = fakeRemote()
    const r = await ensureAdminGroup(remote, ['alice', 'deploy_bot'])
    expect(r).toEqual({ ok: true, note: 'airstack-admin: alice, deploy_bot' })
    const runs = remote.runs()
    expect(runs[0]).toBe('getent group airstack-admin >/dev/null || sudo groupadd --system airstack-admin')
    expect(runs[1]).toBe('id -u alice >/dev/null 2>&1 && sudo usermod -aG airstack-admin alice')
    expect(runs[2]).toBe('id -u deploy_bot >/dev/null 2>&1 && sudo usermod -aG airstack-admin deploy_bot')

    const up = remote.calls.find((c) => c.type === 'rsync')!
    expect(up.content!.split('\n')).toContain(RULE)
    const install = runs[3]
    expect(install.startsWith(`sudo visudo -cqf ${up.dest} && sudo install -o root -g root -m 440 ${up.dest} ${SUDOERS_PATH}`)).toBe(true)
    expect(install).toContain(`sudo rm -f ${up.dest}`)
  })

  it('no admins → group and rule still written', async () => {
    const remote = fakeRemote()
    expect(await ensureAdminGroup(remote, [])).toEqual({ ok: true, note: 'airstack-admin: no members' })
    expect(remote.runs().some((c) => c.startsWith('sudo visudo -cqf'))).toBe(true)
  })

  it('reports each failure step', async () => {
    expect((await ensureAdminGroup(fakeRemote((c) => c.startsWith('getent') ? { exitCode: 1 } : undefined), [])).note)
      .toBe('cannot create group airstack-admin')
    expect((await ensureAdminGroup(fakeRemote((c) => c.startsWith('id -u') ? { exitCode: 1 } : undefined), ['ghost'])).note)
      .toBe('cannot add ghost to airstack-admin (does the user exist?)')
    expect((await ensureAdminGroup(fakeRemote(() => undefined, () => 1), [])).note).toBe('cannot upload the sudoers rule')
    const visudoFails = fakeRemote((c) => c.startsWith('sudo visudo') ? { exitCode: 1 } : undefined)
    expect(await ensureAdminGroup(visudoFails, [])).toEqual({ ok: false, note: 'the sudoers rule failed the visudo check, so it was not installed' })
  })
})
