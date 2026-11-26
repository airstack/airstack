import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { adoptMachine } from '../../../cli/commands/deploy/adopt'
import { parseFlags, type Flags } from '../../../cli/commands/deploy/flags'
import { loadFleet, loadMachine } from '../../../cli/lib/fleet'
import { Output } from '../../../cli/lib/output'
import type { RemoteExecutor } from '../../../cli/types'

const FLEET = join(__dirname, '../../fixtures/fleet-basic')

function remote(answer: (cmd: string) => number): RemoteExecutor & { cmds: string[] } {
  const cmds: string[] = []
  return {
    cmds,
    async run(cmd) {
      cmds.push(cmd)
      return { stdout: '', stderr: '', exitCode: answer(cmd) }
    },
    async rsync() { return { exitCode: 0 } },
  }
}

function setup() {
  const fleet = loadFleet(FLEET)
  const m = loadMachine(fleet, fleet.machines[0].name)
  const flags = parseFlags([m.name, '--adopt']) as Flags
  const lines: string[] = []
  return { fleet, m, flags, out: new Output((l) => lines.push(l)), lines }
}

describe('deploy --adopt', () => {
  it('flags: works alone', () => {
    expect((parseFlags(['m', '--adopt']) as Flags).adopt).toBe(true)
    expect(parseFlags(['m', '--adopt', '--install'])).toMatch(/--adopt works alone/)
    expect(parseFlags(['m', '--adopt', '--stage'])).toMatch(/--adopt works alone/)
    expect(parseFlags(['m', '--adopt', '--stack', 'x'])).toMatch(/--adopt works alone/)
  })

  it('a machine that already has the marker is left alone', async () => {
    const { fleet, m, flags, out } = setup()
    // readMarker needs a marker body on stdout.
    const r = remote(() => 1)
    r.run = async (cmd) => {
      r.cmds.push(cmd)
      return cmd.startsWith('sudo cat') ? { stdout: 'machine: x\n', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 1 }
    }
    const res = await adoptMachine(r, fleet, m, flags, '0.1.0', out)
    expect(res).toEqual({ ok: true, note: 'already adopted' })
    expect(r.cmds).toHaveLength(1)
  })

  it('a failed check changes nothing', async () => {
    const { fleet, m, flags, out, lines } = setup()
    const r = remote((cmd) => {
      if (cmd.startsWith('sudo cat')) return 1 // no marker
      if (cmd.includes('docker info')) return 1 // Docker missing
      return 0
    })
    const res = await adoptMachine(r, fleet, m, flags, '0.1.0', out)
    expect(res.ok).toBe(false)
    expect(res.note).toMatch(/nothing changed/)
    expect(lines.some((l) => l.includes('docker answers: no'))).toBe(true)
    expect(r.cmds.some((c) => c.includes('install -o root -g root -m 0644'))).toBe(false)
  })

  it('stops when SSH does not connect', async () => {
    const { fleet, m, flags, out } = setup()
    const r = remote((cmd) => (cmd.startsWith('sudo cat') ? 1 : 255))
    const res = await adoptMachine(r, fleet, m, flags, '0.1.0', out)
    expect(res).toEqual({ ok: false, note: 'no SSH' })
  })
})
