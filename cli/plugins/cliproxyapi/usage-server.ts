// usage-server (simple10/usage-server) support for the cliproxyapi plugin.
//
// Everything is built ON the VPS, as the app user, from the pinned git tag.
// This box only needs ssh. The VPS needs docker, git and network access.
//
// Hooks:
//   post-sync  create folders and (once) the env file with random tokens
//   build      version guard, then build image/plugin if the pin is not installed
//
// Never done here: editing the proxy's config.yaml (the proxy rewrites it when
// users change settings in the management UI) and restarting the proxy.
// Deploy prints exact commands for those instead.

import type { DeployContext } from '../../types.js'
import { USAGE_SERVER_PIN, USAGE_SERVER_REPO } from './usage-server-pin.js'

export interface UsageServerConfig {
  version: string
  repo: string
  uid: number
  gid: number
  transcriptsDir: string
  port: number
}

// ── Pure helpers (unit tested) ──────────────────────────────────────────────

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** <0 if a<b, 0 if equal, >0 if a>b. Unparseable versions compare as equal. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!
  return 0
}

export function maxVersion(versions: string[]): string | undefined {
  let best: string | undefined
  for (const v of versions) {
    if (!parseVersion(v)) continue
    if (best === undefined || compareVersions(v, best) > 0) best = v.replace(/^v/, '')
  }
  return best
}

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Fills defaults into the plugin's usageServer block (mutates) and returns it, or null when disabled. */
export function resolveUsageServer(raw: unknown): UsageServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  o.version ??= USAGE_SERVER_PIN
  o.repo ??= USAGE_SERVER_REPO
  o.port ??= 18090
  const version = String(o.version)
  if (!parseVersion(version)) throw new Error(`[cliproxyapi] usageServer.version "${version}" must look like 1.2.3`)
  const uid = Number(o.uid)
  const gid = Number(o.gid)
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error('[cliproxyapi] usageServer.uid and usageServer.gid are required (the user that can read transcriptsDir)')
  }
  if (!o.transcriptsDir || typeof o.transcriptsDir !== 'string') {
    throw new Error('[cliproxyapi] usageServer.transcriptsDir is required')
  }
  return { version, repo: String(o.repo), uid, gid, transcriptsDir: o.transcriptsDir, port: Number(o.port) }
}

// ── Remote helpers ──────────────────────────────────────────────────────────

interface Paths {
  install: string
  proxyHome: string
  usageHome: string
  src: string
  envFile: string
  so: string
  marker: string
  status: string
  config: string
}

function paths(ctx: DeployContext): Paths {
  const install = ctx.config.stack.installDir
  const proxyHome = `${install}/.cliproxyapi`
  const usageHome = `${install}/.usage-server`
  return {
    install,
    proxyHome,
    usageHome,
    src: `${usageHome}/src`,
    envFile: `${usageHome}/usage-server.env`,
    so: `${proxyHome}/plugins/usage-server.so`,
    marker: `${usageHome}/plugin.version`,
    status: `${proxyHome}/usage-spool/_plugin_status.json`,
    config: `${proxyHome}/config.yaml`,
  }
}

/** Run a script as the app user (the one that owns docker + the stack files). */
async function asApp(ctx: DeployContext, script: string) {
  const user = ctx.config.host.appUser
  return ctx.remote!.run(`sudo -u ${user} bash -c ${shq(script)}`)
}

async function out(ctx: DeployContext, script: string): Promise<string> {
  const r = await asApp(ctx, script)
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

// ── post-sync ───────────────────────────────────────────────────────────────

export async function usageServerPostSync(ctx: DeployContext, us: UsageServerConfig): Promise<void> {
  if (!ctx.remote) return
  const p = paths(ctx)

  // Folders. The spool and plugins folders are read inside the proxy container (any uid), so 755.
  const mk = await asApp(ctx, [
    `mkdir -p ${shq(p.proxyHome + '/plugins')} ${shq(p.proxyHome + '/usage-spool')} ${shq(p.usageHome + '/data')}`,
    `chmod 755 ${shq(p.proxyHome + '/plugins')} ${shq(p.proxyHome + '/usage-spool')}`,
    `chmod 700 ${shq(p.usageHome)}`,
  ].join(' && '))
  if (mk.exitCode !== 0) {
    ctx.errors.push({ phase: 'post-sync', message: `[usage-server] could not create folders: ${mk.stderr.trim()}`, fatal: false })
    return
  }

  // The container runs as uid:gid (so it can read the transcripts) and writes its database
  // here, so this one dir stays owned by that user, not the stack owner. (Deploy's ownership
  // reset skips it via registeredFiles.keepOwner.)
  const own = await ctx.remote.run(`sudo chown ${us.uid}:${us.gid} ${shq(p.usageHome + '/data')}`)
  if (own.exitCode !== 0) {
    ctx.errors.push({ phase: 'post-sync', message: `[usage-server] could not set owner of ${p.usageHome}/data: ${own.stderr.trim()}`, fatal: false })
  }

  // Env file: created once with random tokens, never overwritten.
  const made = await asApp(ctx, [
    `test -s ${shq(p.envFile)} && echo exists && exit 0`,
    `umask 077`,
    `printf 'USAGE_BRIDGE_TOKEN=%s\\nUSAGE_API_TOKENS=%s\\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > ${shq(p.envFile)} && echo created`,
  ].join('; '))
  if (made.stdout.includes('created')) {
    ctx.log.info(`[usage-server] created ${p.envFile} with new random tokens (kept out of this output)`)
  } else if (!made.stdout.includes('exists')) {
    ctx.errors.push({ phase: 'post-sync', message: `[usage-server] could not create ${p.envFile}: ${made.stderr.trim()}`, fatal: false })
  }
}

/** Registers the dir whose ownership deploy must leave alone. Call from pre-stage. */
export function usageServerKeepOwner(ctx: DeployContext): void {
  const keep = (ctx.registeredFiles.keepOwner ??= [])
  if (!keep.includes('.usage-server/data')) keep.push('.usage-server/data')
}

// ── build ───────────────────────────────────────────────────────────────────

interface Installed {
  runningImageVersion: string
  localImageTags: string[]
  pluginStatusVersion: string
  markerVersion: string
  soExists: boolean
  imageForPinExists: boolean
}

async function inspectInstalled(ctx: DeployContext, us: UsageServerConfig): Promise<Installed> {
  const p = paths(ctx)
  const container = `${ctx.config.stack.projectName}-usage-server`
  const [running, tags, status, marker, so, img] = await Promise.all([
    out(ctx, `docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' ${shq(container)} 2>/dev/null`),
    out(ctx, `docker images usage-server --format '{{.Tag}}' 2>/dev/null`),
    out(ctx, `sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' ${shq(p.status)} 2>/dev/null | head -1`),
    out(ctx, `cat ${shq(p.marker)} 2>/dev/null`),
    out(ctx, `test -s ${shq(p.so)} && echo yes`),
    out(ctx, `docker image inspect usage-server:${us.version} >/dev/null 2>&1 && echo yes`),
  ])
  return {
    runningImageVersion: running,
    localImageTags: tags.split('\n').map(s => s.trim()).filter(Boolean),
    pluginStatusVersion: status,
    markerVersion: marker,
    soExists: so === 'yes',
    imageForPinExists: img === 'yes',
  }
}

/** Pure: what is the newest usage-server version already on the box? */
export function newestDeployed(i: Installed): string | undefined {
  return maxVersion([i.runningImageVersion, ...i.localImageTags, i.pluginStatusVersion, i.markerVersion])
}

/** Version of the plugin currently installed (marker wins, else what the running plugin reports). */
function installedPluginVersion(i: Installed): string {
  return i.markerVersion || i.pluginStatusVersion
}

async function ensureSource(ctx: DeployContext, us: UsageServerConfig): Promise<boolean> {
  const p = paths(ctx)
  const tag = `v${us.version}`
  const script = [
    'set -e',
    `if [ ! -d ${shq(p.src + '/.git')} ]; then git clone -q --depth 1 --branch ${shq(tag)} ${shq(us.repo)} ${shq(p.src)}; exit 0; fi`,
    `cd ${shq(p.src)}`,
    `if [ -n "$(git status --porcelain)" ]; then echo DIRTY; exit 3; fi`,
    `git fetch -q --depth 1 origin ${shq(`refs/tags/${tag}:refs/tags/${tag}`)} --force`,
    `git checkout -q -f ${shq(tag)}`,
  ].join('; ')
  const r = await asApp(ctx, script)
  if (r.exitCode === 3 || r.stdout.includes('DIRTY')) {
    ctx.errors.push({
      phase: 'build',
      message: `[usage-server] ${p.src} has local changes, so deploy leaves it alone. Commit or stash the changes, or remove the folder.`,
      fatal: false,
    })
    return false
  }
  if (r.exitCode !== 0) {
    ctx.errors.push({ phase: 'build', message: `[usage-server] could not fetch ${tag} from ${us.repo}: ${r.stderr.trim()}`, fatal: true })
    return false
  }
  return true
}

type ProxyConfigState = 'ok' | 'not-configured' | 'token-mismatch' | 'no-env'

async function proxyConfigState(ctx: DeployContext): Promise<ProxyConfigState> {
  const p = paths(ctx)
  const script = [
    `test -s ${shq(p.envFile)} || { echo no-env; exit 0; }`,
    `grep -Eq '^[[:space:]]+usage-server:' ${shq(p.config)} || { echo not-configured; exit 0; }`,
    `tok="$(sed -n 's/^USAGE_BRIDGE_TOKEN=//p' ${shq(p.envFile)})"`,
    `grep -Fq "bridge-token: $tok" ${shq(p.config)} && echo ok || echo token-mismatch`,
  ].join('; ')
  const r = (await out(ctx, script)) as ProxyConfigState
  return r || 'not-configured'
}

export async function usageServerBuild(ctx: DeployContext, us: UsageServerConfig): Promise<void> {
  if (!ctx.remote) return
  const p = paths(ctx)
  const tag = `v${us.version}`
  const inst = await inspectInstalled(ctx, us)

  // Guard: the VPS may already run something newer (changes made on the box).
  const newest = newestDeployed(inst)
  if (newest && compareVersions(newest, us.version) > 0) {
    ctx.log.warn(
      `[usage-server] the machine has v${newest}, but this checkout pins v${us.version}. ` +
      `This deploy runs the OLDER version ('up' recreates the container). ` +
      `Update the pin first: bun run bump-usage-server ${newest}`,
    )
  }

  const pluginVer = installedPluginVersion(inst)
  const needImage = !inst.imageForPinExists
  const olderPluginThanPin = !!pluginVer && compareVersions(pluginVer, us.version) < 0
  const needPlugin = !inst.soExists || olderPluginThanPin

  let installedNewPlugin = false

  if (needImage || needPlugin) {
    ctx.log.info(`[usage-server] building ${tag} on the machine${needImage ? ' (image)' : ''}${needPlugin ? ' (plugin)' : ''}`)
    if (!(await ensureSource(ctx, us))) return
    const rev = await out(ctx, `git -C ${shq(p.src)} rev-parse HEAD`)

    if (needImage) {
      // build-host.sh builds image + plugin (into src/plugin/build; nothing is installed from it here).
      const r = await asApp(ctx, `cd ${shq(p.src)} && REVISION=${shq(rev || 'unknown')} scripts/build-host.sh --no-test 2>&1 | tail -15`)
      if (r.exitCode !== 0) {
        ctx.errors.push({ phase: 'build', message: `[usage-server] build failed:\n${r.stdout}${r.stderr}`, fatal: true })
        return
      }
    } else {
      const r = await asApp(ctx, `cd ${shq(p.src)} && scripts/build-plugin.sh 2>&1 | tail -10`)
      if (r.exitCode !== 0) {
        ctx.errors.push({ phase: 'build', message: `[usage-server] plugin build failed:\n${r.stdout}${r.stderr}`, fatal: true })
        return
      }
    }

    if (needPlugin) {
      const inst2 = await asApp(ctx, [
        `cp ${shq(p.src + '/plugin/build/usage-server.so')} ${shq(p.so + '.new')}`,
        `mv -f ${shq(p.so + '.new')} ${shq(p.so)}`,
        `printf '%s\\n' ${shq(us.version)} > ${shq(p.marker)}`,
      ].join(' && '))
      if (inst2.exitCode !== 0) {
        ctx.errors.push({ phase: 'build', message: `[usage-server] could not install plugin: ${inst2.stderr.trim()}`, fatal: true })
        return
      }
      installedNewPlugin = true
    }
  } else if (!inst.markerVersion && pluginVer === us.version) {
    // Plugin was installed by hand (e.g. on the box) at the pinned version: just record it.
    await asApp(ctx, `printf '%s\\n' ${shq(us.version)} > ${shq(p.marker)}`)
  } else if (inst.soExists && !pluginVer) {
    // Installed .so with no recorded version (hand-installed, plugin not loaded yet). Never overwrite it blindly.
    ctx.log.info(
      `[usage-server] ${p.so} is installed but its version is unknown, so deploy leaves it alone. ` +
      `If it is v${us.version}, record that: echo ${us.version} > ${p.marker}   ` +
      `To replace it with the pinned build: rm ${p.so} and deploy again.`,
    )
  }

  // ── Instructions: things deploy will not do ───────────────────────────────
  const proxy = `${ctx.config.stack.projectName}-cli-proxy-api`
  const cfgState = await proxyConfigState(ctx)
  const steps: string[] = []

  if (cfgState === 'not-configured' || cfgState === 'token-mismatch') {
    if (!(await ensureSource(ctx, us))) return
    const edit = `python3 ${p.src}/deploy/edit_config.py`
    steps.push(
      cfgState === 'token-mismatch'
        ? `config.yaml has a usage-server block whose bridge-token differs from ${p.envFile}. Fix the token by hand, or restore the stock block and rerun the steps below.`
        : `The proxy config does not load the plugin yet. Deploy never edits ${p.config} (the proxy rewrites it).`,
      `On the VPS, as ${ctx.config.host.appUser}:`,
      `  1. cp -p ${p.config} ${p.config}.bak-usage-server`,
      `  2. ${edit} check ${p.config} ${p.envFile}`,
      `  3. ${edit} enable ${p.config} ${p.envFile}`,
      `  4. cd ${p.install} && docker compose up -d --no-deps --force-recreate cli-proxy-api     # recreates the proxy (a few seconds); needed to pick up new mounts or plugin`,
      `  5. docker logs ${proxy} 2>&1 | grep 'plugin_id=usage-server'            # expect "loaded" and "registered"`,
      `If step 2 or 3 says the plugins block is not in the expected form, add the block from ${p.src}/deploy/RUNBOOK.md by hand.`,
    )
  } else if (installedNewPlugin) {
    steps.push(
      `A new usage-server.so (v${us.version}) was installed. The running proxy keeps the old one loaded until it restarts:`,
      `  cd ${p.install} && docker compose up -d --no-deps --force-recreate cli-proxy-api     # recreates the proxy (a few seconds); needed to pick up new mounts or plugin`,
    )
  } else if (cfgState === 'no-env') {
    steps.push(`${p.envFile} is missing (post-sync could not create it). Create it with USAGE_BRIDGE_TOKEN and USAGE_API_TOKENS (mode 600).`)
  }

  if (steps.length) {
    ctx.log.warn('[usage-server] ACTION NEEDED: deploy did not restart the proxy. Do these steps:')
    for (const s of steps) ctx.log.warn(`  ${s}`)
  }
  ctx.phaseStatus.push({ phase: 'build', success: true, message: `usage-server v${us.version}${steps.length ? ' — action needed, see log' : ' ready'}` })
}
