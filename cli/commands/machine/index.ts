/**
 * airstack machine <sub> — verbs that act on THIS node. Only on a node (/etc/airstack/machine.yaml).
 * They read root-only files, so a non-root user runs them through `sudo -n` (see node/elevate.ts).
 */

import { existsSync } from 'node:fs'
import { isRoot, reexecAsRoot, ADMIN_GROUP } from '../../node/elevate.js'
import { loadNodeInfo, MARKER, type NodeInfo } from '../../node/units.js'
import { EXIT, type Output } from '../../lib/output.js'
import { checkCmd, logsCmd, reportCmd, statusCmd } from './read.js'
import { configCmd } from './config.js'
import { driftCmd, historyCmd, recordDeployCmd, snapshotCmd } from './history.js'
import { applyCmd, restartCmd, rollbackCmd } from './repair.js'

export const MACHINE_USAGE = `Usage: airstack machine <command>

Read (change nothing):
  status                         containers per unit, memory, disk, last history entry
  check [-v]                     security and health checks (ok / warn / fail)
  report [--full]                the daily report as text (short: problems + one summary line)
  logs <unit> [service] [-n N] [-f]
  config read <unit> [<file>]    list managed files, or show one with secrets redacted
  config diff [<unit>] [--since <rev>]   box edits since the last deploy (redacted)
  history [<unit>] [-n N]        config history (deploys, box edits, rollbacks)

Repair (change the machine):
  snapshot [<unit>]              save box edits in the config history now
  apply <unit>                   save box edits, then docker compose up -d
  restart <unit> [service]       docker compose restart
  rollback <unit> [<rev>]        restore managed files (default: the last deploy), then up -d

Units: "machine" for the machine unit, else the stack instance name.
Non-root users need sudo, or membership in the ${ADMIN_GROUP} group.`

type Handler = (info: NodeInfo, args: string[], out: Output) => number

const COMMANDS: Record<string, Handler> = {
  status: (i, _a, o) => statusCmd(i, o),
  check: checkCmd,
  report: reportCmd,
  logs: logsCmd,
  config: configCmd,
  history: historyCmd,
  snapshot: snapshotCmd,
  apply: applyCmd,
  restart: restartCmd,
  rollback: rollbackCmd,
  drift: driftCmd,
  'record-deploy': recordDeployCmd,
}

export function machineCommand(args: string[], out: Output): number {
  const [sub, ...rest] = args
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    out.info(MACHINE_USAGE)
    return sub ? EXIT.OK : EXIT.USAGE
  }
  const handler = COMMANDS[sub]
  if (!handler) {
    out.fail(`unknown: machine ${sub}`)
    out.next('airstack machine --help')
    return EXIT.USAGE
  }
  if (!isRoot()) {
    const r = reexecAsRoot(['machine', ...args])
    if (r.denied) {
      out.fail(`machine ${sub} needs root: run it with sudo, or join the ${ADMIN_GROUP} group`)
      return EXIT.USAGE
    }
    return r.code
  }
  if (!existsSync(MARKER)) {
    out.fail(`no ${MARKER}: this is not an airstack node`)
    return EXIT.USAGE
  }
  return handler(loadNodeInfo(), rest, out)
}
