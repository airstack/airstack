/**
 * Remote script execution — SCP scripts to VPS and execute them.
 * Used by vps-setup commands to run distro-specific setup scripts.
 */

import { join } from 'node:path'
import { existsSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolveFile } from './resolve-file.js'
import { tmpdir } from 'node:os'
import { sshArgs, userHost } from './ssh.js'
import type { RemoteExecutor, SSHConfig } from '../types.js'

/** Detect the Linux distribution on the remote VPS. */
export async function detectDistro(remote: RemoteExecutor): Promise<string> {
  const result = await remote.run('grep ^ID= /etc/os-release')
  if (result.exitCode !== 0) {
    throw new Error('Failed to detect distro: could not read /etc/os-release')
  }
  // ID=ubuntu → ubuntu
  const match = result.stdout.trim().match(/^ID=(.+)$/)
  if (!match) {
    throw new Error(`Failed to parse distro from: ${result.stdout.trim()}`)
  }
  return match[1].replace(/"/g, '').toLowerCase()
}

/** Resolve the local path to a distro-specific setup script. */
export function resolveScript(
  projectRoot: string,
  sharedPaths: string[],
  distro: string,
  scriptName: string,
): string {
  const relativePath = `deploy/setup/${distro}/${scriptName}.sh`
  try {
    return resolveFile(projectRoot, sharedPaths, relativePath)
  } catch {
    // Provide helpful error listing available distros from all search paths
    const searchDirs = [projectRoot, ...sharedPaths]
    const available = new Set<string>()
    for (const dir of searchDirs) {
      const setupDir = join(dir, 'deploy', 'setup')
      if (existsSync(setupDir)) {
        for (const d of readdirSync(setupDir, { withFileTypes: true })) {
          if (d.isDirectory()) available.add(d.name)
        }
      }
    }
    throw new Error(
      `Setup script not found: ${relativePath}\n` +
      (available.size > 0
        ? `Available distros: ${[...available].join(', ')}`
        : `No distro directories found in deploy/setup/`)
    )
  }
}

export interface ScriptResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ExecuteScriptOpts {
  ssh: SSHConfig
  scriptPath: string
  envVars?: Record<string, string>
  stream?: boolean  // stream output in real-time (default: true)
}

/**
 * SCP a script + env file to the VPS and execute it.
 * Returns the result. If stream=true, output is printed in real-time.
 */
export async function executeSetupScript(opts: ExecuteScriptOpts): Promise<ScriptResult> {
  const { ssh, scriptPath, envVars = {}, stream = true } = opts

  const scpBase = ['scp', '-q', ...sshArgs(ssh, { scp: true })]
  const sshTarget = userHost(ssh)

  // 1. Write temp env file locally
  let localEnvPath: string | null = null
  if (Object.keys(envVars).length > 0) {
    localEnvPath = join(tmpdir(), `stack-cli-setup-env-${Date.now()}`)
    const envContent = Object.entries(envVars)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join('\n') + '\n'
    writeFileSync(localEnvPath, envContent, { mode: 0o600 })
  }

  try {
    // 2. SCP env file (if any)
    if (localEnvPath) {
      const scpEnv = Bun.spawn([...scpBase, localEnvPath, `${sshTarget}:/tmp/stack-cli-setup-env`], {
        stdout: 'pipe', stderr: 'pipe',
      })
      if (await scpEnv.exited !== 0) {
        const err = await new Response(scpEnv.stderr).text()
        throw new Error(`Failed to upload env file: ${err.trim()}`)
      }
    }

    // 3. SCP script
    const scpScript = Bun.spawn([...scpBase, scriptPath, `${sshTarget}:/tmp/stack-cli-setup-script.sh`], {
      stdout: 'pipe', stderr: 'pipe',
    })
    if (await scpScript.exited !== 0) {
      const err = await new Response(scpScript.stderr).text()
      throw new Error(`Failed to upload script: ${err.trim()}`)
    }

    // 4. Execute
    const sourceCmd = localEnvPath ? 'source /tmp/stack-cli-setup-env && ' : ''
    const remoteCmd = `sudo bash -c '${sourceCmd}bash /tmp/stack-cli-setup-script.sh'`

    const execArgs = [
      'ssh',
      ...sshArgs(ssh),
      sshTarget,
      remoteCmd,
    ]

    let stdout = ''
    let stderr = ''
    let exitCode: number

    if (stream) {
      // Stream output in real-time, but also capture it
      const proc = Bun.spawn(execArgs, {
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // Stream stdout line by line
      const stdoutReader = proc.stdout.getReader()
      const stderrReader = proc.stderr.getReader()
      const decoder = new TextDecoder()

      const readStream = async (reader: ReadableStreamDefaultReader<Uint8Array>, target: 'stdout' | 'stderr') => {
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          buf += text
          if (target === 'stdout') {
            stdout += text
            process.stdout.write(text)
          } else {
            stderr += text
            process.stderr.write(text)
          }
        }
      }

      await Promise.all([
        readStream(stdoutReader, 'stdout'),
        readStream(stderrReader, 'stderr'),
      ])
      exitCode = await proc.exited
    } else {
      const proc = Bun.spawn(execArgs, { stdout: 'pipe', stderr: 'pipe' })
      stdout = await new Response(proc.stdout).text()
      stderr = await new Response(proc.stderr).text()
      exitCode = await proc.exited
    }

    return { exitCode, stdout, stderr }
  } finally {
    // 5. Clean up local temp file
    if (localEnvPath) {
      try { unlinkSync(localEnvPath) } catch {}
    }

    // 6. Clean up remote temp files (best-effort)
    const cleanupArgs = [
      'ssh',
      ...sshArgs(ssh),
      sshTarget,
      'sudo rm -f /tmp/stack-cli-setup-env /tmp/stack-cli-setup-script.sh',
    ]
    const cleanup = Bun.spawn(cleanupArgs, { stdout: 'pipe', stderr: 'pipe' })
    await cleanup.exited
  }
}

/** Shell-quote a value for use in env file. */
function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_/.:@~=-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Test SSH connectivity to VPS. Returns true if reachable.
 */
export async function testSSHConnection(ssh: SSHConfig, timeoutSec = 5): Promise<boolean> {
  const proc = Bun.spawn([
    'ssh',
    ...sshArgs(ssh),
    '-o', `ConnectTimeout=${timeoutSec}`,
    userHost(ssh),
    'echo ok',
  ], { stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await proc.exited
  return exitCode === 0
}
