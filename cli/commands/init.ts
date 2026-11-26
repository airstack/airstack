/**
 * airstack init [<dir>] — create a new fleet repo skeleton in <dir> (default: the current dir).
 *
 * Controller only, needs no fleet. Writes airstack.yaml (pinned to this airstack's version),
 * .gitignore, machines/web-1.yaml.example, stacks/ plugins/ templates/ (a README each) and
 * .airstack/secrets/_fleet.jsonc (mode 600).
 *
 * Refuses when <dir>/airstack.yaml exists. Never overwrites a file: an existing file is kept as it
 * is (an existing .gitignore only gets the `.airstack/` line appended when it lacks one).
 *
 * The templates are strings in this file: a compiled binary cannot read examples/ from disk.
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { VERSION } from '../lib/core.js'
import { EXIT, type Output } from '../lib/output.js'

export const INIT_USAGE = `Usage: airstack init [<dir>]

Creates a new fleet repo in <dir> (default: the current directory):
  airstack.yaml, .gitignore, machines/web-1.yaml.example, stacks/, plugins/, templates/,
  .airstack/secrets/_fleet.jsonc (mode 600)
Refuses when <dir>/airstack.yaml exists. Never overwrites a file.`

/** Fleet name from the directory name: lowercase letters, digits and dashes. */
export function fleetNameFor(dir: string): string {
  const n = basename(resolve(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return /^[a-z]/.test(n) ? n : n ? `fleet-${n}` : 'my-fleet'
}

// ── templates ───────────────────────────────────────────────────────────────

const airstackYaml = (name: string, version: string) => `# Fleet root marker. airstack finds the fleet through this file:
#   ./airstack.yaml, --fleet <path>, or \`fleet:\` in ~/.config/airstack/config.yaml (never a parent dir).
airstack:
  # The airstack version every machine runs (deploy and \`airstack fleet update\` put it there).
  version: ${version}
fleet:
  name: ${name}
`

const GITIGNORE = `# .airstack/ holds secrets, staged deploy trees, logs and pulled machine files.
# Never commit it. deploy refuses to run when .airstack/ is not gitignored.
.airstack/
`

const MACHINE_EXAMPLE = `# Example machine. To use it:
#   1. Copy this file: cp machines/web-1.yaml.example machines/web-1.yaml
#   2. Change machine: and the file name to your machine's name (they must be the same).
#   3. Set host.ip, host.ssh and host.users for your machine.
#   4. Run: airstack fleet check
# airstack reads only machines/<name>.yaml and machines/<name>/machine.yaml. It ignores this file.
#
# This file describes the FINISHED machine. \`airstack deploy web-1 --install\` gets a fresh box there.
machine: web-1

host:
  hostname: web-1
  ip: 192.0.2.10                 # or a secret: ip: \${WEB1_IP}
  timezone: UTC
  ssh:
    user: adminroot              # the admin who runs deploys (default: users.sudo)
    port: 222                    # SSH port after setup (default 222)
    key: ~/.ssh/id_ed25519       # private key on this controller
    # bootstrapPort: 22          # a fresh box answers here (default 22) ...
    # bootstrapUser: root        # ... as this user (default root)
  users:
    sudo: adminroot              # admin: sudo + SSH key
    stack: stackroot             # stack owner: root Docker daemon, no login
    dev: []                      # dev accounts, each with its own rootless Docker
    admins: [adminroot]          # may run \`airstack machine ...\` on the box without full sudo

# root: /srv/airstack            # machine root (default /srv/airstack)

# Machine-level plugins. Built-in plugins always start with airstack/.
plugins:
  airstack/cron:
    defaultTimezone: UTC
    crons:
      host_cleanup:
        schedule: "4:00 AM"
      # host_alerter:
      #   schedule: "*/15 * * * *"
      #   env:
      #     TELEGRAM_BOT_TOKEN: \${HOSTALERT_TELEGRAM_BOT_TOKEN}
      #     TELEGRAM_CHAT_ID: \${HOSTALERT_TELEGRAM_CHAT_ID}
  # airstack/cloudflare:
  #   tunnelToken: \${CLOUDFLARE_TUNNEL_TOKEN}
  #   access: { required: true, onDeploy: refuse, onScan: alert }

# Stack instances: instance name -> overlay. No \`stack:\` key = stacks/<instance name>/ in this repo.
stacks: {}
#  hello:
#    values: { port: 8080 }
#  cliproxy:
#    stack: airstack/cliproxy
`

const STACKS_README = `# stacks/

One directory per reusable stack: \`stacks/<name>/stack.yaml\`, plus an optional
\`compose.yaml.hbs\` and \`deploy/\` directory.

A machine file runs a stack as an instance:

\`\`\`yaml
stacks:
  hello: {}              # uses stacks/hello/
  hello-2:
    stack: hello         # the same stack again, as a second instance
    values: { port: 8081 }
\`\`\`

Built-in stacks start with \`airstack/\` (for example \`airstack/cliproxy\`). A bare name
never falls back to a built-in.
`

const PLUGINS_README = `# plugins/

One directory per fleet plugin: \`plugins/<name>/index.ts\` exports \`register(config)\`.
Machine and stack files use it by its bare name (\`<name>\`). Built-in plugins start
with \`airstack/\`. A bare name never falls back to a built-in.
`

const TEMPLATES_README = `# templates/

Fleet-wide template overrides. When a stack or plugin names a template file that is not in
its own directory, deploy looks here first, then in airstack's built-in templates.
`

const SECRETS = `{
  // Secrets shared by every machine. Keep this file mode 600 and never commit it.
  // Per-machine values go in .airstack/secrets/<machine>.jsonc (they win over this file).
  // Format: a flat map of NAME: value. Config files use them as \${NAME} or \${NAME:-default}.
  // "CLOUDFLARE_TUNNEL_TOKEN": "..."
}
`

// ── command ─────────────────────────────────────────────────────────────────

export function initCommand(args: string[], out: Output, cwd: string = process.cwd()): number {
  if (args.includes('--help') || args.includes('-h')) {
    out.info(INIT_USAGE)
    return EXIT.OK
  }
  const bad = args.find((a) => a.startsWith('-'))
  const pos = args.filter((a) => !a.startsWith('-'))
  if (bad || pos.length > 1) {
    out.fail(bad ? `unknown option: ${bad}` : 'init takes at most one directory')
    out.next('airstack init --help')
    return EXIT.USAGE
  }
  return initFleet(resolve(cwd, pos[0] ?? '.'), out, cwd)
}

export function initFleet(dir: string, out: Output, cwd: string = process.cwd()): number {
  const show = (p: string) => relative(cwd, p) || '.'
  const marker = join(dir, 'airstack.yaml')
  if (existsSync(marker)) {
    out.fail(`blocked: ${show(marker)} already exists; init never overwrites a fleet`)
    out.next(`airstack --fleet ${show(dir)} fleet check`)
    return EXIT.USAGE
  }
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    out.fail(`${show(dir)} exists and is not a directory`)
    return EXIT.USAGE
  }

  const dirs: [string, number][] = [
    [dir, 0o755], [join(dir, 'machines'), 0o755], [join(dir, 'stacks'), 0o755],
    [join(dir, 'plugins'), 0o755], [join(dir, 'templates'), 0o755],
    [join(dir, '.airstack'), 0o700], [join(dir, '.airstack', 'secrets'), 0o700],
  ]
  for (const [d, mode] of dirs) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode })
  }

  // airstack.yaml last: a failed init leaves no marker, so it can run again.
  const files: [string, string, number][] = [
    ['.gitignore', GITIGNORE, 0o644],
    ['machines/web-1.yaml.example', MACHINE_EXAMPLE, 0o644],
    ['stacks/README.md', STACKS_README, 0o644],
    ['plugins/README.md', PLUGINS_README, 0o644],
    ['templates/README.md', TEMPLATES_README, 0o644],
    ['.airstack/secrets/_fleet.jsonc', SECRETS, 0o600],
    ['airstack.yaml', airstackYaml(fleetNameFor(dir), VERSION), 0o644],
  ]
  for (const [rel, content, mode] of files) {
    const p = join(dir, rel)
    if (existsSync(p)) {
      if (rel === '.gitignore') {
        if (/^\/?\.airstack\/?\s*$/m.test(readFileSync(p, 'utf8'))) out.ok(`kept ${show(p)} (already ignores .airstack/)`)
        else {
          const text = readFileSync(p, 'utf8')
          appendFileSync(p, `${text === '' || text.endsWith('\n') ? '' : '\n'}\n${GITIGNORE}`)
          out.ok(`added .airstack/ to ${show(p)}`)
        }
      } else {
        out.warn(`kept ${show(p)} (exists; not overwritten)`)
      }
      continue
    }
    try {
      writeFileSync(p, content, { mode, flag: 'wx' })
      chmodSync(p, mode) // the umask may have removed bits; 600 must be exact for secrets
    } catch (e) {
      out.fail(`cannot write ${show(p)}: ${e instanceof Error ? e.message : String(e)}`)
      return EXIT.FAIL
    }
    out.ok(`created ${show(p)}${mode === 0o600 ? ' (mode 600)' : ''}`)
  }
  out.info(`fleet ${fleetNameFor(dir)} pins airstack ${VERSION}`)

  // Next steps.
  if (show(dir) !== '.') out.next(`cd ${show(dir)}`)
  if (!insideGitRepo(dir)) out.next('git init')
  out.next('cp machines/web-1.yaml.example machines/web-1.yaml   (then edit host.ip, host.ssh, host.users)')
  out.next('airstack fleet check')
  out.next('airstack deploy web-1 --install   (first-time setup of a fresh box)')
  return out.code()
}

function insideGitRepo(dir: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  return r.status === 0 && r.stdout.trim() === 'true'
}
