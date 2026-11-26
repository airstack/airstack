/**
 * doctor on a node: the marker, the airstack install, the config history, helper files, Docker.
 * Needs root for most checks (it re-runs itself through sudo like the machine verbs).
 *
 * --fix may: chmod 700 the history store, chmod 600 /etc/airstack/redact.json. Nothing else.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { versionLabel } from '../../lib/core.js'
import type { ModeInfo } from '../../lib/mode.js'
import { NODE_BIN, NODE_LIB } from '../../lib/release/node-install.js'
import { REDACT_PATH, SUDOERS_PATH } from '../../lib/node-setup.js'
import { loadNodeInfo, readUnitManaged } from '../../node/units.js'
import type { Output } from '../../lib/output.js'

function rootOwned(p: string, maxMode: number): string | undefined {
  const st = statSync(p)
  if (st.uid !== 0) return `owned by uid ${st.uid}, not root`
  if ((st.mode & 0o777 & ~maxMode) !== 0) return `mode ${(st.mode & 0o777).toString(8)} (want at most ${maxMode.toString(8)})`
  return undefined
}

export function doctorNode(mode: ModeInfo, fix: boolean, out: Output): void {
  const m = mode.marker
  if (!m || m.problem) {
    out.fail(`marker ${m?.path ?? '/etc/airstack/machine.yaml'}: ${m?.problem ?? 'missing'}`)
    return
  }
  out.ok(`marker ${m.path} (machine ${m.machine ?? '?'})`)
  const info = loadNodeInfo()

  // airstack install
  if (!existsSync(NODE_BIN)) out.fail(`${NODE_BIN} missing: run airstack deploy (or fleet update) from the controller`)
  else {
    const target = readlinkSync(NODE_BIN)
    if (!target.startsWith(`${NODE_LIB}/versions/`)) out.warn(`${NODE_BIN} points outside ${NODE_LIB}/versions: ${target}`)
    else {
      const bad = rootOwned(join(target, '..', '..'), 0o755)
      if (bad) out.fail(`${target}: ${bad}`)
      else out.ok(`airstack ${versionLabel()} (${realpathSync(NODE_BIN) === realpathSync(process.execPath) ? 'active' : 'not the active build'})`)
    }
  }
  if (info.version && !versionLabel().startsWith(info.version.split(' ')[0])) {
    out.warn(`marker says airstack ${info.version}; running ${versionLabel()}`)
  }

  // config history
  const store = join(info.root, '.stack')
  if (!existsSync(join(store, '.git'))) out.warn('no config history yet (the next deploy starts it)')
  else {
    const bad = rootOwned(store, 0o700)
    if (bad && fix) { chmodSync(store, 0o700); out.ok(`fixed: chmod 700 ${store}`) }
    else if (bad) out.fail(`${store}: ${bad} (it holds live files with secrets)`)
    else out.ok(`config history ${store} (root only)`)
  }
  for (const u of info.units) {
    if (!readUnitManaged(u)) out.warn(`${u.name}: no managed file list yet (deploy once with this version)`)
  }

  // helper files
  if (!existsSync(REDACT_PATH)) out.warn(`${REDACT_PATH} missing: node output redacts fewer secrets (deploy writes it)`)
  else {
    const bad = rootOwned(REDACT_PATH, 0o600)
    if (bad && fix) { chmodSync(REDACT_PATH, 0o600); out.ok(`fixed: chmod 600 ${REDACT_PATH}`) }
    else if (bad) out.fail(`${REDACT_PATH}: ${bad}`)
    else out.ok(`${REDACT_PATH} (root only)`)
  }
  if (!existsSync(SUDOERS_PATH)) out.info(`${SUDOERS_PATH} missing: only sudo users can run machine verbs`)

  // docker
  const d = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf-8', timeout: 15_000 })
  if (d.status === 0) out.ok(`docker ${d.stdout.trim()}`)
  else out.fail('docker does not answer (docker info)')
}
