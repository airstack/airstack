import { describe, expect, it } from 'vitest'
import { installName, type ObtainedRelease } from '../../../cli/lib/release/obtain'
import { nodeVersions, pushRelease, remoteTarget } from '../../../cli/lib/release/node-install'
import { isTarget, releaseName, tarballName, targetFor } from '../../../cli/lib/release/targets'
import { fakeRemote } from '../node/helpers'

describe('targets', () => {
  it('maps uname / Node values to targets', () => {
    expect(targetFor('Linux', 'x86_64')).toBe('linux-x64')
    expect(targetFor('linux', 'amd64')).toBe('linux-x64')
    expect(targetFor('Linux', 'aarch64')).toBe('linux-arm64')
    expect(targetFor('Linux', 'arm64')).toBe('linux-arm64')
    expect(targetFor('Darwin', 'arm64')).toBe('darwin-arm64')
    expect(targetFor('darwin', 'x64')).toBe('darwin-x64')
    expect(targetFor('Darwin', 'x86_64')).toBe('darwin-x64')
  })
  it('unsupported → undefined', () => {
    expect(targetFor('FreeBSD', 'x86_64')).toBeUndefined()
    expect(targetFor('Linux', 'armv7l')).toBeUndefined()
    expect(targetFor('', '')).toBeUndefined()
    expect(targetFor('Windows_NT', 'x64')).toBeUndefined()
  })
  it('names', () => {
    expect(releaseName('0.1.0', 'linux-x64')).toBe('airstack-0.1.0-linux-x64')
    expect(tarballName('0.1.0', 'darwin-arm64')).toBe('airstack-0.1.0-darwin-arm64.tar.gz')
    expect(isTarget('linux-arm64')).toBe(true)
    expect(isTarget('linux-armv7')).toBe(false)
  })
  it('installName: release vs dev build', () => {
    expect(installName({ version: '0.1.0', buildId: 'release' })).toBe('0.1.0')
    expect(installName({ version: '0.1.0', buildId: 'g1a2b3c' })).toBe('0.1.0-g1a2b3c')
  })
})

describe('remoteTarget', () => {
  it('reads uname -sm', async () => {
    expect(await remoteTarget(fakeRemote(() => ({ stdout: 'Linux aarch64\n' })))).toBe('linux-arm64')
    expect(await remoteTarget(fakeRemote(() => ({ stdout: 'Linux x86_64\n', exitCode: 1 })))).toBeUndefined()
  })
})

const LS_CMD_START = 'ls -1 /usr/local/lib/airstack/versions'

describe('nodeVersions', () => {
  it('parses the listing and the active symlink', async () => {
    const remote = fakeRemote(() => ({
      stdout: '0.1.0\n0.2.0-g1a2b3c\n0.3.0.new\nbad name\n\n@@\n/usr/local/lib/airstack/versions/0.2.0-g1a2b3c/bin/airstack\n',
    }))
    expect(await nodeVersions(remote)).toEqual({ active: '0.2.0-g1a2b3c', installed: ['0.1.0', '0.2.0-g1a2b3c'] })
    expect(remote.runs()[0].startsWith(LS_CMD_START)).toBe(true)
  })
  it('nothing installed, no symlink', async () => {
    expect(await nodeVersions(fakeRemote(() => ({ stdout: '@@\n' })))).toEqual({ active: undefined, installed: [] })
  })
  it('a symlink somewhere else is not active', async () => {
    expect((await nodeVersions(fakeRemote(() => ({ stdout: '0.1.0\n@@\n/opt/other/airstack\n' })))).active).toBeUndefined()
  })
})

describe('pushRelease', () => {
  const SHA = 'b'.repeat(64)
  const rel = (o: Partial<ObtainedRelease> = {}): ObtainedRelease => ({
    target: 'linux-x64', version: '0.2.0', buildId: 'release', tarball: '/cache/airstack-0.2.0-linux-x64.tar.gz', sha256: SHA, source: 'cache', ...o,
  })
  const DIR = '/usr/local/lib/airstack/versions/0.2.0'

  /** Node state: which builds are installed (name → sha) and which is active. */
  function node(installed: Record<string, string>, active?: string) {
    return fakeRemote((cmd) => {
      if (cmd.startsWith(LS_CMD_START)) {
        const link = active ? `/usr/local/lib/airstack/versions/${active}/bin/airstack` : ''
        return { stdout: `${Object.keys(installed).join('\n')}\n@@\n${link}\n` }
      }
      const m = cmd.match(/^cat \/usr\/local\/lib\/airstack\/versions\/([^/]+)\/\.sha256/)
      if (m) return { stdout: installed[m[1]] ? `${installed[m[1]]}\n` : '' }
      return undefined
    })
  }

  it('already installed and active → nothing sent, no switch', async () => {
    const remote = node({ '0.2.0': SHA }, '0.2.0')
    expect(await pushRelease(remote, rel())).toEqual({ name: '0.2.0', sent: false, switched: false })
    expect(remote.calls.some((c) => c.type === 'rsync')).toBe(false)
    expect(remote.runs().some((c) => c.includes('ln -sfn'))).toBe(false)
    expect(remote.runs().some((c) => c.includes('sha256sum'))).toBe(false)
  })

  it('installed but not active → only the symlink switches', async () => {
    const remote = node({ '0.1.0': 'c'.repeat(64), '0.2.0': SHA }, '0.1.0')
    expect(await pushRelease(remote, rel())).toEqual({ name: '0.2.0', sent: false, switched: true })
    expect(remote.calls.some((c) => c.type === 'rsync')).toBe(false)
    expect(remote.runs()).toContain(`sudo ln -sfn ${DIR}/bin/airstack /usr/local/bin/airstack.new && sudo mv -Tf /usr/local/bin/airstack.new /usr/local/bin/airstack`)
  })

  it('new build → rsync, checked install script, then switch', async () => {
    const remote = node({ '0.1.0': 'c'.repeat(64) }, '0.1.0')
    expect(await pushRelease(remote, rel())).toEqual({ name: '0.2.0', sent: true, switched: true })
    const up = remote.calls.find((c) => c.type === 'rsync')!
    expect(up.cmd).toMatch(/^rsync \/cache\/airstack-0\.2\.0-linux-x64\.tar\.gz \/tmp\/airstack-0\.2\.0-\d+\.tar\.gz$/)
    const script = remote.runs().find((c) => c.includes('sha256sum'))!
    const lines = script.split('\n')
    expect(lines[0]).toBe('set -e')
    expect(lines).toContain(`echo '${SHA}  ${up.dest}' | sha256sum -c --quiet`)
    expect(lines.at(-1)).toBe(`sudo mv ${DIR}.new ${DIR}`)
    expect(lines.indexOf(`echo '${SHA}  ${up.dest}' | sha256sum -c --quiet`)).toBeLessThan(lines.findIndex((l) => l.startsWith('sudo tar')))
    const order = remote.calls.map((c) => c.type === 'rsync' ? 'rsync' : c.cmd.includes('sha256sum') ? 'install' : c.cmd.includes('ln -sfn') ? 'switch' : '')
      .filter(Boolean)
    expect(order).toEqual(['rsync', 'install', 'switch'])
  })

  it('same name but a different sha (rebuilt) → sent again, symlink refreshed', async () => {
    const remote = node({ '0.2.0': 'd'.repeat(64) }, '0.2.0')
    expect(await pushRelease(remote, rel())).toEqual({ name: '0.2.0', sent: true, switched: false })
    expect(remote.runs().some((c) => c.includes('ln -sfn'))).toBe(true)
  })

  it('a failed upload or install throws', async () => {
    const up = fakeRemote(() => undefined, () => 1)
    await expect(pushRelease(up, rel())).rejects.toThrow('upload of the airstack release failed')
    const inst = fakeRemote((cmd) => cmd.includes('sha256sum') ? { stderr: 'sha256sum: WARNING: 1 computed checksum did NOT match\n', exitCode: 1 } : undefined)
    await expect(pushRelease(inst, rel())).rejects.toThrow('install of 0.2.0 failed: sha256sum: WARNING')
  })

  it('bad name or checksum is rejected before any remote call', async () => {
    for (const bad of [rel({ version: '0.2.0; rm -rf /' }), rel({ buildId: 'a b' }), rel({ version: '../x/' }), rel({ sha256: 'xyz' })]) {
      const remote = node({})
      await expect(pushRelease(remote, bad)).rejects.toThrow('bad release name or checksum')
      expect(remote.calls).toEqual([])
    }
  })
})
