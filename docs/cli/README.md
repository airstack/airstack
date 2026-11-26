# airstack CLI reference

airstack manages a fleet of VPS machines from one fleet repo. A **fleet repo** is a git repo with
an `airstack.yaml` file, machine files, stacks and secrets. One `airstack` binary runs in two
modes: **controller** and **node**.

## Verbs

### Controller verbs

These verbs run on your own computer (the controller).

| Verb | What it does | Page |
|---|---|---|
| `init [<dir>]` | Creates a new fleet repo skeleton. Needs no fleet. | [init.md](init.md) |
| `fleet list \| show \| config \| check \| plugin \| update \| install` | Reads and checks the fleet repo. Runs plugin commands. Puts an airstack version on machines. | [fleet.md](fleet.md) |
| `deploy <machines>` | Deploys machines. `--install` sets up a fresh box. | [deploy.md](deploy.md) |
| `pull <machine>` | Copies the live config of a machine to the fleet repo and shows the differences. | [pull.md](pull.md) |
| `status [<machines>]` | Shows the containers of each stack instance on each machine. | [status-ssh.md](status-ssh.md) |
| `ssh <machine> [-- <command>]` | Opens SSH to a machine, or runs one command there. | [status-ssh.md](status-ssh.md) |

### Node verbs

These verbs run on a managed machine (a node) only.

| Verb | What it does | Page |
|---|---|---|
| `machine <command>` | Status, checks, report, logs, config history and repair of this node. | [machine.md](machine.md) |

### Any-mode verbs

These verbs run in both modes.

| Verb | What it does | Page |
|---|---|---|
| `whoami` | Shows the mode, machine, fleet, user, version and the verbs that are on. | [whoami.md](whoami.md) |
| `version` | Prints the airstack version. | [whoami.md](whoami.md) |
| `help` | Prints the verb list. | [whoami.md](whoami.md) |
| `doctor [--fix]` | Checks this machine. On a controller, it can also check nodes. | [doctor.md](doctor.md) |
| `versions` | Lists the airstack versions installed on this machine. | [versions.md](versions.md) |
| `update` | Installs the newest airstack release on this machine. | [versions.md](versions.md) |
| `install <version>` | Installs one airstack release on this machine. | [versions.md](versions.md) |

**Rule:** a bare verb acts on this machine only. A verb that touches another machine is under
`fleet`, `deploy`, `pull`, `status` or `ssh`. To run a node verb on a remote machine, use SSH:

```sh
airstack ssh web-1 -- airstack machine status
```

## Usage

```
airstack [--fleet <path>] <verb> [args]
```

`airstack` with no verb prints the help. `--help` and `-h` also print the help. `--version` and
`-v` print the version.

## Global option: `--fleet`

`--fleet <path>` tells airstack where the fleet repo is. You can put it before or after the verb.
`--fleet=<path>` also works. Everything after `--` belongs to the verb (for example to `ssh`).

On a controller, airstack finds the fleet in this order:

1. `--fleet <path>`.
2. `./airstack.yaml` in the current directory.
3. `fleet:` in `~/.config/airstack/config.yaml`.

airstack never looks in a parent directory. If no fleet is found, verbs that need a fleet stop
with exit code 3:

```
fail blocked: fleet needs a fleet (no fleet: run in a dir with airstack.yaml, or pass --fleet <path>)
->   airstack --fleet <path> fleet …
```

On a node, `--fleet` is refused (exit 3). A node ignores `./airstack.yaml` too.

## Output contract

airstack writes concise text for people and for agents (scripts and AI tools). Each line starts
with a stable prefix:

| Prefix | Meaning |
|---|---|
| `ok` | Something checked out or worked. |
| `warn` | Needs attention. Not fatal. |
| `fail` | Broken. |
| `->` | The next command to run. |
| (none) | Plain information or data. |

Colors appear only on a terminal. Set `NO_COLOR=1` to turn them off.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | OK. |
| 1 | Warnings (at least one `warn` line). |
| 2 | Failures (at least one `fail` line). |
| 3 | Usage error, or the verb is blocked. |

`airstack ssh` is the exception: it returns the exit code of `ssh` or of the remote command.

A blocked verb prints one line. The line names the file and the key that blocked it:

```
fail blocked: deploy needs controller role (/etc/airstack/machine.yaml roles: [node])
```

## Modes

The mode decides which verbs can run.

| Mode | When | Verbs |
|---|---|---|
| **controller** | `/etc/airstack/machine.yaml` does not exist. | Controller verbs and any-mode verbs. |
| **node** | `/etc/airstack/machine.yaml` exists. | Node verbs and any-mode verbs. |

`airstack deploy <machine> --install` writes `/etc/airstack/machine.yaml` (the **marker**) on the
machine. Every deploy writes it again.

The marker must be owned by root and must not be group- or world-writable. Its directory
(`/etc/airstack`) has the same rule. If the marker breaks this rule, airstack refuses every
mutating verb (a verb that changes files or machines).

The marker has `roles:`. `roles: [node]` allows node verbs only. `roles: [node, controller]`
also allows controller verbs on that node. Then the fleet is only the path in
`controller.fleet` of the marker.

Deploy rewrites the marker on every run, but it keeps the keys you set by hand: `roles`,
`controller` and `update`.

### Turning verbs off

You can turn verbs off. You cannot turn verbs on this way.

- `disable: [deploy, ssh]` in `~/.config/airstack/config.yaml`.
- `AIRSTACK_DISABLE=deploy,ssh` in the environment.

Only root-owned config (the marker) can widen what airstack may do.

### The mode guard is not a security boundary

The mode guard prevents accidents. It does **not** protect anything. Anyone can copy the binary
and remove a check. The real limits are:

- Unix file permissions.
- The root-only config history (`<root>/.stack`, mode 700).
- sudoers rules (`/etc/sudoers.d/airstack`).

## Pages

- [whoami.md](whoami.md): `whoami`, `version`, `help`
- [init.md](init.md): `init`
- [fleet.md](fleet.md): `fleet list | show | config | check | plugin | update | install`
- [deploy.md](deploy.md): `deploy`
- [pull.md](pull.md): `pull`
- [status-ssh.md](status-ssh.md): `status`, `ssh`
- [machine.md](machine.md): `machine …`
- [doctor.md](doctor.md): `doctor`
- [versions.md](versions.md): `versions`, `update`, `install`

See also: [../LAYOUT.md](../LAYOUT.md) (users and paths on a machine) and the example fleet in
[../../examples/fleet/](../../examples/fleet/).
