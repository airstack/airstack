import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RemoteExecutor, RunOptions } from '../../../cli/types'
import type { NodeUnit } from '../../../cli/node/units'

/** A fake machine root in a temp dir. Call cleanup() in afterEach. */
export function makeRoot(prefix = 'airstack-node-'): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const f = join(dir, rel)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, text)
  }
}

export function machineUnit(root: string): NodeUnit {
  return { name: 'machine', kind: 'machine', dir: join(root, 'machine'), slot: 'machine', user: 'stackroot', userKind: 'stack', project: 'airstack' }
}

export function stackUnit(root: string, name: string): NodeUnit {
  return { name, kind: 'stack', dir: join(root, 'stacks-live', name), slot: `stacks/${name}`, user: 'stackroot', userKind: 'stack', project: name }
}

export interface FakeCall {
  type: 'run' | 'rsync'
  cmd: string
  stdin?: string
  /** For rsync: the local source file's content at call time (it is often deleted afterwards). */
  content?: string
  dest?: string
}

type Reply = { stdout?: string; stderr?: string; exitCode?: number }

/** A RemoteExecutor fake: `reply` decides the answer to each command. Records stdin and rsync content. */
export function fakeRemote(
  reply: (cmd: string, opts?: RunOptions) => Reply | undefined = () => undefined,
  rsyncReply: (src: string, dest: string) => number = () => 0,
): RemoteExecutor & { calls: FakeCall[]; runs: () => string[] } {
  const calls: FakeCall[] = []
  return {
    calls,
    runs: () => calls.filter((c) => c.type === 'run').map((c) => c.cmd),
    async run(cmd: string, opts?: RunOptions) {
      calls.push({ type: 'run', cmd, stdin: opts?.stdin })
      const r = reply(cmd, opts) ?? {}
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 }
    },
    async rsync(src: string, dest: string) {
      let content: string | undefined
      try {
        content = readFileSync(src, 'utf-8')
      } catch { /* not a readable file */ }
      calls.push({ type: 'rsync', cmd: `rsync ${src} ${dest}`, content, dest })
      return { exitCode: rsyncReply(src, dest) }
    },
  }
}
