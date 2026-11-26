import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { DeployLogger } from '../../cli/types'

export const nullLogger: DeployLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
}

export function makeTmpDir(prefix = 'cli-test'): string {
  const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function setupProject(env = '', stackYml = ''): string {
  const root = makeTmpDir()
  writeFileSync(join(root, '.env'), env)
  writeFileSync(join(root, 'stack.yml'), stackYml)
  return root
}
