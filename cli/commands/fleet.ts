/**
 * airstack fleet list | show <machine> | config <machine> [<instance>] | check [<machine>...]
 * Read-only views of the fleet repo. Secrets are never printed (`${NAME}` is shown instead).
 */

import { relative } from 'node:path'
import { loadFleet, loadMachine, selectTargets, type Fleet, type HostConfig, type Issue, type Machine } from '../lib/fleet.js'
import { checkPluginScopes } from '../lib/fleet-check.js'
import { lintMachine } from '../lib/fleet-lint.js'
import { isPlainObject, joinPath } from '../lib/merge.js'
import { EXIT, type Output } from '../lib/output.js'

export const FLEET_USAGE = `Usage: airstack fleet <command>

  list                          machines and their stack instances
  show <machine>                resolved machine summary
  config <machine> [<instance>] merged config, each key tagged with where it came from
  check [<machine>...]          validate the fleet offline (refs, scopes, secrets, names, users, ports, networks)
  plugin <machine> <cmd> [args] run a plugin command for that machine (e.g. cf-tunnel verify)
  update [<machine>...]         put the pinned airstack version on machines (airstack.yaml)
  install <version> <machine>... put a given airstack version on machines

Patterns ('airstack-*') and --all work where a machine list is accepted. Quote patterns.
Container logs: airstack ssh <machine> -- sudo docker logs --tail 100 <container>`

export async function fleetCommand(args: string[], fleetPath: string, out: Output): Promise<number> {
  const [sub, ...rest] = args
  const fleet = loadFleet(fleetPath)
  switch (sub) {
    case 'list': return list(fleet, out)
    case 'show': return show(fleet, rest, out)
    case 'config': return config(fleet, rest, out)
    case 'check': return check(fleet, rest, out)
    case 'plugin': return pluginCmd(fleet, rest, out)
    case 'update': return (await import('./fleet-rollout.js')).fleetUpdate(fleet, rest, out)
    case 'install': return (await import('./fleet-rollout.js')).fleetInstall(fleet, rest, out)
    case undefined: case '--help': case '-h':
      out.info(FLEET_USAGE)
      return sub ? EXIT.OK : EXIT.USAGE
    default:
      out.fail(`unknown fleet command: ${sub}`)
      out.next('airstack fleet --help')
      return EXIT.USAGE
  }
}

function list(fleet: Fleet, out: Output): number {
  out.info(`fleet ${fleet.name}  (${fleet.root})${fleet.versionPin ? `  pins airstack ${fleet.versionPin}` : ''}`)
  if (fleet.machines.length === 0) {
    out.warn('no machines (add machines/<name>.yaml)')
    return out.code()
  }
  for (const ref of fleet.machines) {
    const m = loadMachine(fleet, ref.name)
    const fails = m.issues.filter((i) => i.level === 'fail').length
    const inst = m.instances.map((i) => (i.ref === i.name ? i.name : `${i.name}=${i.ref}`)).join(' ')
    const dh = m.displayHost.host as HostConfig
    const addr = dh.ip || dh.hostname
    out.info(`${ref.name.padEnd(20)} ${addr.padEnd(28)} ${inst || '(no stacks)'}${fails ? `   [${fails} problem(s): airstack fleet check ${ref.name}]` : ''}`)
  }
  return out.code()
}

function oneMachine(fleet: Fleet, args: string[], out: Output, usage: string): Machine | undefined {
  const name = args[0]
  if (!name) {
    out.fail(`usage: ${usage}`)
    return undefined
  }
  if (!fleet.machines.some((m) => m.name === name)) {
    out.fail(`no machine '${name}' in ${fleet.root}/machines`)
    out.next('airstack fleet list')
    return undefined
  }
  return loadMachine(fleet, name)
}

async function show(fleet: Fleet, args: string[], out: Output): Promise<number> {
  const m = oneMachine(fleet, args, out, 'airstack fleet show <machine>')
  if (!m) return EXIT.USAGE
  const h = m.displayHost.host as HostConfig // display copy: secrets stay ${NAME}
  out.info(`machine  ${m.name}  (${relative(fleet.root, m.file)})`)
  out.info(`host     ${h.ip || '-'}  hostname ${h.hostname}  tz ${h.timezone || '-'}`)
  out.info(`ssh      ${h.ssh.user}@${h.ip || h.hostname}:${h.ssh.port}  (fresh box: ${h.ssh.bootstrapUser}@:${h.ssh.bootstrapPort}; ${h.ssh.expose})`)
  out.info(`users    sudo ${h.users.sudo}  stack ${h.users.stack}  dev ${h.users.dev.join(',') || '-'}`)
  out.info(`root     ${m.root}`)
  out.info(`plugins  ${Object.keys(m.plugins).join(' ') || '-'}`)
  for (const i of m.instances) {
    out.info(`stack    ${i.name}  <- ${i.ref}  user ${i.user} (${i.userKind})  dir ${i.installDir}  project ${i.composeProject}`)
  }
  printIssues(fleet, [...m.issues, ...(await lintMachine(fleet, m))], out)
  return out.code()
}

function config(fleet: Fleet, args: string[], out: Output): number {
  const m = oneMachine(fleet, args, out, 'airstack fleet config <machine> [<instance>]')
  if (!m) return EXIT.USAGE
  const instName = args[1]
  if (!instName) {
    const mFile = relative(fleet.root, m.file)
    flatten(m.displayHost, '', (k, v) => out.info(`${k} = ${fmt(v)}   [machine:${mFile}]`))
    flatten({ plugins: m.displayPlugins }, '', (k, v) => out.info(`${k} = ${fmt(v)}   [machine:${mFile}]`))
    out.info(`stacks = ${m.instances.map((i) => i.name).join(', ') || '-'}`)
    if (m.instances.length) out.next(`airstack fleet config ${m.name} <instance>`)
  } else {
    const inst = m.instances.find((i) => i.name === instName)
    if (!inst) {
      out.fail(`no stack instance '${instName}' on ${m.name} (have: ${m.instances.map((i) => i.name).join(', ') || 'none'})`)
      return EXIT.USAGE
    }
    out.info(`# ${m.name}/${inst.name} <- ${inst.ref}  (secrets shown as \${NAME})`)
    flatten(inst.display, '', (k, v) => out.info(`${k} = ${fmt(v)}   [${originOf(inst.origins, k)}]`))
  }
  printIssues(fleet, m.issues, out)
  return out.code()
}

async function check(fleet: Fleet, args: string[], out: Output): Promise<number> {
  const all = args.includes('--all') || args.filter((a) => !a.startsWith('-')).length === 0
  const names = fleet.machines.map((m) => m.name)
  const { selected, unmatched } = selectTargets(names, args.filter((a) => !a.startsWith('-')), all)
  printIssues(fleet, fleet.issues, out)
  for (const u of unmatched) out.fail(`no machine matches '${u}'`)
  for (const name of selected) {
    const m = loadMachine(fleet, name)
    const issues = [...m.issues, ...(await checkPluginScopes(fleet, m)), ...(await lintMachine(fleet, m))]
    printIssues(fleet, issues, out)
    const f = issues.filter((i) => i.level === 'fail').length
    const w = issues.filter((i) => i.level === 'warn').length
    if (f === 0) out.ok(`${name}: ${m.instances.length} stack instance(s), ${Object.keys(m.plugins).length} machine plugin(s)${w ? `, ${w} warning(s)` : ''}`)
  }
  if (selected.length === 0 && unmatched.length === 0) out.warn('no machines to check')
  return out.code()
}

// ── helpers ─────────────────────────────────────────────────────────────────

function printIssues(_fleet: Fleet, issues: Issue[], out: Output) {
  for (const i of issues) {
    const where = i.key ? `${i.file} ${i.key}` : i.file
    if (i.level === 'fail') out.fail(`${where}: ${i.message}`)
    else out.warn(`${where}: ${i.message}`)
  }
}

function flatten(node: unknown, path: string, emit: (k: string, v: unknown) => void) {
  if (isPlainObject(node) && Object.keys(node).length > 0) {
    for (const [k, v] of Object.entries(node)) flatten(v, joinPath(path, k), emit)
  } else {
    emit(path, node)
  }
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return /^[\w./:@${}-]*$/.test(v) && v !== '' ? v : JSON.stringify(v)
  return JSON.stringify(v)
}

/** Origin of a leaf, or of its nearest recorded ancestor (lists and empty maps are leaves). */
function originOf(origins: Map<string, string>, key: string): string {
  let k = key
  while (k) {
    const o = origins.get(k)
    if (o) return o
    const cut = Math.max(k.lastIndexOf('.'), k.lastIndexOf('['))
    k = cut > 0 ? k.slice(0, cut) : ''
  }
  return '?'
}

/** Run a plugin sub-command (cf-tunnel, backup, tailscale, …) against one machine's units. */
async function pluginCmd(fleet: Fleet, args: string[], out: Output): Promise<number> {
  const [name, cmdName, ...cmdArgs] = args
  if (!name || !cmdName) {
    out.fail('usage: airstack fleet plugin <machine> <command> [args]')
    return EXIT.USAGE
  }
  const m = oneMachine(fleet, [name], out, 'airstack fleet plugin <machine> <command> [args]')
  if (!m) return EXIT.USAGE
  if (m.issues.some((i) => i.level === 'fail')) {
    printIssues(fleet, m.issues, out)
    return EXIT.FAIL
  }
  const { buildUnits } = await import('../lib/units.js')
  const { loadPluginRef } = await import('../lib/fleet-check.js')
  const { createRemoteExecutor, sshConfigFromHost } = await import('../lib/ssh.js')
  const available: string[] = []
  for (const unit of buildUnits(fleet, m)) {
    for (const { ref, config } of unit.pluginRefs) {
      const { plugin } = await loadPluginRef(fleet.root, ref, config)
      for (const c of Object.keys(plugin.commands ?? {})) available.push(`${c} (${unit.name}: ${ref})`)
      const cmd = plugin.commands?.[cmdName]
      if (!cmd) continue
      const ssh = sshConfigFromHost(unit.config.host)
      await cmd.run(cmdArgs, {
        config: unit.config,
        ssh,
        remote: ssh.host ? createRemoteExecutor(ssh) : undefined,
        log: { error: console.error, warn: console.warn, info: console.log, debug: () => {} },
        projectRoot: unit.projectRoot,
        sharedPaths: unit.sharedPaths,
        updateConfig: (dotPath: string) => {
          throw new Error(`updateConfig(${dotPath}) is not supported for fleet machines yet: put the value in .airstack/secrets/${m.name}.jsonc`)
        },
      })
      return EXIT.OK
    }
  }
  out.fail(`no plugin command '${cmdName}' on ${m.name}`)
  for (const a of available) out.info(`  ${a}`)
  return EXIT.USAGE
}
