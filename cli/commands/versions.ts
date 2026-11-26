/**
 * airstack versions | update | install <version> — airstack itself on THIS machine.
 *
 * Controller: releases install user-local (~/.local/lib/airstack, ~/.local/bin/airstack).
 * Node: airstack comes from the controller (deploy, `fleet update`). A node updates itself only
 * when /etc/airstack/machine.yaml has `update: {allowSourceUpdate: true}` (default false): the
 * binary runs as root, so its source is the controller unless the owner says otherwise.
 */

import { readFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { BUILD, VERSION, versionLabel } from '../lib/core.js'
import { activateLocal, installLocal, localVersions } from '../lib/release/local-install.js'
import { compareVersions, latestVersion } from '../lib/release/latest.js'
import { nodeVersions, pushRelease, remoteTarget } from '../lib/release/node-install.js'
import { obtainRelease } from '../lib/release/obtain.js'
import { createLocalExecutor } from '../lib/local-executor.js'
import { MARKER } from '../node/units.js'
import { isRoot } from '../node/elevate.js'
import type { ModeInfo } from '../lib/mode.js'
import { EXIT, type Output } from '../lib/output.js'

export async function versionsCommand(mode: ModeInfo, out: Output): Promise<number> {
  out.info(`running  airstack ${versionLabel()}`)
  if (mode.mode === 'node') {
    const v = await nodeVersions(createLocalExecutor())
    for (const n of v.installed) out.info(`${n === v.active ? '*' : ' '} ${n}`)
    if (!v.installed.length) out.info('no versions in /usr/local/lib/airstack/versions')
    return EXIT.OK
  }
  const v = localVersions()
  for (const n of v.installed) out.info(`${n === v.active ? '*' : ' '} ${n}`)
  if (!v.installed.length) out.info('no releases in ~/.local/lib/airstack/versions (running from source or another path)')
  return EXIT.OK
}

function nodeMayUpdate(): boolean {
  try {
    const d = (yaml.load(readFileSync(MARKER, 'utf-8')) ?? {}) as { update?: { allowSourceUpdate?: boolean } }
    return d.update?.allowSourceUpdate === true
  } catch {
    return false
  }
}

/** update = install the newest release. install <v> = a given release. */
export async function updateCommand(mode: ModeInfo, wantVersion: string | undefined, out: Output): Promise<number> {
  let version = wantVersion
  if (mode.mode === 'node' && !nodeMayUpdate()) {
    out.fail('blocked: this node gets airstack from its controller')
    out.next(`airstack fleet ${version ? `install ${version}` : 'update'} <machine>   (on the controller)`)
    return EXIT.USAGE
  }
  if (!version) {
    try {
      version = await latestVersion()
    } catch (e) {
      out.fail(e instanceof Error ? e.message : String(e))
      return EXIT.FAIL
    }
    if (compareVersions(version, VERSION) <= 0 && BUILD === 'release') {
      out.ok(`airstack ${VERSION} is the newest release`)
      return EXIT.OK
    }
  }
  if (!/^\d+\.\d+\.\d+([-.+][\w.]+)?$/.test(version)) {
    out.fail(`not a version: ${version}`)
    return EXIT.USAGE
  }

  if (mode.mode === 'node') return updateNode(version, out)

  try {
    const r = await installLocal(version, (s) => out.next(s))
    out.ok(`airstack ${version} in ${r.dir}${r.switched ? '; ~/.local/bin/airstack now points to it' : ' (already active)'}`)
    if (!(process.env.PATH ?? '').split(':').some((p) => p.endsWith('/.local/bin'))) {
      out.warn('~/.local/bin is not on PATH')
      out.next(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`)
    }
    out.next('airstack doctor')
  } catch (e) {
    out.fail(e instanceof Error ? e.message : String(e))
    return EXIT.FAIL
  }
  return out.code()
}

async function updateNode(version: string, out: Output): Promise<number> {
  if (!nodeMayUpdate()) {
    out.fail('blocked: this node gets airstack from its controller')
    out.next(`airstack fleet install ${version} <machine>   (on the controller)`)
    return EXIT.USAGE
  }
  if (!isRoot()) {
    out.fail('updating a node needs root: run it with sudo')
    return EXIT.USAGE
  }
  const local = createLocalExecutor()
  const target = await remoteTarget(local)
  if (!target) { out.fail('unsupported OS/CPU'); return EXIT.FAIL }
  try {
    const rel = await obtainRelease(target, version, (s) => out.next(s), { source: false })
    const r = await pushRelease(local, rel)
    out.ok(`airstack ${r.name} ${r.sent ? 'installed' : 'already installed'}${r.switched ? ' and active' : ''}`)
  } catch (e) {
    out.fail(e instanceof Error ? e.message : String(e))
    return EXIT.FAIL
  }
  return EXIT.OK
}

/** Switch the active controller release (no download). */
export function useCommand(version: string, out: Output): number {
  try {
    activateLocal(version)
    out.ok(`~/.local/bin/airstack now points to ${version}`)
    return EXIT.OK
  } catch (e) {
    out.fail(e instanceof Error ? e.message : String(e))
    return EXIT.FAIL
  }
}
