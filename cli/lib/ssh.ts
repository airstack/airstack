/**
 * SSH remote executor — runs commands and rsyncs files to a VPS.
 *
 * Supports two connection modes (see SSHConfig.viaTunnel):
 *   - direct: `ssh -p <port> -i <key> user@ip`
 *   - tunnel: routes through Cloudflare Access via `cloudflared access ssh`.
 *             A per-host ssh config is materialized with the ProxyCommand so
 *             every tool (ssh, scp, rsync) can share it via `-F`.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RemoteExecutor, SSHConfig, HostConfig, DeployLogger, RunOptions } from '../types.js'

/** Expand a leading ~ in a key path to $HOME. */
export function expandKey(keyPath: string): string {
  return keyPath.replace(/^~/, process.env.HOME || '')
}

/** The hostname ssh actually connects to: the tunnel hostname in tunnel mode, else the IP. */
export function connectHost(ssh: SSHConfig): string {
  return ssh.viaTunnel && ssh.tunnelHostname ? ssh.tunnelHostname : ssh.host
}

/** `user@host` connection target. */
export function userHost(ssh: SSHConfig): string {
  return `${ssh.user}@${connectHost(ssh)}`
}

/** Build an SSHConfig from host config, selecting tunnel mode when sshExpose === 'tunnel'. */
export function sshConfigFromHost(host: HostConfig): SSHConfig {
  const viaTunnel = host.sshExpose === 'tunnel'
  return {
    host: host.ip,
    port: host.sshPort,
    user: host.sshUser,
    keyPath: host.sshKey,
    viaTunnel,
    tunnelHostname: host.sshTunnelHostname || undefined,
  }
}

/**
 * Materialize an ssh config file carrying the cloudflared ProxyCommand.
 * Returns its path. Using a config file (rather than inline `-o ProxyCommand=...`)
 * keeps the rsync `-e` string free of spaces, which rsync cannot parse.
 */
function tunnelConfigPath(ssh: SSHConfig): string {
  const hostname = ssh.tunnelHostname || ssh.host
  const content =
    [
      `Host ${hostname}`,
      `  HostName ${hostname}`,
      `  User ${ssh.user}`,
      `  IdentityFile ${expandKey(ssh.keyPath)}`,
      `  StrictHostKeyChecking accept-new`,
      `  BatchMode yes`,
      `  ProxyCommand cloudflared access ssh --hostname ${hostname}`,
    ].join('\n') + '\n'
  const dir = join(tmpdir(), 'stack-cli-ssh')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${hostname.replace(/[^a-zA-Z0-9._-]/g, '_')}.conf`)
  writeFileSync(path, content, { mode: 0o600 })
  return path
}

/**
 * Connection args for `ssh`/`scp`.
 *   - tunnel mode: `-F <config>` (ProxyCommand lives in the config)
 *   - direct mode: `-i <key> -o StrictHostKeyChecking=accept-new [-o BatchMode=yes] -p/-P <port>`
 */
export function sshArgs(
  ssh: SSHConfig,
  { scp = false, batchMode = true }: { scp?: boolean; batchMode?: boolean } = {},
): string[] {
  if (ssh.viaTunnel) {
    return ['-F', tunnelConfigPath(ssh)]
  }
  const key = expandKey(ssh.keyPath)
  const args = [...(key ? ['-i', key] : []), '-o', 'StrictHostKeyChecking=accept-new']
  if (batchMode) args.push('-o', 'BatchMode=yes')
  args.push(scp ? '-P' : '-p', String(ssh.port))
  return args
}

/** rsync `-e` value — a single ssh command string (must contain no spaces in option values). */
export function rsyncRsh(ssh: SSHConfig): string {
  if (ssh.viaTunnel) {
    return `ssh -F ${tunnelConfigPath(ssh)}`
  }
  const key = expandKey(ssh.keyPath)
  return `ssh -p ${ssh.port}${key ? ` -i '${key}'` : ''} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`
}

export function createRemoteExecutor(ssh: SSHConfig): RemoteExecutor {
  const target = userHost(ssh)
  const baseArgs = sshArgs(ssh)
  const rsh = rsyncRsh(ssh)

  return {
    async run(command: string, opts?: RunOptions) {
      const proc = Bun.spawn(['ssh', ...baseArgs, target, command], {
        stdin: opts?.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const [stdout, stderr] = await Promise.all([
        readLines(proc.stdout as ReadableStream<Uint8Array>, opts?.onStdout),
        readLines(proc.stderr as ReadableStream<Uint8Array>, opts?.onStderr),
      ])

      const exitCode = await proc.exited
      return { stdout, stderr, exitCode }
    },

    async rsync(src: string, dest: string, opts: string[] = []) {
      const proc = Bun.spawn(['rsync', '-avz', '-e', rsh, '--rsync-path=sudo rsync', ...opts, src, `${target}:${dest}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      return { exitCode }
    },

    async download(src: string, dest: string, opts: string[] = []) {
      const proc = Bun.spawn(['rsync', '-az', '-e', rsh, '--rsync-path=sudo rsync', ...opts, `${target}:${src}`, dest], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      return { exitCode }
    },
  }
}

/** Read a ReadableStream line-by-line, buffering and optionally calling back per line. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const buf: string[] = []
  let partial = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const text = partial + decoder.decode(value, { stream: true })
    const lines = text.split('\n')
    partial = lines.pop() || ''
    for (const line of lines) {
      buf.push(line)
      onLine?.(line)
    }
  }
  // Flush remaining partial line
  if (partial) {
    buf.push(partial)
    onLine?.(partial)
  }

  return buf.join('\n')
}

export function createLoggingExecutor(executor: RemoteExecutor, log: DeployLogger): RemoteExecutor {
  return {
    async run(command: string, opts?: RunOptions) {
      log.debug(`$ ${command}`)
      const start = Date.now()
      const result = await executor.run(command, opts)
      const dur = Date.now() - start
      if (result.exitCode !== 0) {
        log.debug(`  exit=${result.exitCode} (${dur}ms) stderr=${result.stderr.trim().slice(0, 300)}`)
      } else {
        log.debug(`  exit=0 (${dur}ms)`)
      }
      return result
    },

    download: executor.download?.bind(executor),

    async rsync(src: string, dest: string, opts: string[] = []) {
      log.debug(`rsync ${src} → ${dest} ${opts.join(' ')}`)
      const start = Date.now()
      const result = await executor.rsync(src, dest, opts)
      log.debug(`  rsync exit=${result.exitCode} (${Date.now() - start}ms)`)
      return result
    },
  }
}

export function createMockExecutor(
  responses?: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>,
): RemoteExecutor & { calls: { type: 'run' | 'rsync'; args: string[] }[] } {
  const calls: { type: 'run' | 'rsync'; args: string[] }[] = []
  return {
    calls,
    async run(command: string, _opts?: RunOptions) {
      calls.push({ type: 'run', args: [command] })
      const r = responses?.[command]
      return { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '', exitCode: r?.exitCode ?? 0 }
    },
    async rsync(src: string, dest: string, opts: string[] = []) {
      calls.push({ type: 'rsync', args: [src, dest, ...opts] })
      return { exitCode: 0 }
    },
  }
}
