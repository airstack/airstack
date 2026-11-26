/**
 * targets.ts — release targets and file names.
 *
 * A release is one tarball per target: airstack-<version>-<os>-<arch>.tar.gz. It holds one dir
 * (airstack-<version>-<os>-<arch>/) with bin/airstack plus the core files (see build.ts).
 */

export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'] as const
export type Target = (typeof TARGETS)[number]

export const RELEASE_REPO = 'airstack/airstack'
export const CHECKSUMS_FILE = 'SHA256SUMS'

/** Files and dirs a release ships next to bin/ (relative to the core root). */
export const CORE_FILES = ['cli/plugins', 'templates', 'stacks', 'deploy', 'LICENSE.md', 'README.md']

export function releaseName(version: string, target: Target): string {
  return `airstack-${version}-${target}`
}

export function tarballName(version: string, target: Target): string {
  return `${releaseName(version, target)}.tar.gz`
}

/** `uname -s` / `uname -m` (or Node's platform/arch) → a target, or undefined if unsupported. */
export function targetFor(os: string, arch: string): Target | undefined {
  const o = os.toLowerCase().startsWith('darwin') ? 'darwin' : os.toLowerCase().startsWith('linux') ? 'linux' : ''
  const a = ['x86_64', 'amd64', 'x64'].includes(arch) ? 'x64' : ['aarch64', 'arm64'].includes(arch) ? 'arm64' : ''
  const t = `${o}-${a}`
  return (TARGETS as readonly string[]).includes(t) ? (t as Target) : undefined
}

export function isTarget(s: string): s is Target {
  return (TARGETS as readonly string[]).includes(s)
}
