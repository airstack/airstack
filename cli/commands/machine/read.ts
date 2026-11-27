/**
 * machine status | check | report | logs — read verbs on a node. They change nothing.
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { compose, services } from '../../node/compose.js'
import { cronScript, runWithEnv, securityScript } from '../../node/host-scripts.js'
import { findUnit, unitNames, type NodeInfo, type NodeUnit } from '../../node/units.js'
import { Store } from '../../node/store.js'
import { EXIT, type Output } from '../../lib/output.js'

/** One line per unit: containers running, plus disk and memory. */
export function statusCmd(info: NodeInfo, out: Output): number {
  out.info(`machine ${info.machine}  (fleet ${info.fleet || '-'}, root ${info.root})`)
  for (const u of info.units) unitStatus(u, out)
  hostLines(out)
  const store = new Store(info.root)
  if (store.exists()) {
    const last = store.log([], 1)[0]
    if (last) out.info(`history  ${last.date}  ${last.subject}`)
  }
  return out.code()
}

function unitStatus(u: NodeUnit, out: Output): void {
  const s = services(u)
  if (!s) { out.fail(`${u.name}: cannot read containers (docker compose -p ${u.project})`); return }
  if (s.length === 0) { out.info(`${u.name}: no containers`); return }
  const bad = s.filter((x) => x.state !== 'running' || x.health === 'unhealthy')
  const list = s.map((x) => x.service + (x.state === 'running' ? (x.health === 'unhealthy' ? ' (unhealthy)' : '') : ` (${x.state})`)).join(', ')
  const line = `${u.name}: ${s.length - bad.length}/${s.length} running: ${list}`
  if (bad.length) out.fail(line)
  else out.ok(line)
}

function hostLines(out: Output): void {
  try {
    const mem = readFileSync('/proc/meminfo', 'utf-8')
    const kb = (k: string) => Number(mem.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0)
    const total = kb('MemTotal')
    const used = total - kb('MemAvailable')
    const pct = total ? Math.round((used / total) * 100) : 0
    const msg = `memory ${pct}% of ${(total / 1048576).toFixed(1)} GB`
    if (pct > 90) out.warn(msg)
    else out.info(msg)
  } catch { /* not Linux */ }
  const df = runDf('/')
  if (df) {
    const msg = `disk / ${df.pct}% used, ${df.freeGb} GB free`
    if (df.pct > 85) out.warn(msg)
    else out.info(msg)
  }
}

function runDf(mount: string): { pct: number; freeGb: number } | undefined {
  const r = spawnSync('df', ['-Pk', mount], { encoding: 'utf-8' })
  const line = (r.stdout ?? '').trim().split('\n')[1]
  if (!line) return undefined
  const f = line.split(/\s+/)
  return { pct: Number(f[4]?.replace('%', '') ?? 0), freeGb: Math.round(Number(f[3] ?? 0) / 1048576) }
}

/**
 * The checks of the daily report as ok/warn/fail lines (same results as the report). Without the
 * report cron: container status + host_security.sh.
 */
export function checkCmd(info: NodeInfo, args: string[], out: Output): number {
  const verbose = args.includes('-v') || args.includes('--verbose')
  const c = cronScript(info, 'host_alerter_report', 'host_alerter.sh')
  if (c) return checkFromReport(c, verbose, out)
  for (const u of info.units) unitStatus(u, out)
  const r = runWithEnv(securityScript(info), [])
  if (r.code !== 0 && !r.out.trim()) {
    out.fail(`security checks failed to run: ${r.err.trim().split('\n').pop() ?? `exit ${r.code}`}`)
    return out.code()
  }
  for (const line of r.out.split('\n')) {
    const [st, label, ...rest] = line.split('|')
    const detail = rest.join('|')
    if (!label) continue
    const msg = `${label}: ${detail}`
    if (st === 'FAIL') out.fail(msg)
    else if (st === 'WARN') out.warn(msg)
    else if (st === 'OK' && verbose) out.ok(msg)
    else if (st === 'INFO' && verbose) out.info(`     ${msg}`)
  }
  if (out.code() === EXIT.OK) out.ok('all checks passed (-v lists them)')
  return out.code()
}

/**
 * The checks in a full text report (lib/report.sh layout): problems come before the first "───"
 * line, each as an icon line plus indented detail and "🔧" fix lines; passed checks (✅) come after
 * the second "───", before "Details". One problem becomes one line: "title: first detail (fix: …)".
 */
export function parseReportChecks(text: string, verbose: boolean): { level: 'fail' | 'warn' | 'ok'; text: string }[] {
  const lines = text.split('\n')
  const out: { level: 'fail' | 'warn' | 'ok'; text: string; detail?: string; fix?: string }[] = []
  let section = 0
  for (const line of lines) {
    if (line.startsWith('───')) { section++; continue }
    if (/^Details$/.test(line.trim())) break
    if (section === 0) {
      if (line.startsWith('❌')) out.push({ level: 'fail', text: line.slice(1).trim() })
      else if (line.startsWith('⚠️')) out.push({ level: 'warn', text: line.slice(2).trim() })
      else if (/^\s{2,}\S/.test(line) && out.length) {
        const cur = out[out.length - 1]
        const s = line.trim()
        if (s.startsWith('🔧')) cur.fix = s.replace(/^🔧\s*/, '')
        else if (cur.detail === undefined) cur.detail = s
      }
    } else if (section >= 2 && verbose && line.startsWith('✅')) {
      out.push({ level: 'ok', text: line.slice(1).trim() })
    }
  }
  return out.map((c) => ({
    level: c.level,
    text: c.text + (c.detail ? `: ${c.detail}` : '') + (c.fix ? ` (fix: ${c.fix})` : ''),
  }))
}

function checkFromReport(c: { script: string; env?: string }, verbose: boolean, out: Output): number {
  const r = runWithEnv(c.script, ['--report'], c.env, { REPORT_OUTPUT: 'stdout', REPORT_FULL: 'true' })
  if (r.code !== 0) {
    out.fail(`checks failed to run: ${r.err.trim().split('\n').pop() ?? `exit ${r.code}`}`)
    return EXIT.FAIL
  }
  for (const line of parseReportChecks(r.out, verbose)) {
    if (line.level === 'fail') out.fail(line.text)
    else if (line.level === 'warn') out.warn(line.text)
    else out.ok(line.text)
  }
  if (out.code() === EXIT.OK) out.ok('all checks passed (-v lists them)')
  return out.code()
}

/** The daily report as text. Short by default; --full adds every check and the details. */
export function reportCmd(info: NodeInfo, args: string[], out: Output): number {
  const c = cronScript(info, 'host_alerter_report', 'host_alerter.sh')
  if (!c) {
    out.fail('no host report: this machine has no host_alerter_report cron (plugin airstack/cron)')
    return EXIT.FAIL
  }
  const r = runWithEnv(c.script, ['--report'], c.env, { REPORT_OUTPUT: 'stdout', REPORT_FULL: String(args.includes('--full')) })
  if (r.code !== 0) {
    out.fail(`report failed: ${r.err.trim().split('\n').pop() ?? `exit ${r.code}`}`)
    return EXIT.FAIL
  }
  out.info(r.out.trimEnd())
  return /need attention/.test(r.out) ? EXIT.WARN : EXIT.OK
}

/** docker compose logs of one unit (optionally one service). */
export function logsCmd(info: NodeInfo, args: string[], out: Output): number {
  let lines = '100'
  let follow = false
  const pos: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') lines = args[++i] ?? lines
    else if (args[i] === '-f' || args[i] === '--follow') follow = true
    else pos.push(args[i])
  }
  if (!/^\d+$/.test(lines)) { out.fail('-n needs a number'); return EXIT.USAGE }
  const [name, service] = pos
  const unit = name ? findUnit(info, name) : undefined
  if (!unit) {
    out.fail(name ? `no unit '${name}' (units: ${unitNames(info)})` : 'name a unit')
    out.next('airstack machine logs <unit> [service] [-n 100] [-f]')
    return EXIT.USAGE
  }
  const r = compose(unit, ['logs', '--no-color', '--tail', lines, ...(follow ? ['-f'] : []), ...(service ? [service] : [])], true)
  return r.code === 0 ? EXIT.OK : EXIT.FAIL
}
