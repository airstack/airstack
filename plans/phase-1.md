# airstack — Phase 1: fleet repo, multi-machine deploy, modes

Status: approved. Step 1 (copy, openclaw removal, leak scan) done, not yet committed.
Test machine: `airstack-test1`.
Source: a fresh copy of stack-cli (`../stack-cli`, HEAD `fc05a0f`). stack-cli stays as it is.

## 0. Where phase 1 sits

| Phase | Scope |
|---|---|
| **1 (this doc)** | Core/fleet split, fleet loader, machine + stack merge, `airstack/` namespace, plugin scopes, modes and guards, `whoami`, multi-machine `deploy`, one compose project per stack instance |
| 2 | `.stack/.git` on the node, `incoming/<source>` branches, three-way merge in a separate worktree, `.stack-base`, `pull`, drift guard, file modes (`rendered` / `seeded` / `state`), redaction library, redacted diffs |
| 3 | Node CLI: `airstack machine …` read verbs, sudo helper, alerter checks folded in, `config read/diff` |
| 4 | Repair verbs, `doctor`, version tools (`update`, `install <v>`, `versions`, `fleet update`, `fleet install`), binary push, protocol check |
| later | `age` encryption of `.airstack/`, `--json`, TUI, MCP wrapper, admin bot, marketplace stacks |

Phase 1 is done when a fleet repo with two machines (the new test VPS + a second entry, which can
point at the same VPS under another name) deploys per machine, with two instances of one stack on one
machine, both run users, and every guard rule covered by tests.

## 1. Ground rules (go into AGENTS.md verbatim)

1. **The CLI guards against accidents. It is NOT a security boundary.** Anyone can copy the binary
   and remove a check. Real limits are Unix permissions, the `stackroot`-only `.stack/.git`, and
   sudoers rules. Never weaken those because "the CLI checks it". Never add a CLI check and call
   it security.
2. **Only root-owned config can widen what the CLI may do.** User config and env vars may only
   turn things off.
3. **Bare top-level verbs act on this machine only.** Anything that touches another machine lives
   under `fleet`, `deploy` or `ssh`. No `--machine` / `--on` flags on local verbs.
4. **No directory walks.** The fleet is `./airstack.yaml`, `--fleet <path>`, or the `fleet:` default
   in `~/.config/airstack/config.yaml`. Never a parent dir.
5. **Never litter a controller.** A controller install writes one binary; config only when the user
   sets something; all state in the fleet repo's `.airstack/`.
6. **The user's fleet config never enters this repo.** Tests use fixtures under `test/fixtures/`.
7. Output is concise text for agents: stable line prefixes (`ok`, `warn`, `fail`, `->` next step),
   meaningful exit codes (0 ok, 1 warnings, 2 failures, 3 usage/blocked). All output goes through one
   formatter so `--json` can be added later.

## 2. Copy plan (step 1 of the build)

Copy **tracked files only** (`git ls-files`), so local `stack.yml`, `.env`, `.deploy/`, backups and
reports cannot come along. Then drop what does not belong in airstack.

**Keep:** `cli/`, `deploy/setup/`, `templates/`, `test/`, `package.json`, `bun.lock`, `tsconfig.json`,
`vitest.config.mjs`, `LICENSE.md` (check holder/year), docs: `CLIPROXYAPI`, `CLOUDFLARE-TUNNEL`,
`HOST-CLEANUP`, `HOST-SECURITY`, `LAYOUT`, `SECURITY`, `TELEGRAM`, `TESTING`, `VPS-SETUP-GUIDE`,
`plugin-guide`, `assets/telegram-host-alerter-report.png`.

**Drop:** `notes/`, `plans/` (all 136+ openclaw-era plans), `docs/superpowers/`, `CLI2_PORT_STATUS.md`,
`TASKS.md`, `__CLAUDE_IGNORE.md`, `.claude/settings.local.json`, `.claudeignore`, root `stack-cli`
launcher, `stack.yml.example`, `.env.example` (replaced by fleet examples), `devutils/asciinema/`,
`devutils/sync-public.sh`, `devutils/fix-flow-diagrams.ts`, `devutils/rename-with-date.sh`,
`.github/workflows/sync-releases.yml` (review first), openclaw-only docs (`AI-GATEWAY-CONFIG`,
`SANDBOX-TOOLKIT`, `DASHBOARD`, `CLAUDE-SUBSCRIPTION`, `CODEX-SUBSCRIPTION`) and their screenshots,
`docker-compose.yml.hbs` at the root (moves into stacks, section 6). All openclaw code is
removed (done): cf-tunnel keeps `verify` (now checks every ingress hostname), `verify-api-token`,
`list-tunnels`, `create-tunnel`; `setup`, `setup-routes`, `setup-access` and `lib/cf-access.ts` are
gone. Openclaw-only docs (`TESTING`, `SECURITY`, `VPS-SETUP-GUIDE`, `CLOUDFLARE-TUNNEL`) are dropped
and get rewritten for airstack later. Tunnel routes come back as stack-declared routes later.
Openclaw support, if wanted, is a plugin.

**Leak scan before every commit** (must return nothing; `devutils/leak-scan.sh`, also run by a local pre-commit hook): any IPv4/IPv6 outside private and documentation ranges, the owner's real fleet values (IPs, domains,
tailnet names, machine names, chat IDs) kept in a local scan list that is never committed
(`.git/info/leakscan`), plus generic key shapes (`AIza…`, `sk-…`, `ghp_…`, Telegram bot tokens).
Test fixtures use documentation addresses only (`203.0.113.0/24`, `198.51.100.0/24`, `100.64.0.0/10`).
`adminroot`/`stackroot`/`deployuser` in `docs/LAYOUT.md` are generic example names and stay.

**Renames:** `stack-cli` → `airstack` (bin, help text, env prefix `STACK_CLI_*` → `AIRSTACK_*`),
`stack.yml` → `stack.yaml`, `docker-compose.yml` → `compose.yaml` on the box, `.deploy/` →
`.airstack/deploy/<machine>/`. Fresh git history.

## 3. Fleet repo layout

```
airstack.yaml                 # fleet root marker + version pin
machines/
  airstack-test1.yaml                  # simple form
  ops2/machine.yaml           # dir form, may hold deploy/ files (e.g. security.d/)
stacks/
  nodestack/
    stack.yaml
    compose.yaml.hbs          # optional, the stack's own services
    deploy/                   # optional, copied into the instance's installDir
    templates/                # optional, stack-local template overrides
plugins/                      # fleet plugins (bare names)
templates/                    # fleet-wide template overrides
.airstack/                    # the ONLY gitignored dir (deploy refuses if it is not ignored)
  secrets/
    _fleet.jsonc              # values shared by all machines (optional)
    airstack-test1.jsonc               # per machine; wins over _fleet
  deploy/<machine>/           # staged tree (phase 2 adds .stack-base here)
  logs/<machine>/<timestamp>/
  reports/<machine>.md
```

- A machine defined in both forms is an error.
- `machine:` key is required and must equal the file/dir name.
- `airstack.yaml` (phase 1):

  ```yaml
  airstack:
    version: 0.1.0      # pin; phase 1 only warns on mismatch, phase 4 enforces/rolls out
  fleet:
    name: joe-fleet     # used for incoming/<source> naming later and in whoami
  ```

## 4. Config model

### 4.1 Machine file

```yaml
machine: airstack-test1
host:
  hostname: airstack-test1
  ip: ${TEST1_IP}
  timezone: America/Los_Angeles
  ssh: { user: adminroot, port: 222, key: ~/.ssh/id_ed25519, expose: public }   # expose: public|tunnel, tunnelHostname
  users:
    sudo: adminroot
    stack: stackroot          # was APP_USER
    dev: [deployuser]
    brewOwner: deployuser
root: /home/deploy            # machine root: machine-level files, logs, state; .stack/ in phase 2
plugins:                      # machine-scope plugins only
  airstack/cron:
    defaultTimezone: America/Los_Angeles
    crons:
      host_alerter: { schedule: "*/15 * * * *", env: { TELEGRAM_BOT_TOKEN: ${HOSTALERT_TELEGRAM_BOT_TOKEN} } }
  airstack/tailscale: { ports: [8317], serve: [] }
  airstack/cloudflare: { tunnelToken: ${CLOUDFLARE_TUNNEL_TOKEN} }
stacks:                       # map: instance name -> overlay on the referenced stack
  cliproxy:
    stack: airstack/cliproxy
    user: stackroot
  devstack:
    stack: nodestack
    user: deployuser
    values: { port: 3001 }
  teststack:
    stack: nodestack
    user: deployuser
    values: { port: 3002 }
  wiki: {}                    # no stack: key -> stacks/wiki/ in the fleet repo
```

### 4.2 Stack file (reusable)

```yaml
# stacks/nodestack/stack.yaml
user: stackroot               # default run user; the machine entry may override
installDir: null              # default computed, see 4.5
values:                       # free-form; templates read {{values.*}} (was {{stack.*}})
  port: 3000
templates:                    # dest -> src, as today
  compose.yaml: { src: compose.yaml.hbs }
plugins:                      # stack-scope plugins
  airstack/cron:
    crons:
      backup: "3:00 AM"       # becomes <instance>.backup on the box
deploy:
  sync: { default: delete, preserve: [data/] }
```

### 4.3 References

| Form | Resolves to | Notes |
|---|---|---|
| `stack: nodestack` | fleet `stacks/nodestack/` only | never falls back to a built-in |
| `stack: airstack/cliproxy` | core built-in `stacks/cliproxy/` | |
| plugin `cron` | fleet `plugins/cron/` only | |
| plugin `airstack/cron` | core built-in plugin | |
| `<publisher>/<name>` (other) | error in phase 1: "marketplace refs not supported yet" | reserved |
| `…@<version>` | error in phase 1: "versions not supported yet" | reserved |

A bare name that is missing in the fleet but exists as a built-in fails with
`-> did you mean airstack/<name>?`. It never loads the built-in.

Instance names: `[a-z][a-z0-9-]*`, unique per machine (map keys enforce it; the YAML loader must
reject duplicate keys, which js-yaml does by default; a test pins this).

### 4.4 Merge rules

Order, lowest to highest: core defaults → stack.yaml → machine `stacks.<instance>` overlay.
Machine-scope config (`host`, `root`, machine `plugins`) is not merged with stacks.

- Maps merge deeply; the higher layer wins per key.
- Lists replace whole. Anything that needs merging by name is a map keyed by name (crons already are).
- `null` deletes an inherited key.
- `stack:` is the only reserved key in a machine overlay; everything else overlays stack.yaml.
- `<<+` (current defaults feature) is kept, resolved per file before the merge.
- Merge returns the value **and an origin map** (`default` / `stack:<file>` / `machine:<file>`)
  for `fleet config`.

### 4.5 Secrets (`${VAR}`)

- `${VAR}` / `${VAR:-default}` resolve from `.airstack/secrets/<machine>.jsonc`, then
  `_fleet.jsonc`. JSONC (comments allowed), flat `NAME: value` map. A reusable stack's `${VAR}`
  resolves against the machine it is deployed to.
- **Change from stack-cli:** substitute **after** YAML parse, inside string scalars only. Today the
  text is substituted before parsing, so a secret with `:`/`#`/newline can change YAML structure.
- A missing `${VAR}` with no default is a config error listing every missing name (today it silently
  becomes `''`).
- The value set is kept on the loaded config for phase 2 redaction. No encryption in phase 1.

### 4.6 Plugin scopes

Each plugin declares `scope: 'machine' | 'stack' | 'any'` (on the object `register()` returns;
a `plugin.yaml` manifest can come later without a config migration). A machine-only plugin in a stack,
or a stack-only plugin at machine level, is a `fleet check` error.

| Built-in | Scope | Notes |
|---|---|---|
| `airstack/tailscale` | machine | |
| `airstack/cloudflare` | machine | one tunnel per machine; routes can come from stacks later |
| `airstack/cron` | any | machine crons keep their names; stack crons become `<instance>.<name>` |
| `airstack/backup` | stack | |
| `airstack/cliproxyapi` | stack | used by the built-in `airstack/cliproxy` stack |

Host-only checks (`host_alerter`, `host_cleanup`, `host_maintenance`, `host_security`) can only be
configured at machine level. A stack defining a cron with a `host_` prefix fails `fleet check`.

## 5. Modes and guards

### 5.1 Resolution

```
/etc/airstack/machine.yaml exists?
├─ yes → NODE mode
│    file owned by root and not group/world writable?  no → refuse every mutating verb
│    roles: [node]               → node verbs only (phase 3+); deploy/fleet/ssh blocked
│    roles: [node, controller]   → also controller verbs, fleet = controller.fleet path ONLY
│    ~/.config/airstack, AIRSTACK_* env: may only disable verbs
└─ no  → CONTROLLER mode
     ~/.config/airstack/config.yaml (optional): fleet default, disabled verbs
     fleet = --fleet <path> | ./airstack.yaml | config fleet: default   (no walk)
     node verbs blocked: "not a node: run on the machine via 'airstack ssh <m> -- airstack …'"
```

- Each verb is registered with `requires: 'controller' | 'node' | 'any'` and an optional
  `needsFleet`. The dispatcher checks this before loading anything else.
- Blocked verbs print one line naming the file and key that decided it, exit 3:
  `blocked: deploy needs controller role (/etc/airstack/machine.yaml roles: [node])`
- On a node, `./airstack.yaml` is ignored even when present (the guard against a fleet clone on a
  node). A test covers: node-only machine + fleet clone in cwd + `airstack deploy` → blocked.
- `~/.config/airstack/config.yaml` is never created by the CLI unless a user sets a value.

### 5.2 `/etc/airstack/machine.yaml`

Written by `airstack deploy <m> --install` (and refreshed on every deploy), root:root 644:

```yaml
machine: airstack-test1
fleet: joe-fleet
roles: [node]
paths:
  root: /home/deploy
  stackUser: stackroot
  adminGroup: airstack-admin    # created in phase 3
stacks:                         # instance -> where it lives, who runs it
  cliproxy: { installDir: /home/deploy/stacks/cliproxy, user: stackroot }
  devstack: { installDir: /home/deployuser/airstack/devstack, user: deployuser }
update:
  source: controller
  allowSourceUpdate: false
```

This is the only global marker. Every node-side path comes from here. The existing
`/etc/stacks/<instance>.env` manifests stay (host scripts read them via `lib/stacks.sh`).

## 6. Compose: one project per stack instance

- Project name = instance name (`docker compose -p cliproxy`). Optional overlay key
  `composeProject:` keeps an old name (lets an existing production box migrate later without renaming containers).
- File on the box: `<installDir>/compose.yaml`, mode 600 (it can carry secrets).
- Stack services come from the stack's `compose.yaml.hbs` plus stack-scope plugin `composeServices`
  rendered for that instance. Built-in `airstack/cliproxy` ships a stack whose compose comes from the
  `airstack/cliproxyapi` plugin.
- Machine-scope plugins that contribute services (cloudflared) render into a **machine compose
  project** named `airstack` at `<root>/machine/compose.yaml`, run by the stack user.
- Networks:
  - The machine project creates the shared bridge network `airstack` (pinned subnet, default
    `10.200.0.0/24`, today's `stack-net` value, configurable as `host.dockerSubnet`).
  - Root-daemon stacks may join it as an external network to be reachable by the tunnel.
  - **A rootless stack cannot join it** (different daemon). It talks to root-daemon services through
    host loopback ports only. `fleet check` errors if a `user:` dev stack references the `airstack`
    network. Documented in LAYOUT.md.
- Run users:
  - `user` = `host.users.stack` → `sudo -u <user> docker compose …` (root daemon).
  - `user` in `host.users.dev` → `sudo -u <user> env DOCKER_HOST=unix:///run/user/<uid>/docker.sock
    docker compose …` (uid looked up on the box, never trusted from config).
  - Any other user → config error.
- Install dirs (default when the overlay and stack give none):
  - stack-user stacks: `<root>/stacks/<instance>` (owned by the stack user, 750).
  - dev-user stacks: `/home/<user>/airstack/<instance>` (owned by that user, 750). They cannot live
    under `<root>`, which is the stack user's 750 dir.
- `fleet check` fails on two instances publishing the same host port (parsed from rendered compose
  `ports:` and `network_mode: host` plugins that declare their ports).

## 7. Commands (phase 1)

```
airstack whoami                          any       mode, machine/fleet, user, version, enabled verb groups + why
airstack version                         any
airstack help [verb]                     any

airstack fleet list                      ctrl      machines, their stacks, last deploy (from .airstack/reports)
airstack fleet show <machine>            ctrl      resolved machine summary
airstack fleet config <machine> [<inst>] ctrl      merged config, each key tagged default/stack/machine; secrets shown as ${NAME}
airstack fleet check [<machine>...]      ctrl      offline validation: refs, scopes, missing secrets, ports, networks, names
airstack fleet logs <m> <inst>[/<svc>]   ctrl      transitional until `machine logs` (phase 3); then a thin ssh wrapper
airstack fleet plugin <m> <cmd> [args]   ctrl      plugin sub-commands (cf-tunnel, backup, tailscale …) for that machine
airstack status [<targets>]              ctrl      per machine: containers per instance, crons, tailscale (today's status.ts)

airstack deploy <targets> [--stack <inst>] [--stage | --dry-run] [--force] [--prune]
airstack deploy <machine> --install [--step base|harden|reboot|docker|rootless|tailscale|brew-shim|verify|lockdown]
airstack ssh <machine> [-- <cmd>]        ctrl
```

- `<targets>`: machine names, `--all`, or a `*` pattern (`'dev*'`). Help text tells agents to quote
  patterns (zsh aborts or expands unquoted globs).
- Multi-machine deploy runs machines one after another, continues past a failed machine, prints a
  per-machine summary, exits 2 if any failed.
- `--stack <inst>` limits the deploy to one instance (machine-level parts still reconcile).
- `--prune`: instances present on the box (from `/etc/airstack/machine.yaml`) but gone from the
  machine file are reported on every deploy; `--prune` removes them (`compose down`, their cron files,
  manifest). Their install dirs are kept. Replaces `stack-cli stacks deactivate`.
- `--install` is required for first-time setup (today's `vps-setup` steps, unchanged scripts) and
  writes `/etc/airstack/machine.yaml`. A normal deploy to a machine with no marker fails with
  `-> airstack deploy <m> --install`. Binary install on the node is phase 4.
- Removed from stack-cli: `env` (→ `fleet config`), `stacks` (→ `status` / `--prune`),
  top-level plugin commands (→ `fleet plugin`), `vps-setup` (→ `deploy --install --step`).

## 8. Code changes (file by file)

| Area | Today | Phase 1 |
|---|---|---|
| `cli/index.ts` | spawns per-command scripts, `--stack` dir switch | one dispatcher with a verb registry (`requires`, `needsFleet`), mode resolution first |
| new `cli/lib/mode.ts` | — | `/etc/airstack` + `~/.config/airstack` resolution, perms check, narrow-only rule |
| new `cli/lib/fleet.ts` | — | `airstack.yaml`, machine discovery (both forms), name checks, target selection |
| `cli/lib/config.ts` | one `stack.yml` + `.env` | `loadMachine(fleet, name)` → `MachineConfig` + `StackInstance[]`; post-parse `${VAR}` from secrets JSONC; strict missing-var errors |
| new `cli/lib/merge.ts` | `defaults.ts` deepMerge (`<<+`) | layered merge with `null` delete + origin map; `<<+` kept |
| `cli/lib/plugin-loader.ts` | built-in first, then project, by bare name | `airstack/` → core, bare → fleet only; scope check; per-instance plugin config |
| `cli/types.ts` | `Config` = one stack | `MachineConfig`, `StackInstance { name, ref, user, installDir, values, templates, plugins, deploy, composeProject }`; `Plugin.scope` |
| `cli/deploy/*` | one ctx, one installDir, one compose | `MachineDeployContext` (machine plugins, machine compose) + per-instance `StackDeployContext` views sharing errors/report; stage writes `.airstack/deploy/<m>/machine/` and `…/stacks/<inst>/`; sync/ownership/start per instance with its user; manifests per instance |
| hooks | `hook(ctx, config)` | same signature; for stack-scope plugins `ctx.instance` is set and the hook runs once per instance |
| `cli/lib/stage.ts` | `.deploy` name check | `.airstack/deploy/<machine>` check (inside fleet root, under gitignored `.airstack/`) |
| `cli/lib/git-safety.ts` | checks `.deploy`, report, logs | checks `.airstack/` is gitignored; secrets JSONC never tracked |
| `cli/lib/config-writer.ts` | writes `stack.yml`/`.env` | writes machine file or secrets JSONC (comment-preserving via `jsonc-parser`) |
| `cli/plugins/*` | names `cron`, `cloudflare`, … | built-ins addressed as `airstack/<name>`, `scope` added, cron instance-prefixing |
| `cli/vps-setup.ts` | top-level command | backend of `deploy --install --step`; reads machine file |
| new `stacks/cliproxy/` (core) | proxy is a plugin in stack.yml | built-in stack wrapping `airstack/cliproxyapi` |
| new `cli/lib/output.ts` | `Logger` with colors | one formatter (`ok`/`warn`/`fail`/`->`), colors only on a TTY, deploy logs still to `.airstack/logs/` |
| `bin/airstack.sh` | `bin/stack-cli.sh` | same launcher, renamed (install.sh + compiled binary are phase 4) |

Fleet plugins may use only `import type` from airstack and get helpers through `ctx`. Reason: in
phase 4 airstack becomes a `bun build --compile` binary, and a runtime import of core modules from a
fleet file may not resolve. Verify this early (risk R1).

## 9. Tests

- Fixtures: `test/fixtures/fleet-basic/` (two machines, both machine forms, `_fleet.jsonc`, a stack
  used twice, a dev-user stack, a fleet plugin overriding nothing built-in).
- Unit: mode resolution matrix (no marker / node / node+controller / bad perms / user config trying to
  widen / env trying to widen / fleet clone in cwd on a node), fleet discovery (no walk), machine
  name/key mismatch, duplicate definition, reference resolution incl. "did you mean", merge rules
  (deep map, list replace, `null`, origin map), `${VAR}` after parse incl. a value with `: #\n`,
  missing secrets list, scope violations, `host_` crons in a stack, cron instance prefixing, port
  collisions, rootless + `airstack` network error, install dir defaults, target patterns.
- Existing stack-cli tests are ported, not dropped (≈ 25 files).
- Live: new test VPS. Acceptance list in section 11.

## 10. Risks and open items

- **R1 compiled binary + fleet plugins.** Confirm `bun build --compile` binaries can import fleet `.ts`
  plugins at runtime and what they can import. If not, fleet plugins become script + manifest only.
  Spike before the plugin-loader rewrite.
- **R2 migrating the existing production box** (not in phase 1). Splitting its single `my-vps` project into
  `airstack` (cloudflared) + `cliproxy` renames containers, so it recreates them: a short proxy and
  tunnel outage. `composeProject: my-vps` on the cliproxy instance avoids renaming the proxy. Needs
  the user's OK and its own checklist.
- **R3 host scripts** (`host_alerter`, `lib/stacks.sh`) assume one project per manifest. Confirm they
  iterate `/etc/stacks/*.env` correctly with several instances and a rootless daemon.
- **R4 `vps-setup` keeps reading `.env`-style values** today; it must read the machine file + secrets.
- **R5 (decided)** `deploy.hooks` stay, set per stack (`deploy.hooks` in stack.yaml).
- Open: `airstack.yaml` `fleet.name` default.

## 11. Acceptance (live, on the test VPS)

1. `airstack whoami` on the Mac in a fleet dir → controller, fleet path, verbs. In `/tmp` → controller,
   no fleet, deploy blocked with a hint.
2. `airstack fleet check` passes; breaking each rule in a scratch copy fails with one clear line.
3. `airstack deploy airstack-test1 --install` runs setup and writes `/etc/airstack/machine.yaml` (root 644).
4. `airstack deploy airstack-test1` brings up: `airstack` machine project (cloudflared), `cliproxy`
   (stackroot, root daemon), `devstack` + `teststack` (two instances of one fleet stack, deployuser,
   rootless). A second deploy recreates nothing (same container IDs).
5. Host crons (`host_alerter*`) installed once; stack crons appear as `devstack.backup` and
   `teststack.backup`.
6. `airstack deploy airstack-test1 --stack devstack` touches only devstack (+ machine reconcile).
7. Removing `teststack` from the machine file → deploy reports it; `--prune` stops it and removes its
   crons/manifest; its dir stays.
8. Copy the airstack binary/launcher to the VPS by hand, put a fleet clone in cwd, run
   `airstack deploy airstack-test1` → blocked (node-only).
9. `airstack deploy 'airstack-*'` and `--all` deploy each machine and print a summary.
10. Leak scan (section 2) clean; `.airstack/` gitignored check refuses a fleet without it.
